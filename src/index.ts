import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import { handleUpload } from "./upload";
import { handleSync } from "./sync";
import { handleAnkiSync } from "./anki-sync";
import { loadCollection } from "./anki-collection";
import type { AnkiDatabase } from "./anki-collection";
import type { Env } from "./types";

/**
 * Query revlog data from the R2 SQLite collection instead of D1.
 * This avoids storing revlog in D1 (saves ~60-80% of write volume).
 */
async function queryRevlog<T>(env: Env, fn: (db: AnkiDatabase) => T): Promise<T | null> {
  const db = await loadCollection(env);
  if (!db) return null;
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

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

      // Get review history from R2 SQLite (not stored in D1)
      const reviews = await queryRevlog(env, (db) => {
        const result = db.exec(`SELECT id, ease, ivl, lastIvl, factor, time, type FROM revlog WHERE cid = ${Number(card_id)} ORDER BY id ASC`);
        if (result.length === 0) return [];
        return result[0].values.map((r) => ({
          timestamp: new Date(r[0] as number).toISOString(),
          button: EASE_LABELS[r[1] as number] ?? `unknown(${r[1]})`,
          new_interval: (r[2] as number) >= 0 ? `${r[2]}d` : `${Math.abs(r[2] as number)}s`,
          previous_interval: (r[3] as number) >= 0 ? `${r[3]}d` : `${Math.abs(r[3] as number)}s`,
          ease_factor: (r[4] as number) > 0 ? Number(((r[4] as number) / 1000).toFixed(2)) : null,
          review_duration_ms: r[5],
          review_type: (["learn", "review", "relearn", "filtered", "manual"] as const)[r[6] as number] ?? "unknown",
        }));
      }) ?? [];

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

      if (rank_by === "recent_failures") {
        // Get again counts from R2 SQLite (revlog not in D1)
        const againCounts = await queryRevlog(env, (db) => {
          const result = db.exec(`SELECT cid, COUNT(*) as cnt FROM revlog WHERE ease = 1 GROUP BY cid HAVING cnt > 0 ORDER BY cnt DESC LIMIT ${Number(limit) * 2}`);
          if (result.length === 0) return [];
          return result[0].values.map((r) => ({ cid: r[0] as number, count: r[1] as number }));
        }) ?? [];

        if (againCounts.length === 0) {
          return { content: [{ type: "text" as const, text: "[]" }] };
        }

        // Fetch card details from D1 for these card IDs
        const cardIds = againCounts.map((a) => a.cid);
        const againMap = new Map(againCounts.map((a) => [a.cid, a.count]));
        const placeholders = cardIds.map(() => "?").join(",");
        let sql = `SELECT c.id as card_id, c.type, c.ivl, c.factor, c.reps, c.lapses,
                          n.fields, n.field_names, n.tags, n.model_name, d.name as deck_name
                   FROM cards c
                   JOIN notes n ON c.note_id = n.id
                   JOIN decks d ON c.deck_id = d.id
                   WHERE c.id IN (${placeholders})`;
        const params: (string | number)[] = [...cardIds];
        if (deck_name) {
          sql += " AND d.name LIKE ?";
          params.push(`%${deck_name}%`);
        }
        const result = await env.DB.prepare(sql).bind(...params).all();

        const cards = result.results
          .map((row) => ({
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
            again_count: againMap.get(row.card_id as number) ?? 0,
          }))
          .sort((a, b) => b.again_count - a.again_count)
          .slice(0, limit);

        return {
          content: [{ type: "text" as const, text: JSON.stringify(cards, null, 2) }],
        };
      }

      let sql: string;
      const params: (string | number)[] = [];

      if (rank_by === "low_ease") {
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
      // Query revlog from R2 SQLite (not stored in D1)
      const statsData = await queryRevlog(env, (db) => {
        let whereClause = "WHERE 1=1";
        if (days > 0) {
          const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
          whereClause += ` AND r.id >= ${cutoff}`;
        }

        let joinClause = "FROM revlog r";
        // In the R2 SQLite, revlog uses 'cid' for card_id, cards uses 'nid'/'did', notes uses 'mid'/'flds'/'tags'
        if (deck_name || tag) {
          joinClause += " JOIN cards c ON r.cid = c.id JOIN notes n ON c.nid = n.id";
          if (deck_name) {
            // Need to look up deck name from col.decks JSON — use did filtering
            // For simplicity, get all deck IDs matching the name from col table
            const colResult = db.exec("SELECT decks FROM col LIMIT 1");
            if (colResult.length > 0) {
              const decks = JSON.parse(colResult[0].values[0][0] as string) as Record<string, { name: string }>;
              const matchingDids = Object.entries(decks)
                .filter(([, d]) => d.name.toLowerCase().includes(deck_name!.toLowerCase()))
                .map(([id]) => id);
              if (matchingDids.length > 0) {
                whereClause += ` AND c.did IN (${matchingDids.join(",")})`;
              } else {
                whereClause += " AND 0"; // no matching decks
              }
            }
          }
          if (tag) {
            whereClause += ` AND n.tags LIKE '%${tag.replace(/'/g, "''")}%'`;
          }
        }

        const statsResult = db.exec(
          `SELECT
             COUNT(*) as total_reviews,
             SUM(CASE WHEN r.ease = 1 THEN 1 ELSE 0 END) as again_count,
             SUM(CASE WHEN r.ease = 2 THEN 1 ELSE 0 END) as hard_count,
             SUM(CASE WHEN r.ease = 3 THEN 1 ELSE 0 END) as good_count,
             SUM(CASE WHEN r.ease = 4 THEN 1 ELSE 0 END) as easy_count,
             AVG(r.time) as avg_review_time_ms,
             COUNT(DISTINCT date(r.id / 1000, 'unixepoch')) as days_studied,
             MIN(r.id) as first_review,
             MAX(r.id) as last_review
           ${joinClause} ${whereClause}`
        );

        const dailyResult = db.exec(
          `SELECT date(r.id / 1000, 'unixepoch') as day,
                  COUNT(*) as reviews,
                  SUM(CASE WHEN r.ease = 1 THEN 1 ELSE 0 END) as again,
                  AVG(r.time) as avg_time_ms
           ${joinClause} ${whereClause}
           GROUP BY day ORDER BY day DESC LIMIT 30`
        );

        const sr = statsResult.length > 0 ? statsResult[0].values[0] : null;
        const daily = dailyResult.length > 0 ? dailyResult[0].values : [];

        return { sr, daily };
      });

      const sr = statsData?.sr;
      const daily = statsData?.daily ?? [];
      const total = (sr?.[0] as number) ?? 0;
      const daysStudied = (sr?.[6] as number) ?? 0;

      const stats = {
        period: days > 0 ? `last ${days} days` : "all time",
        total_reviews: total,
        days_studied: daysStudied,
        reviews_per_day: total > 0 && daysStudied > 0 ? Number((total / daysStudied).toFixed(1)) : 0,
        button_distribution: {
          again: (sr?.[1] as number) ?? 0,
          hard: (sr?.[2] as number) ?? 0,
          good: (sr?.[3] as number) ?? 0,
          easy: (sr?.[4] as number) ?? 0,
          again_pct: total > 0 ? Number(((((sr?.[1] as number) ?? 0) / total) * 100).toFixed(1)) : 0,
        },
        avg_review_time_ms: sr?.[5] ? Number((sr[5] as number).toFixed(0)) : null,
        first_review: sr?.[7] ? new Date(sr[7] as number).toISOString() : null,
        last_review: sr?.[8] ? new Date(sr[8] as number).toISOString() : null,
        daily_breakdown: daily.map((r) => ({
          date: r[0],
          reviews: r[1],
          again: r[2],
          avg_time_ms: r[3] ? Number((r[3] as number).toFixed(0)) : null,
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

      // Query revlog from R2 SQLite, joining with notes for card preview
      const reviews = await queryRevlog(env, (db) => {
        let whereClause = "WHERE 1=1";
        let joinClause = "FROM revlog r JOIN cards c ON r.cid = c.id JOIN notes n ON c.nid = n.id";

        if (card_id) {
          whereClause += ` AND r.cid = ${Number(card_id)}`;
        }
        if (deck_name) {
          const colResult = db.exec("SELECT decks FROM col LIMIT 1");
          if (colResult.length > 0) {
            const decks = JSON.parse(colResult[0].values[0][0] as string) as Record<string, { name: string }>;
            const matchingDids = Object.entries(decks)
              .filter(([, d]) => d.name.toLowerCase().includes(deck_name!.toLowerCase()))
              .map(([id]) => id);
            if (matchingDids.length > 0) {
              whereClause += ` AND c.did IN (${matchingDids.join(",")})`;
            } else {
              whereClause += " AND 0";
            }
          }
        }
        if (days > 0) {
          const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
          whereClause += ` AND r.id >= ${cutoff}`;
        }

        // Get deck name mapping
        const colResult = db.exec("SELECT decks, models FROM col LIMIT 1");
        const deckMap = new Map<string, string>();
        const modelMap = new Map<string, string[]>();
        if (colResult.length > 0) {
          const decks = JSON.parse(colResult[0].values[0][0] as string) as Record<string, { name: string }>;
          for (const [id, d] of Object.entries(decks)) deckMap.set(id, d.name);
          const models = JSON.parse(colResult[0].values[0][1] as string) as Record<string, { flds: Array<{ name: string }> }>;
          for (const [id, m] of Object.entries(models)) modelMap.set(id, m.flds.map((f) => f.name));
        }

        const result = db.exec(
          `SELECT r.id, r.cid, r.ease, r.ivl, r.lastIvl, r.factor, r.time, r.type,
                  n.flds, n.mid, c.did
           ${joinClause} ${whereClause}
           ORDER BY r.id DESC LIMIT ${Number(limit)}`
        );

        if (result.length === 0) return [];
        return result[0].values.map((r) => {
          const fieldsRaw = r[8] as string;
          const modelId = String(r[9]);
          const deckId = String(r[10]);
          const fieldNames = modelMap.get(modelId) ?? [];
          const fields = fieldsRaw.split("\x1f");
          const fieldMap: Record<string, string> = {};
          for (let i = 0; i < fieldNames.length; i++) fieldMap[fieldNames[i]] = fields[i] ?? "";
          const firstField = fields[0] ?? "";

          return {
            timestamp: new Date(r[0] as number).toISOString(),
            card_id: r[1],
            card_preview: firstField.substring(0, 80),
            deck: deckMap.get(deckId) ?? "Unknown",
            button: EASE_LABELS[r[2] as number] ?? `unknown(${r[2]})`,
            new_interval: (r[3] as number) >= 0 ? `${r[3]}d` : `${Math.abs(r[3] as number)}s`,
            previous_interval: (r[4] as number) >= 0 ? `${r[4]}d` : `${Math.abs(r[4] as number)}s`,
            review_duration_ms: r[6],
            review_type: (["learn", "review", "relearn", "filtered", "manual"] as const)[r[7] as number] ?? "unknown",
          };
        });
      }) ?? [];

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

      // Review stats from R2 SQLite (revlog not in D1)
      const revStats = await queryRevlog(env, (db) => {
        const result = db.exec(
          `SELECT COUNT(*) as total,
                  SUM(CASE WHEN ease = 1 THEN 1 ELSE 0 END) as again_count,
                  SUM(CASE WHEN ease >= 3 THEN 1 ELSE 0 END) as success_count,
                  AVG(time) as avg_time,
                  MIN(id) as first_review,
                  MAX(id) as last_review
           FROM revlog WHERE cid = ${Number(card_id)}`
        );
        if (result.length === 0 || result[0].values.length === 0) return null;
        const r = result[0].values[0];
        return { total: r[0] as number, again_count: r[1] as number, success_count: r[2] as number, avg_time: r[3] as number | null, first_review: r[4] as number | null, last_review: r[5] as number | null };
      });

      const total = revStats?.total ?? 0;
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
        success_rate: total > 0 ? Number(((revStats?.success_count ?? 0) / total * 100).toFixed(1)) : null,
        again_rate: total > 0 ? Number(((revStats?.again_count ?? 0) / total * 100).toFixed(1)) : null,
        avg_review_time_ms: revStats?.avg_time ? Number(revStats.avg_time.toFixed(0)) : null,
        first_reviewed: revStats?.first_review ? new Date(revStats.first_review).toISOString() : null,
        last_reviewed: revStats?.last_review ? new Date(revStats.last_review).toISOString() : null,
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
