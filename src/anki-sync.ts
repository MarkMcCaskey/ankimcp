import { parseAnkiSqlite } from "./apkg";
import { resolveSecret } from "./types";
import type { Env } from "./types";
import {
  handleStart,
  handleApplyGraves,
  handleApplyChanges,
  handleChunk,
  handleApplyChunk,
  handleSanityCheck,
  handleFinish,
  handleAbort as handleIncrementalAbort,
} from "./anki-sync-incremental";

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
      case "abort": {
        const { syncHeader: abortHeader } = await parseSyncRequest(request);
        if (await validateHostKey(env, abortHeader.syncKey)) {
          await handleIncrementalAbort(abortHeader.sessionKey, env);
        }
        return new Response("", { status: 200 });
      }
      case "start": {
        const { syncHeader: startHeader, body: startBody } = await parseSyncRequest(request);
        if (!(await validateHostKey(env, startHeader.syncKey))) return jsonResponse({ error: "invalid host key" }, 403);
        const graves = await handleStart(startBody, startHeader.sessionKey, env);
        return jsonResponse(graves);
      }
      case "applyGraves": {
        const { syncHeader: gravesHeader, body: gravesBody } = await parseSyncRequest(request);
        if (!(await validateHostKey(env, gravesHeader.syncKey))) return jsonResponse({ error: "invalid host key" }, 403);
        await handleApplyGraves(gravesBody, gravesHeader.sessionKey, env);
        return jsonResponse(null);
      }
      case "applyChanges": {
        const { syncHeader: changesHeader, body: changesBody } = await parseSyncRequest(request);
        if (!(await validateHostKey(env, changesHeader.syncKey))) return jsonResponse({ error: "invalid host key" }, 403);
        const serverChanges = await handleApplyChanges(changesBody, changesHeader.sessionKey, env);
        return jsonResponse(serverChanges);
      }
      case "chunk": {
        const { syncHeader: chunkHeader } = await parseSyncRequest(request);
        if (!(await validateHostKey(env, chunkHeader.syncKey))) return jsonResponse({ error: "invalid host key" }, 403);
        const chunk = await handleChunk(chunkHeader.sessionKey, env);
        return jsonResponse(chunk);
      }
      case "applyChunk": {
        const { syncHeader: applyChunkHeader, body: applyChunkBody } = await parseSyncRequest(request);
        if (!(await validateHostKey(env, applyChunkHeader.syncKey))) return jsonResponse({ error: "invalid host key" }, 403);
        await handleApplyChunk(applyChunkBody, applyChunkHeader.sessionKey, env);
        return jsonResponse(null);
      }
      case "sanityCheck2": {
        const { syncHeader: sanityHeader, body: sanityBody } = await parseSyncRequest(request);
        if (!(await validateHostKey(env, sanityHeader.syncKey))) return jsonResponse({ error: "invalid host key" }, 403);
        const sanityResult = await handleSanityCheck(sanityBody, sanityHeader.sessionKey, env);
        return jsonResponse(sanityResult);
      }
      case "finish": {
        const { syncHeader: finishHeader } = await parseSyncRequest(request);
        if (!(await validateHostKey(env, finishHeader.syncKey))) return jsonResponse({ error: "invalid host key" }, 403);
        const timestamp = await handleFinish(finishHeader.sessionKey, env);
        return jsonResponse(timestamp);
      }
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

  if (credentials.u !== await resolveSecret(env.SYNC_USERNAME) || credentials.p !== await resolveSecret(env.SYNC_PASSWORD)) {
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

  const now = Math.floor(Date.now() / 1000);

  // Try to read metadata from the actual Anki collection in R2
  const db = await loadCollectionSafe(env);
  if (db) {
    try {
      const col = db.exec("SELECT mod, scm, usn FROM col LIMIT 1");
      if (col.length > 0 && col[0].values.length > 0) {
        const row = col[0].values[0];
        return jsonResponse({
          scm: row[1] as number,     // schema mod timestamp
          ts: now,                    // server time
          mod: row[0] as number,     // collection mod timestamp
          usn: row[2] as number,     // server USN
          musn: 0,                   // media USN (no media sync)
          msg: "",
          cont: true,
          hostNum: 0,
          empty: false,
          media_usn: 0,
        });
      }
    } finally {
      db.close();
    }
  }

  // No collection stored yet - return empty state (forces full sync)
  return jsonResponse({
    scm: 0,
    ts: now,
    mod: 0,
    usn: 0,
    musn: 0,
    msg: "",
    cont: true,
    hostNum: 0,
    empty: true,
    media_usn: 0,
  });
}

/** Load collection from R2 without throwing on failure */
async function loadCollectionSafe(env: Env): Promise<import("./anki-collection").AnkiDatabase | null> {
  try {
    const { loadCollection } = await import("./anki-collection");
    return await loadCollection(env);
  } catch {
    return null;
  }
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
  // Note: revlog is NOT stored in D1 to reduce write volume.
  // MCP queries that need revlog data read from the R2 SQLite collection directly.
  const { decks } = await parseAnkiSqlite(body);

  // Clear existing data and insert new (no revlog in D1)
  await env.DB.batch([
    env.DB.prepare("DELETE FROM cards"),
    env.DB.prepare("DELETE FROM notes"),
    env.DB.prepare("DELETE FROM decks"),
  ]);

  // Batch insert to avoid Worker time limits
  const BATCH_SIZE = 100;
  const batchInsert = async (stmts: D1PreparedStatement[]) => {
    for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
      await env.DB.batch(stmts.slice(i, i + BATCH_SIZE));
    }
  };

  await batchInsert(decks.map((deck) =>
    env.DB.prepare("INSERT INTO decks (id, name, card_count) VALUES (?, ?, ?)")
      .bind(deck.id, deck.name, deck.cards.length)
  ));

  await batchInsert(decks.flatMap((deck) =>
    deck.notes.map((note) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO notes (id, deck_id, model_name, fields, field_names, tags) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(note.id, deck.id, note.modelName, JSON.stringify(note.fields), JSON.stringify(note.fieldNames), note.tags)
    )
  ));

  await batchInsert(decks.flatMap((deck) =>
    deck.cards.map((card) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO cards (id, note_id, deck_id, ord, type, queue, due, ivl, factor, reps, lapses, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(card.id, card.noteId, card.deckId, card.ord, card.type, card.queue, card.due, card.ivl, card.factor, card.reps, card.lapses, card.flags)
    )
  ));

  // Note: revlog is NOT inserted into D1 to stay within free-tier write limits.
  // MCP queries that need revlog data load from the R2 SQLite collection via sql.js.

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
