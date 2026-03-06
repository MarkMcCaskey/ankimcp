import { parseApkg } from "./apkg";
import type { Env } from "./types";

export async function handleUpload(
  request: Request,
  env: Env
): Promise<Response> {
  // Check auth
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (!token || token !== env.AUTH_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Parse multipart form
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

  // Optionally store raw file in R2
  const r2Key = `uploads/${Date.now()}-${file.name}`;
  await env.BUCKET.put(r2Key, arrayBuffer);

  // Parse the .apkg
  const decks = await parseApkg(arrayBuffer);

  // Clear existing data and insert new
  await env.DB.batch([
    env.DB.prepare("DELETE FROM cards"),
    env.DB.prepare("DELETE FROM notes"),
    env.DB.prepare("DELETE FROM decks"),
  ]);

  for (const deck of decks) {
    // Insert deck
    await env.DB.prepare(
      "INSERT INTO decks (id, name, card_count) VALUES (?, ?, ?)"
    )
      .bind(deck.id, deck.name, deck.cards.length)
      .run();

    // Insert notes in batches
    for (const note of deck.notes) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO notes (id, deck_id, model_name, fields, field_names, tags) VALUES (?, ?, ?, ?, ?, ?)"
      )
        .bind(
          note.id,
          deck.id,
          note.modelName,
          JSON.stringify(note.fields),
          JSON.stringify(note.fieldNames),
          note.tags
        )
        .run();
    }

    // Insert cards in batches
    for (const card of deck.cards) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO cards (id, note_id, deck_id, ord) VALUES (?, ?, ?, ?)"
      )
        .bind(card.id, card.noteId, card.deckId, card.ord)
        .run();
    }
  }

  const summary = decks.map((d) => ({
    name: d.name,
    notes: d.notes.length,
    cards: d.cards.length,
  }));

  return new Response(
    JSON.stringify({ success: true, r2Key, decks: summary }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
}
