import { unzipSync } from "fflate";
import initSqlJs, { type Database } from "sql.js";

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
 * Parse an .apkg file (ArrayBuffer) and return all decks, notes, and cards.
 */
export async function parseApkg(
  data: ArrayBuffer
): Promise<ParsedDeck[]> {
  // Unzip the .apkg
  const files = unzipSync(new Uint8Array(data));

  // Find the collection database (anki21 or anki2)
  const dbFile =
    files["collection.anki21"] ?? files["collection.anki2"];
  if (!dbFile) {
    throw new Error(
      "No collection.anki21 or collection.anki2 found in .apkg"
    );
  }

  // Initialize sql.js with WASM
  const SQL = await initSqlJs();
  const db = new SQL.Database(dbFile);

  try {
    return extractDecks(db);
  } finally {
    db.close();
  }
}

function extractDecks(db: Database): ParsedDeck[] {
  // Get collection metadata (decks and models)
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

  // Build model map: model_id -> { name, fieldNames }
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

  // Extract all notes
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

  // Extract all cards
  const cardRows = db.exec("SELECT id, nid, did, ord FROM cards");
  const cardsByDeck = new Map<string, ParsedCard[]>();
  if (cardRows.length > 0) {
    for (const row of cardRows[0].values) {
      const card: ParsedCard = {
        id: row[0] as number,
        noteId: row[1] as number,
        deckId: String(row[2]),
        ord: row[3] as number,
      };
      const existing = cardsByDeck.get(card.deckId) ?? [];
      existing.push(card);
      cardsByDeck.set(card.deckId, existing);
    }
  }

  // Build deck objects
  const decks: ParsedDeck[] = [];
  for (const [deckId, deckInfo] of Object.entries(col.decks)) {
    const cards = cardsByDeck.get(deckId) ?? [];
    // Gather unique notes referenced by this deck's cards
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
