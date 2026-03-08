import { parseApkg } from "./apkg";
import type { Env } from "./types";

const BATCH_SIZE = 100;

async function batchInsert(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await db.batch(statements.slice(i, i + BATCH_SIZE));
  }
}

/**
 * Sync endpoint: merges .apkg data into D1 without deleting existing decks.
 * Upserts decks, notes, cards, and review history.
 */
export async function handleSync(
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

  const r2Key = `syncs/${Date.now()}-${file.name}`;
  await env.BUCKET.put(r2Key, arrayBuffer);

  const { decks, reviews } = await parseApkg(arrayBuffer);

  let notesUpserted = 0;
  let cardsUpserted = 0;

  // Batch upsert decks
  const deckStmts = decks.map((deck) =>
    env.DB.prepare(
      `INSERT INTO decks (id, name, card_count)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         card_count = excluded.card_count,
         uploaded_at = datetime('now')`
    ).bind(deck.id, deck.name, deck.cards.length)
  );
  await batchInsert(env.DB, deckStmts);

  // Batch upsert notes
  const noteStmts = decks.flatMap((deck) =>
    deck.notes.map((note) => {
      notesUpserted++;
      return env.DB.prepare(
        `INSERT INTO notes (id, deck_id, model_name, fields, field_names, tags)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           deck_id = excluded.deck_id,
           model_name = excluded.model_name,
           fields = excluded.fields,
           field_names = excluded.field_names,
           tags = excluded.tags`
      ).bind(note.id, deck.id, note.modelName, JSON.stringify(note.fields), JSON.stringify(note.fieldNames), note.tags);
    })
  );
  await batchInsert(env.DB, noteStmts);

  // Batch upsert cards
  const cardStmts = decks.flatMap((deck) =>
    deck.cards.map((card) => {
      cardsUpserted++;
      return env.DB.prepare(
        `INSERT INTO cards (id, note_id, deck_id, ord, type, queue, due, ivl, factor, reps, lapses, flags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           note_id = excluded.note_id,
           deck_id = excluded.deck_id,
           ord = excluded.ord,
           type = excluded.type,
           queue = excluded.queue,
           due = excluded.due,
           ivl = excluded.ivl,
           factor = excluded.factor,
           reps = excluded.reps,
           lapses = excluded.lapses,
           flags = excluded.flags`
      ).bind(card.id, card.noteId, card.deckId, card.ord, card.type, card.queue, card.due, card.ivl, card.factor, card.reps, card.lapses, card.flags);
    })
  );
  await batchInsert(env.DB, cardStmts);

  // Batch upsert reviews
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
    JSON.stringify({
      success: true,
      r2Key,
      decks: summary,
      totals: { notesUpserted, cardsUpserted, reviewsImported: reviews.length },
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}
