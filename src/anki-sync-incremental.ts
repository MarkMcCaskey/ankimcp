/**
 * Incremental sync protocol implementation.
 *
 * Operates on the Anki SQLite collection stored in R2 using sql.js.
 * Each endpoint loads the collection, performs operations, and saves back.
 *
 * Protocol flow:
 *   start → applyGraves → applyChanges → chunk* → applyChunk* → sanityCheck → finish
 *
 * Data structures follow the Anki sync protocol's JSON format (schema 11).
 * Cards, notes, and revlog entries are serialized as tuples (arrays).
 */
import type { Env } from "./types";
import type { AnkiDatabase } from "./anki-collection";
import {
  loadCollection,
  saveCollection,
  ensureGravesTable,
  getColMeta,
} from "./anki-collection";

const CHUNK_SIZE = 250;

// ─── Types matching Anki sync protocol ───

export interface Graves {
  cards: number[];
  decks: number[];
  notes: number[];
}

export interface StartRequest {
  minUsn: number;
  lnewer: boolean;
  graves?: Graves;
}

// Unchunked changes use Anki-native JSON objects
export interface UnchunkedChanges {
  models: unknown[];  // NotetypeSchema11 JSON objects
  decks: [unknown[], unknown[]];  // [decks, deck_configs] tuple
  tags: string[];
  conf?: Record<string, unknown>;
  crt?: number;
}

export interface ApplyChangesRequest {
  changes: UnchunkedChanges;
}

// Chunk entries are tuples (arrays) matching Anki's Serialize_tuple format
// CardEntry: [id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data]
// NoteEntry: [id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data]
// RevlogEntry: [id, cid, usn, ease, ivl, lastIvl, factor, time, type]
export type CardTuple = [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, string];
export type NoteTuple = [number, string, number, number, number, string, string, string, string, number, string];
export type RevlogTuple = [number, number, number, number, number, number, number, number, number];

export interface Chunk {
  done: boolean;
  revlog?: RevlogTuple[];
  cards?: CardTuple[];
  notes?: NoteTuple[];
}

export interface ApplyChunkRequest {
  chunk: Chunk;
}

// SanityCheckCounts is serialized as a tuple:
// [due_counts, cards, notes, revlog, graves, models, decks, deck_config]
// where due_counts is [new, learn, review]
export type SanityCheckCountsTuple = [[number, number, number], number, number, number, number, number, number, number];

export interface SanityCheckRequest {
  client: SanityCheckCountsTuple;
}

export interface SanityCheckResponse {
  status: string;
  c?: SanityCheckCountsTuple;
  s?: SanityCheckCountsTuple;
}

// ─── Sync session state (persisted in D1 between requests) ───

interface SyncSession {
  session_key: string;
  server_usn: number;
  client_usn: number;
  client_is_newer: boolean;
  chunks_sent: boolean;
}

// ─── Endpoint handlers ───

export async function handleStart(body: Uint8Array, sessionKey: string, env: Env): Promise<Graves> {
  const req: StartRequest = JSON.parse(new TextDecoder().decode(body));

  const db = await loadCollection(env);
  if (!db) {
    throw new Error("No collection on server. Please do a full sync first.");
  }

  try {
    ensureGravesTable(db);
    const col = getColMeta(db);

    const serverUsn = col.usn;
    const clientUsn = req.minUsn;

    // Get server graves (items deleted since client's last sync)
    const serverGraves = getGravesSince(db, clientUsn);

    // Apply client's legacy graves if present (deprecated but some clients still send them)
    if (req.graves) {
      applyGravesToDb(db, req.graves, serverUsn);
      await saveCollection(env, db);
    }

    // Store sync session
    await env.DB.prepare(
      `INSERT INTO sync_session (session_key, server_usn, client_usn, client_is_newer, chunks_sent)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(session_key) DO UPDATE SET
         server_usn = excluded.server_usn,
         client_usn = excluded.client_usn,
         client_is_newer = excluded.client_is_newer,
         chunks_sent = 0`
    ).bind(sessionKey, serverUsn, clientUsn, req.lnewer ? 1 : 0).run();

    return serverGraves;
  } finally {
    db.close();
  }
}

export async function handleApplyGraves(body: Uint8Array, sessionKey: string, env: Env): Promise<void> {
  // Anki protocol uses field name "chunk" for the graves payload in applyGraves
  const req = JSON.parse(new TextDecoder().decode(body)) as { chunk?: Graves; graves?: Graves };
  const graves = req.chunk ?? req.graves ?? { cards: [], decks: [], notes: [] };

  const db = await loadCollection(env);
  if (!db) throw new Error("No collection");

  try {
    ensureGravesTable(db);
    const session = await getSession(env, sessionKey);
    applyGravesToDb(db, graves, session.server_usn);
    await saveCollection(env, db);
  } finally {
    db.close();
  }
}

export async function handleApplyChanges(body: Uint8Array, sessionKey: string, env: Env): Promise<UnchunkedChanges> {
  const req: ApplyChangesRequest = JSON.parse(new TextDecoder().decode(body));
  const session = await getSession(env, sessionKey);

  const db = await loadCollection(env);
  if (!db) throw new Error("No collection");

  try {
    // Get server's changes to send to client
    const serverChanges = getServerUnchunkedChanges(db, session.client_usn);

    // Apply client's changes
    applyClientUnchunkedChanges(db, req.changes, session.server_usn);

    await saveCollection(env, db);
    return serverChanges;
  } finally {
    db.close();
  }
}

export async function handleChunk(sessionKey: string, env: Env): Promise<Chunk> {
  const session = await getSession(env, sessionKey);

  if (session.chunks_sent) {
    return { done: true };
  }

  const db = await loadCollection(env);
  if (!db) throw new Error("No collection");

  try {
    const chunk = getServerChunk(db, session.client_usn);

    // Mark chunks as sent
    await env.DB.prepare(
      "UPDATE sync_session SET chunks_sent = 1 WHERE session_key = ?"
    ).bind(sessionKey).run();

    return chunk;
  } finally {
    db.close();
  }
}

export async function handleApplyChunk(body: Uint8Array, sessionKey: string, env: Env): Promise<void> {
  const req: ApplyChunkRequest = JSON.parse(new TextDecoder().decode(body));
  const session = await getSession(env, sessionKey);

  const db = await loadCollection(env);
  if (!db) throw new Error("No collection");

  try {
    applyClientChunk(db, req.chunk, session.server_usn);
    await saveCollection(env, db);
  } finally {
    db.close();
  }
}

export async function handleSanityCheck(body: Uint8Array, sessionKey: string, env: Env): Promise<SanityCheckResponse> {
  const req: SanityCheckRequest = JSON.parse(new TextDecoder().decode(body));
  await getSession(env, sessionKey); // validate session

  const db = await loadCollection(env);
  if (!db) throw new Error("No collection");

  try {
    const serverCounts = getServerSanityCheckCounts(db);
    const clientCounts = req.client;

    // Compare counts (ignore due counts [index 0], they can legitimately differ)
    const match =
      clientCounts[1] === serverCounts[1] && // cards
      clientCounts[2] === serverCounts[2] && // notes
      clientCounts[3] === serverCounts[3];   // revlog

    return {
      status: match ? "ok" : "bad",
      c: match ? undefined : clientCounts,
      s: match ? undefined : serverCounts,
    };
  } finally {
    db.close();
  }
}

export async function handleFinish(sessionKey: string, env: Env): Promise<number> {
  await getSession(env, sessionKey);

  const db = await loadCollection(env);
  if (!db) throw new Error("No collection");

  try {
    const now = Date.now();

    // Increment USN and update modification time
    db.run("UPDATE col SET usn = usn + 1, mod = ?, ls = ?", [now, Math.floor(now / 1000)]);

    await saveCollection(env, db);

    // Update D1 sync state
    const col = getColMeta(db);
    await env.DB.prepare(
      "UPDATE sync_state SET schema_mod = ?, last_mod = ?, collection_r2_key = ? WHERE id = 1"
    ).bind(col.scm, Math.floor(now / 1000), "collections/user.anki2").run();

    // Clean up session
    await env.DB.prepare("DELETE FROM sync_session WHERE session_key = ?").bind(sessionKey).run();

    // Re-parse collection into D1 for MCP queries
    await refreshD1FromCollection(db, env);

    return now;
  } finally {
    db.close();
  }
}

export async function handleAbort(sessionKey: string, env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM sync_session WHERE session_key = ?").bind(sessionKey).run();
}

// ─── Internal helpers ───

async function getSession(env: Env, sessionKey: string): Promise<SyncSession> {
  const row = await env.DB.prepare(
    "SELECT session_key, server_usn, client_usn, client_is_newer, chunks_sent FROM sync_session WHERE session_key = ?"
  ).bind(sessionKey).first();

  if (!row) {
    throw new Error("No active sync session");
  }

  return {
    session_key: row.session_key as string,
    server_usn: row.server_usn as number,
    client_usn: row.client_usn as number,
    client_is_newer: Boolean(row.client_is_newer),
    chunks_sent: Boolean(row.chunks_sent),
  };
}

function getGravesSince(db: AnkiDatabase, clientUsn: number): Graves {
  const graves: Graves = { cards: [], decks: [], notes: [] };

  const result = db.exec(`SELECT oid, type FROM graves WHERE usn >= ${Number(clientUsn)}`);
  if (result.length > 0) {
    for (const row of result[0].values) {
      const oid = row[0] as number;
      const type = row[1] as number;
      // type: 0=card, 1=note, 2=deck
      if (type === 0) graves.cards.push(oid);
      else if (type === 1) graves.notes.push(oid);
      else if (type === 2) graves.decks.push(oid);
    }
  }

  return graves;
}

function applyGravesToDb(db: AnkiDatabase, graves: Graves, serverUsn: number): void {
  for (const cardId of graves.cards) {
    db.run("DELETE FROM cards WHERE id = ?", [cardId]);
    db.run("INSERT INTO graves (usn, oid, type) VALUES (?, ?, 0)", [serverUsn, cardId]);
  }

  for (const noteId of graves.notes) {
    db.run("DELETE FROM notes WHERE id = ?", [noteId]);
    db.run("DELETE FROM cards WHERE nid = ?", [noteId]);
    db.run("INSERT INTO graves (usn, oid, type) VALUES (?, ?, 1)", [serverUsn, noteId]);
  }

  for (const deckId of graves.decks) {
    if (deckId === 1) continue; // never delete default deck
    db.run("DELETE FROM cards WHERE did = ?", [deckId]);
    db.run("INSERT INTO graves (usn, oid, type) VALUES (?, ?, 2)", [serverUsn, deckId]);

    // Remove from decks JSON in col table
    const colResult = db.exec("SELECT decks FROM col LIMIT 1");
    if (colResult.length > 0) {
      const decks = JSON.parse(colResult[0].values[0][0] as string);
      delete decks[String(deckId)];
      db.run("UPDATE col SET decks = ?", [JSON.stringify(decks)]);
    }
  }
}

function getServerUnchunkedChanges(db: AnkiDatabase, clientUsn: number): UnchunkedChanges {
  const colResult = db.exec("SELECT models, decks, dconf, tags, conf, crt FROM col LIMIT 1");
  if (colResult.length === 0) {
    return { models: [], decks: [[], []], tags: [] };
  }

  const row = colResult[0].values[0];
  const allModels = JSON.parse(row[0] as string) as Record<string, unknown>;
  const allDecks = JSON.parse(row[1] as string) as Record<string, unknown>;
  const allDconf = JSON.parse(row[2] as string) as Record<string, unknown>;
  const allTags = JSON.parse(row[3] as string) as Record<string, unknown>;

  // Filter to items changed since client's USN
  const changedModels = Object.values(allModels).filter(
    (m) => (m as Record<string, number>).usn >= clientUsn
  );
  const changedDecks = Object.values(allDecks).filter(
    (d) => (d as Record<string, number>).usn >= clientUsn
  );
  const changedDconf = Object.values(allDconf).filter(
    (c) => (c as Record<string, number>).usn >= clientUsn
  );
  const changedTags = Object.keys(allTags).filter(
    (t) => (allTags[t] as number) >= clientUsn
  );

  return {
    models: changedModels,
    decks: [changedDecks, changedDconf],
    tags: changedTags,
  };
}

function applyClientUnchunkedChanges(db: AnkiDatabase, changes: UnchunkedChanges, serverUsn: number): void {
  const colResult = db.exec("SELECT models, decks, dconf, tags, conf FROM col LIMIT 1");
  if (colResult.length === 0) return;

  const row = colResult[0].values[0];
  const allModels = JSON.parse(row[0] as string) as Record<string, Record<string, unknown>>;
  const allDecks = JSON.parse(row[1] as string) as Record<string, Record<string, unknown>>;
  const allDconf = JSON.parse(row[2] as string) as Record<string, Record<string, unknown>>;
  const allTags = JSON.parse(row[3] as string) as Record<string, number>;
  let conf = JSON.parse(row[4] as string) as Record<string, unknown>;

  // Apply model changes
  for (const model of changes.models) {
    const m = model as Record<string, unknown>;
    const mid = String(m.id);
    m.usn = serverUsn;
    allModels[mid] = m;
  }

  // Apply deck changes
  const [clientDecks, clientDconfs] = changes.decks;
  for (const deck of clientDecks) {
    const d = deck as Record<string, unknown>;
    const did = String(d.id);
    d.usn = serverUsn;
    allDecks[did] = d;
  }
  for (const dconf of clientDconfs) {
    const dc = dconf as Record<string, unknown>;
    const dcid = String(dc.id);
    dc.usn = serverUsn;
    allDconf[dcid] = dc;
  }

  // Apply tag changes
  for (const tag of changes.tags) {
    allTags[tag] = serverUsn;
  }

  // Apply config changes
  if (changes.conf) {
    conf = { ...conf, ...changes.conf };
  }

  // Build parameterized update
  const params: unknown[] = [
    JSON.stringify(allModels),
    JSON.stringify(allDecks),
    JSON.stringify(allDconf),
    JSON.stringify(allTags),
    JSON.stringify(conf),
  ];

  let sql = "UPDATE col SET models = ?, decks = ?, dconf = ?, tags = ?, conf = ?";

  if (changes.crt !== undefined) {
    sql += ", crt = ?";
    params.push(changes.crt);
  }

  db.run(sql, params as (string | number)[]);
}

function getServerChunk(db: AnkiDatabase, clientUsn: number): Chunk {
  const chunk: Chunk = { done: false };
  let count = 0;
  const usn = Number(clientUsn);

  // Anki sync protocol: items with usn >= clientUsn OR usn == -1 (pending) need syncing
  const pendingFilter = `(usn >= ${usn} OR usn = -1)`;

  // Get changed revlog entries
  const revlogResult = db.exec(
    `SELECT id, cid, usn, ease, ivl, lastIvl, factor, time, type FROM revlog WHERE ${pendingFilter} ORDER BY id LIMIT ${CHUNK_SIZE}`
  );
  if (revlogResult.length > 0 && revlogResult[0].values.length > 0) {
    chunk.revlog = revlogResult[0].values.map((row) => row as unknown as RevlogTuple);
    count += chunk.revlog.length;
  }

  // Get changed cards (fill remaining chunk space)
  const cardLimit = CHUNK_SIZE - count;
  if (cardLimit > 0) {
    const cardResult = db.exec(
      `SELECT id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data FROM cards WHERE ${pendingFilter} ORDER BY id LIMIT ${cardLimit}`
    );
    if (cardResult.length > 0 && cardResult[0].values.length > 0) {
      chunk.cards = cardResult[0].values.map((row) => row as unknown as CardTuple);
      count += chunk.cards.length;
    }
  }

  // Get changed notes (fill remaining chunk space)
  const noteLimit = CHUNK_SIZE - count;
  if (noteLimit > 0) {
    const noteResult = db.exec(
      `SELECT id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data FROM notes WHERE ${pendingFilter} ORDER BY id LIMIT ${noteLimit}`
    );
    if (noteResult.length > 0 && noteResult[0].values.length > 0) {
      chunk.notes = noteResult[0].values.map((row) => row as unknown as NoteTuple);
      count += chunk.notes.length;
    }
  }

  // If total items < CHUNK_SIZE, we've sent everything
  if (count < CHUNK_SIZE) {
    chunk.done = true;
  }

  return chunk;
}

function applyClientChunk(db: AnkiDatabase, chunk: Chunk, serverUsn: number): void {
  // Apply revlog entries
  if (chunk.revlog) {
    for (const entry of chunk.revlog) {
      const [id, cid, , ease, ivl, lastIvl, factor, time, type] = entry;
      db.run(
        `INSERT OR REPLACE INTO revlog (id, cid, usn, ease, ivl, lastIvl, factor, time, type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, cid, serverUsn, ease, ivl, lastIvl, factor, time, type]
      );
    }
  }

  // Apply cards
  if (chunk.cards) {
    for (const entry of chunk.cards) {
      const [id, nid, did, ord, mod, , ctype, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data] = entry;
      db.run(
        `INSERT OR REPLACE INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, nid, did, ord, mod, serverUsn, ctype, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data]
      );
    }
  }

  // Apply notes
  if (chunk.notes) {
    for (const entry of chunk.notes) {
      const [id, guid, mid, mod, , tags, flds, sfld, csum, flags, data] = entry;
      db.run(
        `INSERT OR REPLACE INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, guid, mid, mod, serverUsn, tags, flds, sfld, csum, flags, data]
      );
    }
  }
}

function getServerSanityCheckCounts(db: AnkiDatabase): SanityCheckCountsTuple {
  const cardCount = (db.exec("SELECT COUNT(*) FROM cards")[0]?.values[0]?.[0] as number) ?? 0;
  const noteCount = (db.exec("SELECT COUNT(*) FROM notes")[0]?.values[0]?.[0] as number) ?? 0;
  const revlogCount = (db.exec("SELECT COUNT(*) FROM revlog")[0]?.values[0]?.[0] as number) ?? 0;
  const gravesCount = (db.exec("SELECT COUNT(*) FROM graves")[0]?.values[0]?.[0] as number) ?? 0;

  const colResult = db.exec("SELECT models, decks, dconf FROM col LIMIT 1");
  let modelCount = 0;
  let deckCount = 0;
  let dconfCount = 0;
  if (colResult.length > 0) {
    const row = colResult[0].values[0];
    modelCount = Object.keys(JSON.parse(row[0] as string)).length;
    deckCount = Object.keys(JSON.parse(row[1] as string)).length;
    dconfCount = Object.keys(JSON.parse(row[2] as string)).length;
  }

  // Due counts: [new, learn, review]
  const newCount = (db.exec("SELECT COUNT(*) FROM cards WHERE type = 0 AND queue >= 0")[0]?.values[0]?.[0] as number) ?? 0;
  const learnCount = (db.exec("SELECT COUNT(*) FROM cards WHERE type IN (1, 3) AND queue >= 0")[0]?.values[0]?.[0] as number) ?? 0;
  const reviewCount = (db.exec("SELECT COUNT(*) FROM cards WHERE type = 2 AND queue >= 0")[0]?.values[0]?.[0] as number) ?? 0;

  return [
    [newCount, learnCount, reviewCount],
    cardCount,
    noteCount,
    revlogCount,
    gravesCount,
    modelCount,
    deckCount,
    dconfCount,
  ];
}

/**
 * Re-parse the Anki SQLite collection into D1 for MCP queries.
 * This is called after finish to keep D1 in sync.
 */
async function refreshD1FromCollection(db: AnkiDatabase, env: Env): Promise<void> {
  // Extract decks from col table
  const colResult = db.exec("SELECT decks, models FROM col LIMIT 1");
  if (colResult.length === 0) return;

  const decksJson = JSON.parse(colResult[0].values[0][0] as string) as Record<string, { name: string }>;
  const modelsJson = JSON.parse(colResult[0].values[0][1] as string) as Record<string, { name: string; flds: Array<{ name: string }> }>;

  const modelMap = new Map<string, { name: string; fieldNames: string[] }>();
  for (const [mid, model] of Object.entries(modelsJson)) {
    modelMap.set(mid, {
      name: model.name,
      fieldNames: model.flds.map((f) => f.name),
    });
  }

  // Clear and rebuild D1
  await env.DB.batch([
    env.DB.prepare("DELETE FROM revlog"),
    env.DB.prepare("DELETE FROM cards"),
    env.DB.prepare("DELETE FROM notes"),
    env.DB.prepare("DELETE FROM decks"),
  ]);

  // Insert decks
  const cardCounts = new Map<string, number>();
  const cardCountResult = db.exec("SELECT did, COUNT(*) as cnt FROM cards GROUP BY did");
  if (cardCountResult.length > 0) {
    for (const row of cardCountResult[0].values) {
      cardCounts.set(String(row[0]), row[1] as number);
    }
  }

  for (const [deckId, deckInfo] of Object.entries(decksJson)) {
    await env.DB.prepare("INSERT INTO decks (id, name, card_count) VALUES (?, ?, ?)")
      .bind(deckId, deckInfo.name, cardCounts.get(deckId) ?? 0)
      .run();
  }

  // Insert notes
  const noteResult = db.exec("SELECT id, mid, flds, tags FROM notes");
  if (noteResult.length > 0) {
    for (const row of noteResult[0].values) {
      const noteId = row[0] as number;
      const modelId = String(row[1]);
      const fieldsRaw = row[2] as string;
      const tags = (row[3] as string).trim();
      const model = modelMap.get(modelId);
      const fields = fieldsRaw.split("\x1f");
      const fieldNames = model?.fieldNames ?? fields.map((_, i) => `Field ${i + 1}`);

      // A note can have cards in multiple decks; pick the first card's deck
      const deckLookup = db.exec(`SELECT did FROM cards WHERE nid = ${Number(noteId)} LIMIT 1`);
      const deckId = deckLookup.length > 0 ? String(deckLookup[0].values[0][0]) : "1";

      await env.DB.prepare(
        "INSERT OR IGNORE INTO notes (id, deck_id, model_name, fields, field_names, tags) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(noteId, deckId, model?.name ?? "Unknown", JSON.stringify(fields), JSON.stringify(fieldNames), tags).run();
    }
  }

  // Insert cards
  const allCardsResult = db.exec(
    "SELECT id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses, flags FROM cards"
  );
  if (allCardsResult.length > 0) {
    for (const row of allCardsResult[0].values) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO cards (id, note_id, deck_id, ord, type, queue, due, ivl, factor, reps, lapses, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        row[0] as number, row[1] as number, String(row[2]), row[3] as number,
        row[4] as number, row[5] as number, row[6] as number, row[7] as number,
        row[8] as number, row[9] as number, row[10] as number, row[11] as number
      ).run();
    }
  }

  // Insert revlog
  const allRevlogResult = db.exec("SELECT id, cid, ease, ivl, lastIvl, factor, time, type FROM revlog");
  if (allRevlogResult.length > 0) {
    for (const row of allRevlogResult[0].values) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO revlog (id, card_id, ease, ivl, last_ivl, factor, review_time, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        row[0] as number, row[1] as number, row[2] as number, row[3] as number,
        row[4] as number, row[5] as number, row[6] as number, row[7] as number
      ).run();
    }
  }
}
