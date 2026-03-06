import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import { handleUpload } from "./upload";
import type { Env } from "./types";

function buildMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: "ankimcp",
    version: "0.1.0",
  });

  // Tool: list_decks
  server.tool(
    "list_decks",
    "List all Anki decks with their card counts",
    {},
    async () => {
      const result = await env.DB.prepare(
        "SELECT id, name, card_count, uploaded_at FROM decks ORDER BY name"
      ).all();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.results, null, 2),
          },
        ],
      };
    }
  );

  // Tool: get_cards
  server.tool(
    "get_cards",
    "Get cards from a deck with their front/back content",
    {
      deck_name: z.string().describe("Name of the deck (or partial match)"),
      offset: z.number().default(0).describe("Number of cards to skip"),
      limit: z.number().default(50).describe("Maximum cards to return"),
    },
    async ({ deck_name, offset, limit }) => {
      const result = await env.DB.prepare(
        `SELECT c.id as card_id, c.ord, n.fields, n.field_names, n.tags, n.model_name, d.name as deck_name
         FROM cards c
         JOIN notes n ON c.note_id = n.id
         JOIN decks d ON c.deck_id = d.id
         WHERE d.name LIKE ?
         ORDER BY c.id
         LIMIT ? OFFSET ?`
      )
        .bind(`%${deck_name}%`, limit, offset)
        .all();

      const cards = result.results.map((row) => {
        const fields = JSON.parse(row.fields as string) as string[];
        const fieldNames = JSON.parse(row.field_names as string) as string[];
        const fieldMap: Record<string, string> = {};
        for (let i = 0; i < fieldNames.length; i++) {
          fieldMap[fieldNames[i]] = fields[i] ?? "";
        }
        return {
          card_id: row.card_id,
          deck: row.deck_name,
          model: row.model_name,
          ord: row.ord,
          tags: row.tags,
          fields: fieldMap,
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(cards, null, 2),
          },
        ],
      };
    }
  );

  // Tool: search_cards
  server.tool(
    "search_cards",
    "Search for cards by text content across all fields",
    {
      query: z.string().describe("Text to search for in card fields"),
      deck_name: z
        .string()
        .optional()
        .describe("Optional: limit search to a specific deck"),
      limit: z.number().default(20).describe("Maximum results to return"),
    },
    async ({ query, deck_name, limit }) => {
      let sql = `
        SELECT c.id as card_id, n.fields, n.field_names, n.tags, n.model_name, d.name as deck_name
        FROM cards c
        JOIN notes n ON c.note_id = n.id
        JOIN decks d ON c.deck_id = d.id
        WHERE n.fields LIKE ?`;
      const params: (string | number)[] = [`%${query}%`];

      if (deck_name) {
        sql += " AND d.name LIKE ?";
        params.push(`%${deck_name}%`);
      }
      sql += " ORDER BY c.id LIMIT ?";
      params.push(limit);

      const stmt = env.DB.prepare(sql);
      const result = await stmt.bind(...params).all();

      const cards = result.results.map((row) => {
        const fields = JSON.parse(row.fields as string) as string[];
        const fieldNames = JSON.parse(row.field_names as string) as string[];
        const fieldMap: Record<string, string> = {};
        for (let i = 0; i < fieldNames.length; i++) {
          fieldMap[fieldNames[i]] = fields[i] ?? "";
        }
        return {
          card_id: row.card_id,
          deck: row.deck_name,
          model: row.model_name,
          tags: row.tags,
          fields: fieldMap,
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(cards, null, 2),
          },
        ],
      };
    }
  );

  // Tool: get_card_details
  server.tool(
    "get_card_details",
    "Get full details of a specific card by ID",
    {
      card_id: z.number().describe("The card ID"),
    },
    async ({ card_id }) => {
      const result = await env.DB.prepare(
        `SELECT c.id as card_id, c.ord, n.id as note_id, n.fields, n.field_names, n.tags, n.model_name, d.name as deck_name
         FROM cards c
         JOIN notes n ON c.note_id = n.id
         JOIN decks d ON c.deck_id = d.id
         WHERE c.id = ?`
      )
        .bind(card_id)
        .all();

      if (result.results.length === 0) {
        return {
          content: [
            { type: "text" as const, text: `Card ${card_id} not found` },
          ],
        };
      }

      const row = result.results[0];
      const fields = JSON.parse(row.fields as string) as string[];
      const fieldNames = JSON.parse(row.field_names as string) as string[];
      const fieldMap: Record<string, string> = {};
      for (let i = 0; i < fieldNames.length; i++) {
        fieldMap[fieldNames[i]] = fields[i] ?? "";
      }

      const card = {
        card_id: row.card_id,
        note_id: row.note_id,
        deck: row.deck_name,
        model: row.model_name,
        ord: row.ord,
        tags: row.tags,
        fields: fieldMap,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(card, null, 2),
          },
        ],
      };
    }
  );

  return server;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Upload endpoint
    if (url.pathname === "/upload" && request.method === "POST") {
      return handleUpload(request, env);
    }

    // MCP endpoint — handle all /mcp requests
    if (url.pathname.startsWith("/mcp")) {
      const server = buildMcpServer(env);
      const handler = createMcpHandler(server);
      return handler(request, env, ctx);
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", service: "ankimcp" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not Found", { status: 404 });
  },
};
