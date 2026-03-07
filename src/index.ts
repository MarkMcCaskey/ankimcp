import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import { handleUpload } from "./upload";
import { handleSync } from "./sync";
import { handleAnkiSync } from "./anki-sync";
import type { Env } from "./types";

function parseFieldMap(fieldsJson: string, fieldNamesJson: string): Record<string, string> {
  const fields = JSON.parse(fieldsJson) as string[];
  const fieldNames = JSON.parse(fieldNamesJson) as string[];
  const fieldMap: Record<string, string> = {};
  for (let i = 0; i < fieldNames.length; i++) {
    fieldMap[fieldNames[i]] = fields[i] ?? "";
  }
  return fieldMap;
}

const CARD_TYPE_LABELS: Record<number, string> = { 0: "new", 1: "learning", 2: "review", 3: "relearning" };
const EASE_LABELS: Record<number, string> = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };

function buildMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: "ankimcp",
    version: "0.2.0",
  });

  // ─── list_decks ───
  server.tool(
    "list_decks",
    "List all Anki decks with card counts and study statistics (new/learning/review/total, average ease factor, total lapses)",
    {},
    async () => {
      const result = await env.DB.prepare(
        `SELECT d.id, d.name, d.card_count, d.uploaded_at,
                SUM(CASE WHEN c.type = 0 THEN 1 ELSE 0 END) as new_count,
                SUM(CASE WHEN c.type = 1 THEN 1 ELSE 0 END) as learning_count,
                SUM(CASE WHEN c.type = 2 THEN 1 ELSE 0 END) as review_count,
                SUM(CASE WHEN c.type = 3 THEN 1 ELSE 0 END) as relearning_count,
                AVG(CASE WHEN c.factor > 0 THEN c.factor ELSE NULL END) as avg_ease,
                SUM(c.lapses) as total_lapses,
                SUM(c.reps) as total_reps
         FROM decks d
         LEFT JOIN cards c ON c.deck_id = d.id
         GROUP BY d.id
         ORDER BY d.name`
      ).all();

      const decks = result.results.map((r) => ({
        id: r.id,
        name: r.name,
        card_count: r.card_count,
        uploaded_at: r.uploaded_at,
        new_count: r.new_count ?? 0,
        learning_count: r.learning_count ?? 0,
        review_count: r.review_count ?? 0,
        relearning_count: r.relearning_count ?? 0,
        avg_ease_factor: r.avg_ease ? Number((Number(r.avg_ease) / 1000).toFixed(2)) : null,
        total_lapses: r.total_lapses ?? 0,
        total_reviews: r.total_reps ?? 0,
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(decks, null, 2) }],
      };
    }
  );

  // ─── get_cards ───
  server.tool(
    "get_cards",
    `Get cards from a deck with content and scheduling data. Supports sorting by: id, due, interval, ease, reps, lapses, random. Supports filtering by card state.`,
    {
      deck_name: z.string().optional().describe("Deck name (partial match). Omit for all decks."),
      tag: z.string().optional().describe("Filter by tag (partial match)"),
      card_state: z.enum(["all", "new", "learning", "review", "relearning"]).default("all").describe("Filter by card state"),
      sort_by: z.enum(["id", "due", "interval", "ease", "reps", "lapses", "random"]).default("id").describe("Sort field"),
      sort_order: z.enum(["asc", "desc"]).default("asc").describe("Sort direction"),
      offset: z.number().default(0).describe("Number of cards to skip"),
      limit: z.number().default(50).describe("Maximum cards to return (max 200)"),
    },
    async ({ deck_name, tag, card_state, sort_by, sort_order, offset, limit }) => {
      limit = Math.min(limit, 200);

      let sql = `SELECT c.id as card_id, c.ord, c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses, c.flags,
                        n.fields, n.field_names, n.tags, n.model_name, d.name as deck_name
                 FROM cards c
                 JOIN notes n ON c.note_id = n.id
                 JOIN decks d ON c.deck_id = d.id
                 WHERE 1=1`;
      const params: (string | number)[] = [];

      if (deck_name) {
        sql += " AND d.name LIKE ?";
        params.push(`%${deck_name}%`);
      }
      if (tag) {
        sql += " AND n.tags LIKE ?";
        params.push(`%${tag}%`);
      }
      if (card_state !== "all") {
        const stateMap: Record<string, number> = { new: 0, learning: 1, review: 2, relearning: 3 };
        sql += " AND c.type = ?";
        params.push(stateMap[card_state]);
      }

      const sortMap: Record<string, string> = {
        id: "c.id", due: "c.due", interval: "c.ivl", ease: "c.factor",
        reps: "c.reps", lapses: "c.lapses", random: "RANDOM()",
      };
      sql += ` ORDER BY ${sortMap[sort_by]} ${sort_order} LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const result = await env.DB.prepare(sql).bind(...params).all();

      const cards = result.results.map((row) => ({
        card_id: row.card_id,
        deck: row.deck_name,
        model: row.model_name,
        ord: row.ord,
        state: CARD_TYPE_LABELS[row.type as number] ?? "unknown",
        tags: row.tags,
        fields: parseFieldMap(row.fields as string, row.field_names as string),
        scheduling: {
          due: row.due,
          interval_days: row.ivl,
          ease_factor: (row.factor as number) > 0 ? Number(((row.factor as number) / 1000).toFixed(2)) : null,
          total_reviews: row.reps,
          total_lapses: row.lapses,
          flags: row.flags,
        },
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(cards, null, 2) }],
      };
    }
  );

  // ─── search_cards ───
  server.tool(
    "search_cards",
    "Search for cards by text content across all fields. Returns card content and study data.",
    {
      query: z.string().describe("Text to search for in card fields"),
      deck_name: z.string().optional().describe("Limit search to a specific deck"),
      limit: z.number().default(20).describe("Maximum results (max 100)"),
    },
    async ({ query, deck_name, limit }) => {
      limit = Math.min(limit, 100);
      let sql = `SELECT c.id as card_id, c.type, c.ivl, c.factor, c.reps, c.lapses,
                        n.fields, n.field_names, n.tags, n.model_name, d.name as deck_name
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

      const result = await env.DB.prepare(sql).bind(...params).all();

      const cards = result.results.map((row) => ({
        card_id: row.card_id,
        deck: row.deck_name,
        model: row.model_name,
        state: CARD_TYPE_LABELS[row.type as number] ?? "unknown",
        tags: row.tags,
        fields: parseFieldMap(row.fields as string, row.field_names as string),
        interval_days: row.ivl,
        ease_factor: (row.factor as number) > 0 ? Number(((row.factor as number) / 1000).toFixed(2)) : null,
        total_reviews: row.reps,
        total_lapses: row.lapses,
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(cards, null, 2) }],
      };
    }
  );

  // ─── get_card_details ───
  server.tool(
    "get_card_details",
    "Get full details of a specific card including its complete review history. Shows every review event with timestamp, button pressed, and interval changes.",
    {
      card_id: z.number().describe("The card ID"),
    },
    async ({ card_id }) => {
      const cardResult = await env.DB.prepare(
        `SELECT c.id as card_id, c.ord, c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses, c.flags,
                n.id as note_id, n.fields, n.field_names, n.tags, n.model_name, d.name as deck_name
         FROM cards c
         JOIN notes n ON c.note_id = n.id
         JOIN decks d ON c.deck_id = d.id
         WHERE c.id = ?`
      ).bind(card_id).all();

      if (cardResult.results.length === 0) {
        return { content: [{ type: "text" as const, text: `Card ${card_id} not found` }] };
      }

      const row = cardResult.results[0];

      // Get review history
      const revResult = await env.DB.prepare(
        `SELECT id, ease, ivl, last_ivl, factor, review_time, type
         FROM revlog WHERE card_id = ? ORDER BY id ASC`
      ).bind(card_id).all();

      const reviews = revResult.results.map((r) => ({
        timestamp: new Date(r.id as number).toISOString(),
        button: EASE_LABELS[r.ease as number] ?? `unknown(${r.ease})`,
        new_interval: (r.ivl as number) >= 0 ? `${r.ivl}d` : `${Math.abs(r.ivl as number)}s`,
        previous_interval: (r.last_ivl as number) >= 0 ? `${r.last_ivl}d` : `${Math.abs(r.last_ivl as number)}s`,
        ease_factor: (r.factor as number) > 0 ? Number(((r.factor as number) / 1000).toFixed(2)) : null,
        review_duration_ms: r.review_time,
        review_type: (["learn", "review", "relearn", "filtered", "manual"] as const)[r.type as number] ?? "unknown",
      }));

      const card = {
        card_id: row.card_id,
        note_id: row.note_id,
        deck: row.deck_name,
        model: row.model_name,
        ord: row.ord,
        state: CARD_TYPE_LABELS[row.type as number] ?? "unknown",
        tags: row.tags,
        fields: parseFieldMap(row.fields as string, row.field_names as string),
        scheduling: {
          due: row.due,
          interval_days: row.ivl,
          ease_factor: (row.factor as number) > 0 ? Number(((row.factor as number) / 1000).toFixed(2)) : null,
          total_reviews: row.reps,
          total_lapses: row.lapses,
          flags: row.flags,
        },
        review_history: reviews,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(card, null, 2) }],
      };
    }
  );

  // ─── get_difficult_cards ───
  server.tool(
    "get_difficult_cards",
    `Find cards you struggle with most. Ranks by: lapses (times forgotten), low_ease (lowest ease factor), recent_failures (most 'Again' presses in recent reviews). Great for identifying weak spots.`,
    {
      deck_name: z.string().optional().describe("Limit to a specific deck"),
      rank_by: z.enum(["lapses", "low_ease", "recent_failures"]).default("lapses").describe("How to rank difficulty"),
      limit: z.number().default(20).describe("Maximum results (max 100)"),
    },
    async ({ deck_name, rank_by, limit }) => {
      limit = Math.min(limit, 100);
      let sql: string;
      const params: (string | number)[] = [];

      if (rank_by === "recent_failures") {
        // Count 'Again' presses (ease=1) in recent reviews
        sql = `SELECT c.id as card_id, c.type, c.ivl, c.factor, c.reps, c.lapses,
                      n.fields, n.field_names, n.tags, n.model_name, d.name as deck_name,
                      COUNT(r.id) as again_count
               FROM cards c
               JOIN notes n ON c.note_id = n.id
               JOIN decks d ON c.deck_id = d.id
               LEFT JOIN revlog r ON r.card_id = c.id AND r.ease = 1
               WHERE c.reps > 0`;
        if (deck_name) {
          sql += " AND d.name LIKE ?";
          params.push(`%${deck_name}%`);
        }
        sql += " GROUP BY c.id HAVING again_count > 0 ORDER BY again_count DESC LIMIT ?";
        params.push(limit);
      } else if (rank_by === "low_ease") {
        sql = `SELECT c.id as card_id, c.type, c.ivl, c.factor, c.reps, c.lapses,
                      n.fields, n.field_names, n.tags, n.model_name, d.name as deck_name
               FROM cards c
               JOIN notes n ON c.note_id = n.id
               JOIN decks d ON c.deck_id = d.id
               WHERE c.factor > 0`;
        if (deck_name) {
          sql += " AND d.name LIKE ?";
          params.push(`%${deck_name}%`);
        }
        sql += " ORDER BY c.factor ASC LIMIT ?";
        params.push(limit);
      } else {
        // lapses
        sql = `SELECT c.id as card_id, c.type, c.ivl, c.factor, c.reps, c.lapses,
                      n.fields, n.field_names, n.tags, n.model_name, d.name as deck_name
               FROM cards c
               JOIN notes n ON c.note_id = n.id
               JOIN decks d ON c.deck_id = d.id
               WHERE c.lapses > 0`;
        if (deck_name) {
          sql += " AND d.name LIKE ?";
          params.push(`%${deck_name}%`);
        }
        sql += " ORDER BY c.lapses DESC LIMIT ?";
        params.push(limit);
      }

      const result = await env.DB.prepare(sql).bind(...params).all();

      const cards = result.results.map((row) => ({
        card_id: row.card_id,
        deck: row.deck_name,
        model: row.model_name,
        state: CARD_TYPE_LABELS[row.type as number] ?? "unknown",
        tags: row.tags,
        fields: parseFieldMap(row.fields as string, row.field_names as string),
        lapses: row.lapses,
        total_reviews: row.reps,
        interval_days: row.ivl,
        ease_factor: (row.factor as number) > 0 ? Number(((row.factor as number) / 1000).toFixed(2)) : null,
        ...(rank_by === "recent_failures" ? { again_count: row.again_count } : {}),
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(cards, null, 2) }],
      };
    }
  );

  // ─── get_study_stats ───
  server.tool(
    "get_study_stats",
    "Get study statistics: total reviews, reviews per day, button distribution (Again/Hard/Good/Easy), average review time, streak data. Can be filtered by deck, tag, or time range.",
    {
      deck_name: z.string().optional().describe("Limit to a specific deck"),
      tag: z.string().optional().describe("Limit to cards with this tag"),
      days: z.number().default(30).describe("Number of days to look back (0 = all time)"),
    },
    async ({ deck_name, tag, days }) => {
      let whereClause = "WHERE 1=1";
      const params: (string | number)[] = [];

      if (days > 0) {
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        whereClause += " AND r.id >= ?";
        params.push(cutoff);
      }

      let joinClause = "FROM revlog r";
      if (deck_name || tag) {
        joinClause += " JOIN cards c ON r.card_id = c.id JOIN notes n ON c.note_id = n.id JOIN decks d ON c.deck_id = d.id";
        if (deck_name) {
          whereClause += " AND d.name LIKE ?";
          params.push(`%${deck_name}%`);
        }
        if (tag) {
          whereClause += " AND n.tags LIKE ?";
          params.push(`%${tag}%`);
        }
      }

      const statsResult = await env.DB.prepare(
        `SELECT
           COUNT(*) as total_reviews,
           SUM(CASE WHEN r.ease = 1 THEN 1 ELSE 0 END) as again_count,
           SUM(CASE WHEN r.ease = 2 THEN 1 ELSE 0 END) as hard_count,
           SUM(CASE WHEN r.ease = 3 THEN 1 ELSE 0 END) as good_count,
           SUM(CASE WHEN r.ease = 4 THEN 1 ELSE 0 END) as easy_count,
           AVG(r.review_time) as avg_review_time_ms,
           COUNT(DISTINCT date(r.id / 1000, 'unixepoch')) as days_studied,
           MIN(r.id) as first_review,
           MAX(r.id) as last_review
         ${joinClause} ${whereClause}`
      ).bind(...params).first();

      // Daily breakdown (last N days)
      const dailyParams = [...params];
      const dailyResult = await env.DB.prepare(
        `SELECT date(r.id / 1000, 'unixepoch') as day,
                COUNT(*) as reviews,
                SUM(CASE WHEN r.ease = 1 THEN 1 ELSE 0 END) as again,
                AVG(r.review_time) as avg_time_ms
         ${joinClause} ${whereClause}
         GROUP BY day ORDER BY day DESC LIMIT 30`
      ).bind(...dailyParams).all();

      const total = (statsResult?.total_reviews as number) ?? 0;
      const stats = {
        period: days > 0 ? `last ${days} days` : "all time",
        total_reviews: total,
        days_studied: statsResult?.days_studied ?? 0,
        reviews_per_day: total > 0 && statsResult?.days_studied
          ? Number((total / (statsResult.days_studied as number)).toFixed(1))
          : 0,
        button_distribution: {
          again: statsResult?.again_count ?? 0,
          hard: statsResult?.hard_count ?? 0,
          good: statsResult?.good_count ?? 0,
          easy: statsResult?.easy_count ?? 0,
          again_pct: total > 0 ? Number((((statsResult?.again_count as number) ?? 0) / total * 100).toFixed(1)) : 0,
        },
        avg_review_time_ms: statsResult?.avg_review_time_ms
          ? Number((statsResult.avg_review_time_ms as number).toFixed(0))
          : null,
        first_review: statsResult?.first_review ? new Date(statsResult.first_review as number).toISOString() : null,
        last_review: statsResult?.last_review ? new Date(statsResult.last_review as number).toISOString() : null,
        daily_breakdown: dailyResult.results.map((r) => ({
          date: r.day,
          reviews: r.reviews,
          again: r.again,
          avg_time_ms: r.avg_time_ms ? Number((r.avg_time_ms as number).toFixed(0)) : null,
        })),
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }],
      };
    }
  );

  // ─── get_review_history ───
  server.tool(
    "get_review_history",
    "Get raw review history for a card or set of cards. Each entry shows when a review happened, what button was pressed, and the interval change. Useful for understanding learning patterns over time.",
    {
      card_id: z.number().optional().describe("Get reviews for a specific card"),
      deck_name: z.string().optional().describe("Get reviews for all cards in a deck"),
      days: z.number().default(7).describe("Number of days to look back (0 = all time)"),
      limit: z.number().default(100).describe("Maximum review entries (max 500)"),
    },
    async ({ card_id, deck_name, days, limit }) => {
      limit = Math.min(limit, 500);
      let sql = `SELECT r.id, r.card_id, r.ease, r.ivl, r.last_ivl, r.factor, r.review_time, r.type,
                        n.fields, n.field_names, d.name as deck_name
                 FROM revlog r
                 JOIN cards c ON r.card_id = c.id
                 JOIN notes n ON c.note_id = n.id
                 JOIN decks d ON c.deck_id = d.id
                 WHERE 1=1`;
      const params: (string | number)[] = [];

      if (card_id) {
        sql += " AND r.card_id = ?";
        params.push(card_id);
      }
      if (deck_name) {
        sql += " AND d.name LIKE ?";
        params.push(`%${deck_name}%`);
      }
      if (days > 0) {
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        sql += " AND r.id >= ?";
        params.push(cutoff);
      }

      sql += " ORDER BY r.id DESC LIMIT ?";
      params.push(limit);

      const result = await env.DB.prepare(sql).bind(...params).all();

      const reviews = result.results.map((r) => {
        const fields = parseFieldMap(r.fields as string, r.field_names as string);
        const firstField = Object.values(fields)[0] ?? "";
        return {
          timestamp: new Date(r.id as number).toISOString(),
          card_id: r.card_id,
          card_preview: firstField.substring(0, 80),
          deck: r.deck_name,
          button: EASE_LABELS[r.ease as number] ?? `unknown(${r.ease})`,
          new_interval: (r.ivl as number) >= 0 ? `${r.ivl}d` : `${Math.abs(r.ivl as number)}s`,
          previous_interval: (r.last_ivl as number) >= 0 ? `${r.last_ivl}d` : `${Math.abs(r.last_ivl as number)}s`,
          review_duration_ms: r.review_time,
          review_type: (["learn", "review", "relearn", "filtered", "manual"] as const)[r.type as number] ?? "unknown",
        };
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(reviews, null, 2) }],
      };
    }
  );

  // ─── get_card_stats ───
  server.tool(
    "get_card_stats",
    "Get aggregate statistics for a specific card: success rate, average review time, ease trend, interval growth over time. Tells you how well you know this card.",
    {
      card_id: z.number().describe("The card ID"),
    },
    async ({ card_id }) => {
      // Card info
      const cardRow = await env.DB.prepare(
        `SELECT c.id, c.type, c.ivl, c.factor, c.reps, c.lapses,
                n.fields, n.field_names, n.tags, d.name as deck_name
         FROM cards c
         JOIN notes n ON c.note_id = n.id
         JOIN decks d ON c.deck_id = d.id
         WHERE c.id = ?`
      ).bind(card_id).first();

      if (!cardRow) {
        return { content: [{ type: "text" as const, text: `Card ${card_id} not found` }] };
      }

      // Review stats
      const revStats = await env.DB.prepare(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN ease = 1 THEN 1 ELSE 0 END) as again_count,
                SUM(CASE WHEN ease >= 3 THEN 1 ELSE 0 END) as success_count,
                AVG(review_time) as avg_time,
                MIN(id) as first_review,
                MAX(id) as last_review
         FROM revlog WHERE card_id = ?`
      ).bind(card_id).first();

      const total = (revStats?.total as number) ?? 0;
      const fields = parseFieldMap(cardRow.fields as string, cardRow.field_names as string);

      const stats = {
        card_id,
        deck: cardRow.deck_name,
        tags: cardRow.tags,
        fields,
        current_state: CARD_TYPE_LABELS[cardRow.type as number] ?? "unknown",
        current_interval_days: cardRow.ivl,
        current_ease_factor: (cardRow.factor as number) > 0 ? Number(((cardRow.factor as number) / 1000).toFixed(2)) : null,
        total_reviews: cardRow.reps,
        total_lapses: cardRow.lapses,
        success_rate: total > 0 ? Number((((revStats?.success_count as number) ?? 0) / total * 100).toFixed(1)) : null,
        again_rate: total > 0 ? Number((((revStats?.again_count as number) ?? 0) / total * 100).toFixed(1)) : null,
        avg_review_time_ms: revStats?.avg_time ? Number((revStats.avg_time as number).toFixed(0)) : null,
        first_reviewed: revStats?.first_review ? new Date(revStats.first_review as number).toISOString() : null,
        last_reviewed: revStats?.last_review ? new Date(revStats.last_review as number).toISOString() : null,
        maturity: cardRow.ivl === 0 ? "unseen"
          : (cardRow.ivl as number) < 21 ? "young"
          : (cardRow.ivl as number) < 90 ? "mature"
          : "well-known",
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }],
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

    if (url.pathname === "/upload" && request.method === "POST") {
      return handleUpload(request, env);
    }

    if (url.pathname === "/sync" && request.method === "POST") {
      return handleSync(request, env);
    }

    // Anki native sync protocol (AnkiMobile / Anki Desktop)
    if (url.pathname.startsWith("/sync/")) {
      return handleAnkiSync(request, env, url.pathname);
    }

    if (url.pathname.startsWith("/mcp")) {
      const server = buildMcpServer(env);
      const handler = createMcpHandler(server);
      return handler(request, env, ctx);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", service: "ankimcp" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not Found", { status: 404 });
  },
};
