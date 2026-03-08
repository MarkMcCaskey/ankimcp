import "./polyfills";
import { unzipSync } from "fflate";
import * as fzstd from "fzstd";
// Use asm.js build to avoid WASM loading issues in Workers
// @ts-expect-error -- no types for asm build
import initSqlJs from "sql.js/dist/sql-asm.js";
import type { Database } from "sql.js";

/** A parsed Anki deck with its notes and cards */
export interface ParsedDeck {
  id: string;
  name: string;
  notes: ParsedNote[];
  cards: ParsedCard[];
}

export interface ParsedNote {
  id: number;
  modelName: string;
  fields: string[];
  fieldNames: string[];
  tags: string;
}

export interface ParsedCard {
  id: number;
  noteId: number;
  deckId: string;
  ord: number;
  type: number;
  queue: number;
  due: number;
  ivl: number;
  factor: number;
  reps: number;
  lapses: number;
  flags: number;
}

export interface ParsedReview {
  id: number;
  cardId: number;
  ease: number;
  ivl: number;
  lastIvl: number;
  factor: number;
  reviewTime: number;
  type: number;
}

export interface ParseResult {
  decks: ParsedDeck[];
  reviews: ParsedReview[];
}

const FIELD_SEPARATOR = "\x1f";

/**
 * Parse an .apkg file (ArrayBuffer) and return decks, notes, cards, and review history.
 */
export async function parseApkg(
  data: ArrayBuffer
): Promise<ParseResult> {
  const files = unzipSync(new Uint8Array(data));

  // Try formats in order: anki21b (new, zstd-compressed), anki21, anki2 (legacy)
  const anki21b = files["collection.anki21b"];
  if (anki21b) {
    const decompressed = fzstd.decompress(anki21b) as Uint8Array;
    return parseAnkiSqlite(decompressed);
  }

  const dbFile = files["collection.anki21"] ?? files["collection.anki2"];
  if (!dbFile) {
    throw new Error(
      "No collection.anki21b, collection.anki21, or collection.anki2 found in .apkg"
    );
  }

  return parseAnkiSqlite(dbFile);
}

/**
 * Parse a raw Anki SQLite database (collection.anki2 / .anki21) and return decks, notes, cards, and review history.
 * Used by both .apkg upload (after ZIP extraction) and Anki sync protocol upload (raw SQLite).
 */
export async function parseAnkiSqlite(
  dbBytes: Uint8Array
): Promise<ParseResult> {
  const SQL = await initSqlJs();
  const db = new SQL.Database(dbBytes);

  try {
    const decks = extractDecks(db);
    const reviews = extractReviews(db);
    return { decks, reviews };
  } finally {
    db.close();
  }
}

function extractDecks(db: Database): ParsedDeck[] {
  // Build model map: try new schema tables first, fall back to col.models
  const modelMap = new Map<
    string,
    { name: string; fieldNames: string[] }
  >();

  const hasNotetypes = tableExists(db, "notetypes");
  const hasFieldsTable = tableExists(db, "fields");

  if (hasNotetypes && hasFieldsTable) {
    // New schema (anki21b / schema v18+): notetypes + fields tables
    const ntRows = db.exec("SELECT id, name FROM notetypes");
    if (ntRows.length > 0) {
      for (const row of ntRows[0].values) {
        modelMap.set(String(row[0]), { name: row[1] as string, fieldNames: [] });
      }
    }
    const fieldRows = db.exec("SELECT ntid, ord, name FROM fields ORDER BY ntid, ord");
    if (fieldRows.length > 0) {
      for (const row of fieldRows[0].values) {
        const model = modelMap.get(String(row[0]));
        if (model) {
          model.fieldNames.push(row[2] as string);
        }
      }
    }
  } else {
    // Legacy schema: col.models JSON
    const colRows = db.exec("SELECT models FROM col LIMIT 1");
    if (colRows.length > 0 && colRows[0].values.length > 0) {
      const modelsJson = colRows[0].values[0][0] as string;
      const models = JSON.parse(modelsJson) as Record<string, { name: string; flds: Array<{ name: string }> }>;
      for (const [mid, model] of Object.entries(models)) {
        modelMap.set(mid, {
          name: model.name,
          fieldNames: model.flds.map((f) => f.name),
        });
      }
    }
  }

  // Build deck name map: try new schema table first, fall back to col.decks
  const deckNameMap = new Map<string, string>();
  const hasDecksTable = tableExists(db, "decks") && hasNotetypes; // "decks" also exists in D1, so check notetypes to confirm new schema

  if (hasDecksTable) {
    const deckRows = db.exec("SELECT id, name FROM decks");
    if (deckRows.length > 0) {
      for (const row of deckRows[0].values) {
        deckNameMap.set(String(row[0]), row[1] as string);
      }
    }
  } else {
    const colRows = db.exec("SELECT decks FROM col LIMIT 1");
    if (colRows.length > 0 && colRows[0].values.length > 0) {
      const decksJson = colRows[0].values[0][0] as string;
      const colDecks = JSON.parse(decksJson) as Record<string, { name: string }>;
      for (const [deckId, deckInfo] of Object.entries(colDecks)) {
        deckNameMap.set(deckId, deckInfo.name);
      }
    }
  }

  // Extract notes
  const noteRows = db.exec(
    "SELECT id, mid, flds, tags FROM notes"
  );
  const notesById = new Map<number, ParsedNote>();
  if (noteRows.length > 0) {
    for (const row of noteRows[0].values) {
      const noteId = row[0] as number;
      const modelId = String(row[1]);
      const fieldsRaw = row[2] as string;
      const tags = (row[3] as string).trim();

      const model = modelMap.get(modelId);
      const fields = fieldsRaw.split(FIELD_SEPARATOR);

      notesById.set(noteId, {
        id: noteId,
        modelName: model?.name ?? "Unknown",
        fields,
        fieldNames: model?.fieldNames ?? fields.map((_, i) => `Field ${i + 1}`),
        tags,
      });
    }
  }

  // Extract cards with full scheduling data
  const cardRows = db.exec(
    "SELECT id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses, flags FROM cards"
  );
  const cardsByDeck = new Map<string, ParsedCard[]>();
  const allDeckIds = new Set<string>();
  if (cardRows.length > 0) {
    for (const row of cardRows[0].values) {
      const card: ParsedCard = {
        id: row[0] as number,
        noteId: row[1] as number,
        deckId: String(row[2]),
        ord: row[3] as number,
        type: row[4] as number,
        queue: row[5] as number,
        due: row[6] as number,
        ivl: row[7] as number,
        factor: row[8] as number,
        reps: row[9] as number,
        lapses: row[10] as number,
        flags: row[11] as number,
      };
      const existing = cardsByDeck.get(card.deckId) ?? [];
      existing.push(card);
      cardsByDeck.set(card.deckId, existing);
      allDeckIds.add(card.deckId);
    }
  }

  // Include all deck IDs from both the deck map and from cards
  for (const deckId of deckNameMap.keys()) {
    allDeckIds.add(deckId);
  }

  const decks: ParsedDeck[] = [];
  for (const deckId of allDeckIds) {
    const cards = cardsByDeck.get(deckId) ?? [];
    const noteIds = new Set(cards.map((c) => c.noteId));
    const notes = [...noteIds]
      .map((nid) => notesById.get(nid))
      .filter((n): n is ParsedNote => n !== undefined);

    decks.push({
      id: deckId,
      name: deckNameMap.get(deckId) ?? `Deck ${deckId}`,
      notes,
      cards,
    });
  }

  return decks;
}

function tableExists(db: Database, name: string): boolean {
  const result = db.exec(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`
  );
  return result.length > 0 && result[0].values.length > 0;
}

function extractReviews(db: Database): ParsedReview[] {
  const tableCheck = db.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='revlog'"
  );
  if (tableCheck.length === 0 || tableCheck[0].values.length === 0) {
    return [];
  }

  const rows = db.exec(
    "SELECT id, cid, ease, ivl, lastIvl, factor, time, type FROM revlog"
  );
  if (rows.length === 0) return [];

  return rows[0].values.map((row) => ({
    id: row[0] as number,
    cardId: row[1] as number,
    ease: row[2] as number,
    ivl: row[3] as number,
    lastIvl: row[4] as number,
    factor: row[5] as number,
    reviewTime: row[6] as number,
    type: row[7] as number,
  }));
}
