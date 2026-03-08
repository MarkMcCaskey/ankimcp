import { parseApkg } from "./apkg";
import type { Env } from "./types";

const BATCH_SIZE = 100;

/** Send prepared statements in batches to avoid Worker time limits */
async function batchInsert(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await db.batch(statements.slice(i, i + BATCH_SIZE));
  }
}

export async function handleUpload(
  request: Request,
  env: Env
): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (!token || token !== await env.AUTH_TOKEN.get()) {
    return new Response("Unauthorized", { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as unknown as File | null;
  if (!file || typeof file === "string") {
    return new Response("Missing 'file' field in form data", {
      status: 400,
    });
  }

  if (!file.name.endsWith(".apkg")) {
    return new Response("File must be an .apkg file", {
      status: 400,
    });
  }

  const arrayBuffer = await file.arrayBuffer();

  const r2Key = `uploads/${Date.now()}-${file.name}`;
  await env.BUCKET.put(r2Key, arrayBuffer);

  const { decks, reviews } = await parseApkg(arrayBuffer);

  // Clear existing data
  await env.DB.batch([
    env.DB.prepare("DELETE FROM revlog"),
    env.DB.prepare("DELETE FROM cards"),
    env.DB.prepare("DELETE FROM notes"),
    env.DB.prepare("DELETE FROM decks"),
  ]);

  // Batch insert decks
  const deckStmts = decks.map((deck) =>
    env.DB.prepare("INSERT INTO decks (id, name, card_count) VALUES (?, ?, ?)")
      .bind(deck.id, deck.name, deck.cards.length)
  );
  await batchInsert(env.DB, deckStmts);

  // Batch insert notes
  const noteStmts = decks.flatMap((deck) =>
    deck.notes.map((note) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO notes (id, deck_id, model_name, fields, field_names, tags) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(note.id, deck.id, note.modelName, JSON.stringify(note.fields), JSON.stringify(note.fieldNames), note.tags)
    )
  );
  await batchInsert(env.DB, noteStmts);

  // Batch insert cards
  const cardStmts = decks.flatMap((deck) =>
    deck.cards.map((card) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO cards (id, note_id, deck_id, ord, type, queue, due, ivl, factor, reps, lapses, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(card.id, card.noteId, card.deckId, card.ord, card.type, card.queue, card.due, card.ivl, card.factor, card.reps, card.lapses, card.flags)
    )
  );
  await batchInsert(env.DB, cardStmts);

  // Batch insert reviews
  const revStmts = reviews.map((rev) =>
    env.DB.prepare(
      "INSERT OR IGNORE INTO revlog (id, card_id, ease, ivl, last_ivl, factor, review_time, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(rev.id, rev.cardId, rev.ease, rev.ivl, rev.lastIvl, rev.factor, rev.reviewTime, rev.type)
  );
  await batchInsert(env.DB, revStmts);

  const summary = decks.map((d) => ({
    name: d.name,
    notes: d.notes.length,
    cards: d.cards.length,
  }));

  return new Response(
    JSON.stringify({ success: true, r2Key, decks: summary, reviewCount: reviews.length }),
    { headers: { "Content-Type": "application/json" } }
  );
}
