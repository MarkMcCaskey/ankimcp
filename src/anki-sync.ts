import { parseAnkiSqlite } from "./apkg";
import type { Env } from "./types";

import * as fzstd from "fzstd";
import { decompressSync as gunzipSync } from "fflate";

const COLLECTION_R2_KEY = "collections/user.anki2";

/**
 * Handle Anki sync protocol requests.
 * Implements the subset needed for full-sync: hostKey, meta, upload, download, abort.
 */
export async function handleAnkiSync(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const endpoint = pathname.replace(/^\/sync\//, "");

  try {
    switch (endpoint) {
      case "hostKey":
        return await handleHostKey(request, env);
      case "meta":
        return await handleMeta(request, env);
      case "upload":
        return await handleUpload(request, env);
      case "download":
        return await handleDownload(request, env);
      case "abort":
        return new Response("", { status: 200 });
      // Incremental sync endpoints — not yet implemented, return error
      case "start":
      case "applyGraves":
      case "applyChanges":
      case "chunk":
      case "applyChunk":
      case "sanityCheck2":
      case "finish":
        return jsonResponse({ error: "incremental sync not supported" }, 501);
      default:
        return new Response("Not Found", { status: 404 });
    }
  } catch (err) {
    console.error(`Sync error (${endpoint}):`, err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Internal error" },
      500
    );
  }
}

// ─── hostKey: authenticate and return a session token ───

async function handleHostKey(request: Request, env: Env): Promise<Response> {
  const { body } = await parseSyncRequest(request);
  let credentials: { u?: string; p?: string };

  try {
    credentials = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return jsonResponse({ error: "invalid request body" }, 400);
  }

  if (!credentials.u || !credentials.p) {
    return jsonResponse({ error: "missing username or password" }, 400);
  }

  if (credentials.u !== env.SYNC_USERNAME || credentials.p !== env.SYNC_PASSWORD) {
    return jsonResponse({ error: "invalid credentials" }, 403);
  }

  // Generate a host key (random hex string)
  const hostKey = generateHostKey();

  // Store in D1
  await env.DB.prepare(
    `INSERT INTO sync_state (id, host_key, schema_mod, last_mod, collection_r2_key)
     VALUES (1, ?, 0, 0, NULL)
     ON CONFLICT(id) DO UPDATE SET host_key = excluded.host_key`
  ).bind(hostKey).run();

  return jsonResponse({ key: hostKey });
}

// ─── meta: return sync metadata ───

async function handleMeta(request: Request, env: Env): Promise<Response> {
  const { syncHeader } = await parseSyncRequest(request);

  // Validate host key
  if (!(await validateHostKey(env, syncHeader.syncKey))) {
    return jsonResponse({ error: "invalid host key" }, 403);
  }

  // Get current sync state
  const state = await env.DB.prepare(
    "SELECT schema_mod, last_mod FROM sync_state WHERE id = 1"
  ).first();

  const schemaMod = (state?.schema_mod as number) ?? 0;
  const lastMod = (state?.last_mod as number) ?? 0;
  const now = Math.floor(Date.now() / 1000);

  // Return metadata. By returning our stored schema_mod (which starts at 0 and
  // will differ from the client's schema timestamp), we force a full sync.
  // Once we store the client's schema after upload, subsequent metas will
  // return the matching schema, preventing unnecessary full-sync prompts
  // (the user would still get prompted if client schema changes, e.g. after
  // editing note types).
  return jsonResponse({
    scm: schemaMod,
    ts: now,
    mod: lastMod,
    usn: -1,
    musn: 0,
    msg: "",
    cont: true,
    hostNum: 0,
  });
}

// ─── upload: receive full collection from client ───

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const { syncHeader, body } = await parseSyncRequest(request);

  if (!(await validateHostKey(env, syncHeader.syncKey))) {
    return jsonResponse({ error: "invalid host key" }, 403);
  }

  if (body.length === 0) {
    return new Response("no data received", { status: 400 });
  }

  // Store raw SQLite file in R2
  await env.BUCKET.put(COLLECTION_R2_KEY, body);

  // Parse the SQLite database and store in D1
  const { decks, reviews } = await parseAnkiSqlite(body);

  // Clear existing data and insert new
  await env.DB.batch([
    env.DB.prepare("DELETE FROM revlog"),
    env.DB.prepare("DELETE FROM cards"),
    env.DB.prepare("DELETE FROM notes"),
    env.DB.prepare("DELETE FROM decks"),
  ]);

  for (const deck of decks) {
    await env.DB.prepare(
      "INSERT INTO decks (id, name, card_count) VALUES (?, ?, ?)"
    )
      .bind(deck.id, deck.name, deck.cards.length)
      .run();

    for (const note of deck.notes) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO notes (id, deck_id, model_name, fields, field_names, tags) VALUES (?, ?, ?, ?, ?, ?)"
      )
        .bind(note.id, deck.id, note.modelName, JSON.stringify(note.fields), JSON.stringify(note.fieldNames), note.tags)
        .run();
    }

    for (const card of deck.cards) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO cards (id, note_id, deck_id, ord, type, queue, due, ivl, factor, reps, lapses, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(card.id, card.noteId, card.deckId, card.ord, card.type, card.queue, card.due, card.ivl, card.factor, card.reps, card.lapses, card.flags)
        .run();
    }
  }

  for (const rev of reviews) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO revlog (id, card_id, ease, ivl, last_ivl, factor, review_time, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(rev.id, rev.cardId, rev.ease, rev.ivl, rev.lastIvl, rev.factor, rev.reviewTime, rev.type)
      .run();
  }

  // Extract schema_mod and last_mod from the uploaded collection to store
  // so that future meta requests can return matching schema timestamp
  const schemaMod = await extractSchemaModFromSqlite(body);
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `UPDATE sync_state SET schema_mod = ?, last_mod = ?, collection_r2_key = ? WHERE id = 1`
  ).bind(schemaMod, now, COLLECTION_R2_KEY).run();

  // Anki expects plain text "OK" for successful upload
  return new Response("OK");
}

// ─── download: send full collection to client ───

async function handleDownload(request: Request, env: Env): Promise<Response> {
  const { syncHeader } = await parseSyncRequest(request);

  if (!(await validateHostKey(env, syncHeader.syncKey))) {
    return jsonResponse({ error: "invalid host key" }, 403);
  }

  const object = await env.BUCKET.get(COLLECTION_R2_KEY);
  if (!object) {
    return jsonResponse({ error: "no collection stored" }, 404);
  }

  const data = await object.arrayBuffer();

  // Return raw SQLite bytes. The client handles decompression based on
  // protocol version, but since we send uncompressed, no special handling needed.
  return new Response(data, {
    headers: {
      "Content-Type": "application/octet-stream",
    },
  });
}

// ─── Helper: parse sync request (handles v11 headers+zstd and legacy multipart+gzip) ───

interface SyncHeader {
  syncVersion: number;
  syncKey: string;
  clientVersion: string;
  sessionKey: string;
}

interface ParsedSyncRequest {
  syncHeader: SyncHeader;
  body: Uint8Array;
}

async function parseSyncRequest(request: Request): Promise<ParsedSyncRequest> {
  const ankiSyncHeader = request.headers.get("anki-sync");

  if (ankiSyncHeader) {
    // v11 protocol: JSON header + zstd-compressed body
    const header = JSON.parse(ankiSyncHeader) as { v?: number; k?: string; c?: string; s?: string };

    const rawBody = new Uint8Array(await request.arrayBuffer());

    // Decompress zstd if body is not empty
    let body: Uint8Array;
    if (rawBody.length > 0) {
      try {
        body = fzstd.decompress(rawBody) as Uint8Array;
      } catch {
        // Body might not be compressed (e.g., hostKey sends plain JSON)
        body = rawBody;
      }
    } else {
      body = rawBody;
    }

    return {
      syncHeader: {
        syncVersion: header.v ?? 11,
        syncKey: header.k ?? "",
        clientVersion: header.c ?? "",
        sessionKey: header.s ?? "",
      },
      body,
    };
  }

  // Legacy multipart protocol (v8-v10)
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const syncKey = (formData.get("k") as string) ?? (formData.get("sk") as string) ?? "";
    const sessionKey = (formData.get("s") as string) ?? "";
    const compressionFlag = (formData.get("c") as string) ?? "0";
    const dataField = formData.get("data");

    let body: Uint8Array;
    if (dataField && typeof dataField === "object" && "arrayBuffer" in dataField) {
      const buf = await (dataField as Blob).arrayBuffer();
      body = new Uint8Array(buf);
    } else if (typeof dataField === "string") {
      body = new TextEncoder().encode(dataField);
    } else {
      body = new Uint8Array(0);
    }

    // Decompress gzip if compression flag is set
    if (compressionFlag !== "0" && body.length > 0) {
      try {
        body = gunzipSync(body);
      } catch {
        // May not be compressed
      }
    }

    return {
      syncHeader: {
        syncVersion: 10,
        syncKey,
        clientVersion: "",
        sessionKey,
      },
      body,
    };
  }

  // Fallback: plain body (e.g., hostKey may send plain JSON)
  const rawBody = new Uint8Array(await request.arrayBuffer());
  return {
    syncHeader: {
      syncVersion: 10,
      syncKey: "",
      clientVersion: "",
      sessionKey: "",
    },
    body: rawBody,
  };
}

// ─── Helper: validate host key ───

async function validateHostKey(env: Env, key: string): Promise<boolean> {
  if (!key) return false;
  const state = await env.DB.prepare(
    "SELECT host_key FROM sync_state WHERE id = 1"
  ).first();
  return state?.host_key === key;
}

// ─── Helper: generate random host key ───

function generateHostKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Helper: extract schema modification timestamp from SQLite bytes ───

async function extractSchemaModFromSqlite(dbBytes: Uint8Array): Promise<number> {
  try {
    // @ts-expect-error -- no types for asm build
    const initSqlJs = (await import("sql.js/dist/sql-asm.js")).default;
    const SQL = await initSqlJs();
    const db = new SQL.Database(dbBytes);
    try {
      const result = db.exec("SELECT scm FROM col LIMIT 1");
      if (result.length > 0 && result[0].values.length > 0) {
        return result[0].values[0][0] as number;
      }
    } finally {
      db.close();
    }
  } catch {
    // If we can't extract schema mod, return current timestamp
  }
  return Math.floor(Date.now() / 1000);
}

// ─── Helper: JSON response ───

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
