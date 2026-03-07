import "./polyfills";
import { unzipSync } from "fflate";
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

interface AnkiCol {
  decks: Record<string, { name: string }>;
  models: Record<
    string,
    { name: string; flds: Array<{ name: string }> }
  >;
}

const FIELD_SEPARATOR = "\x1f";

/**
 * Parse an .apkg file (ArrayBuffer) and return decks, notes, cards, and review history.
 */
export async function parseApkg(
  data: ArrayBuffer
): Promise<ParseResult> {
  const files = unzipSync(new Uint8Array(data));

  const dbFile =
    files["collection.anki21"] ?? files["collection.anki2"];
  if (!dbFile) {
    throw new Error(
      "No collection.anki21 or collection.anki2 found in .apkg"
    );
  }

  const SQL = await initSqlJs();
  const db = new SQL.Database(dbFile);

  try {
    const decks = extractDecks(db);
    const reviews = extractReviews(db);
    return { decks, reviews };
  } finally {
    db.close();
  }
}

function extractDecks(db: Database): ParsedDeck[] {
  const colRows = db.exec(
    "SELECT decks, models FROM col LIMIT 1"
  );
  if (colRows.length === 0 || colRows[0].values.length === 0) {
    throw new Error("No collection metadata found");
  }

  const decksJson = colRows[0].values[0][0] as string;
  const modelsJson = colRows[0].values[0][1] as string;

  const col: AnkiCol = {
    decks: JSON.parse(decksJson),
    models: JSON.parse(modelsJson),
  };

  const modelMap = new Map<
    string,
    { name: string; fieldNames: string[] }
  >();
  for (const [mid, model] of Object.entries(col.models)) {
    modelMap.set(mid, {
      name: model.name,
      fieldNames: model.flds.map((f) => f.name),
    });
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
    }
  }

  const decks: ParsedDeck[] = [];
  for (const [deckId, deckInfo] of Object.entries(col.decks)) {
    const cards = cardsByDeck.get(deckId) ?? [];
    const noteIds = new Set(cards.map((c) => c.noteId));
    const notes = [...noteIds]
      .map((nid) => notesById.get(nid))
      .filter((n): n is ParsedNote => n !== undefined);

    decks.push({
      id: deckId,
      name: deckInfo.name,
      notes,
      cards,
    });
  }

  return decks;
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
