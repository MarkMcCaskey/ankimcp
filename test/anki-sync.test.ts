import {
  describe,
  it,
  expect,
  beforeEach,
} from "vitest";
import {
  env,
  SELF,
} from "cloudflare:test";

/**
 * Comprehensive tests for the Anki sync protocol implementation.
 * Tests both full-sync (upload/download) and incremental sync flows.
 */

// ─── Test helpers ───

/** Create the D1 schema tables for tests */
async function setupSchema() {
  await env.DB.exec("CREATE TABLE IF NOT EXISTS decks (id TEXT PRIMARY KEY, name TEXT NOT NULL, card_count INTEGER DEFAULT 0, uploaded_at TEXT DEFAULT (datetime('now')))");
  await env.DB.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, deck_id TEXT NOT NULL, model_name TEXT, fields TEXT NOT NULL, field_names TEXT NOT NULL, tags TEXT DEFAULT '')");
  await env.DB.exec("CREATE TABLE IF NOT EXISTS cards (id INTEGER PRIMARY KEY, note_id INTEGER NOT NULL, deck_id TEXT NOT NULL, ord INTEGER DEFAULT 0, type INTEGER DEFAULT 0, queue INTEGER DEFAULT 0, due INTEGER DEFAULT 0, ivl INTEGER DEFAULT 0, factor INTEGER DEFAULT 0, reps INTEGER DEFAULT 0, lapses INTEGER DEFAULT 0, flags INTEGER DEFAULT 0)");
  await env.DB.exec("CREATE TABLE IF NOT EXISTS revlog (id INTEGER PRIMARY KEY, card_id INTEGER NOT NULL, ease INTEGER NOT NULL, ivl INTEGER NOT NULL, last_ivl INTEGER NOT NULL, factor INTEGER NOT NULL, review_time INTEGER NOT NULL, type INTEGER NOT NULL)");
  await env.DB.exec("CREATE TABLE IF NOT EXISTS sync_state (id INTEGER PRIMARY KEY CHECK (id = 1), host_key TEXT NOT NULL, schema_mod INTEGER DEFAULT 0, last_mod INTEGER DEFAULT 0, collection_r2_key TEXT)");
  await env.DB.exec("CREATE TABLE IF NOT EXISTS sync_session (session_key TEXT PRIMARY KEY, server_usn INTEGER NOT NULL, client_usn INTEGER NOT NULL, client_is_newer INTEGER DEFAULT 0, chunks_sent INTEGER DEFAULT 0, created_at INTEGER DEFAULT (unixepoch()))");
  // Clean up
  await env.DB.exec("DELETE FROM revlog");
  await env.DB.exec("DELETE FROM cards");
  await env.DB.exec("DELETE FROM notes");
  await env.DB.exec("DELETE FROM decks");
  await env.DB.exec("DELETE FROM sync_state");
  await env.DB.exec("DELETE FROM sync_session");
}

/** Build a v11 protocol sync request */
function syncRequest(
  endpoint: string,
  body: unknown,
  opts: { syncKey?: string; sessionKey?: string } = {}
): Request {
  const syncHeader = JSON.stringify({
    v: 11,
    k: opts.syncKey ?? "",
    c: "test-client",
    s: opts.sessionKey ?? "test-session",
  });

  const bodyStr = body !== null ? JSON.stringify(body) : "";

  return new Request(`https://fake.host/sync/${endpoint}`, {
    method: "POST",
    headers: {
      "anki-sync": syncHeader,
    },
    body: bodyStr,
  });
}

/** Authenticate and get a host key */
async function authenticate(): Promise<string> {
  const res = await SELF.fetch(
    syncRequest("hostKey", { u: "testuser", p: "testpass" })
  );
  expect(res.status).toBe(200);
  const body = await res.json() as { key: string };
  return body.key;
}

/** Create a test Anki collection database and upload it via full sync.
 * Returns the host key used.
 */
async function uploadTestCollection(hostKey: string): Promise<void> {
  // We need to create a valid Anki SQLite database and upload it.
  // Use sql.js to create the database in-memory, export it, then upload.
  const { createEmptyCollection } = await import("../src/anki-collection");
  const db = await createEmptyCollection();

  try {
    // Add a notetype
    const modelId = 1234567890;
    const models = JSON.stringify({
      [String(modelId)]: {
        id: modelId,
        name: "Basic",
        mod: 0,
        usn: 0,
        flds: [{ name: "Front", ord: 0 }, { name: "Back", ord: 1 }],
        tmpls: [{ name: "Card 1", qfmt: "{{Front}}", afmt: "{{Back}}", ord: 0 }],
        tags: [],
        did: 1,
        type: 0,
        css: "",
        sortf: 0,
      },
    });

    // Add a deck
    const testDeckId = 1000;
    const decks = JSON.stringify({
      "1": { id: 1, name: "Default", mod: 0, usn: 0, collapsed: false, desc: "", dyn: 0, conf: 1, extendRev: 0, extendNew: 0 },
      [String(testDeckId)]: { id: testDeckId, name: "Test Deck", mod: 0, usn: 0, collapsed: false, desc: "", dyn: 0, conf: 1, extendRev: 0, extendNew: 0 },
    });

    db.run("UPDATE col SET models = ?, decks = ?", [models, decks]);

    // Add notes and cards
    const now = Math.floor(Date.now() / 1000);
    db.run(
      "INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [100, "guid100", modelId, now, 0, "", "Hello\x1fWorld", "Hello", 0, 0, ""]
    );
    db.run(
      "INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [101, "guid101", modelId, now, 0, " test ", "Foo\x1fBar", "Foo", 0, 0, ""]
    );

    db.run(
      "INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [200, 100, testDeckId, 0, now, 0, 2, 2, 10, 21, 2500, 8, 0, 0, 0, 0, 0, ""]
    );
    db.run(
      "INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [201, 101, testDeckId, 0, now, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ""]
    );

    // Add some review history
    db.run(
      "INSERT INTO revlog (id, cid, usn, ease, ivl, lastIvl, factor, time, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [Date.now() - 86400000, 200, 0, 3, 21, 10, 2500, 5000, 1]
    );

    const data = db.export();

    // Upload via sync protocol
    const uploadReq = new Request("https://fake.host/sync/upload", {
      method: "POST",
      headers: {
        "anki-sync": JSON.stringify({ v: 11, k: hostKey, c: "test", s: "s1" }),
      },
      body: data,
    });

    const res = await SELF.fetch(uploadReq);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("OK");
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  await setupSchema();
});

// ─── Authentication tests ───

describe("Sync hostKey authentication", () => {
  it("returns a host key with correct credentials", async () => {
    const res = await SELF.fetch(
      syncRequest("hostKey", { u: "testuser", p: "testpass" })
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { key: string };
    expect(body.key).toBeDefined();
    expect(body.key.length).toBe(64); // 32 bytes hex
  });

  it("rejects wrong credentials", async () => {
    const res = await SELF.fetch(
      syncRequest("hostKey", { u: "wrong", p: "wrong" })
    );
    expect(res.status).toBe(403);
  });

  it("rejects missing credentials", async () => {
    const res = await SELF.fetch(
      syncRequest("hostKey", {})
    );
    expect(res.status).toBe(400);
  });

  it("rejects non-POST methods", async () => {
    const res = await SELF.fetch("https://fake.host/sync/hostKey");
    expect(res.status).toBe(405);
  });
});

// ─── Meta endpoint tests ───

describe("Sync meta endpoint", () => {
  it("returns empty state when no collection exists", async () => {
    const hostKey = await authenticate();
    const res = await SELF.fetch(
      syncRequest("meta", { v: 11, cv: "test" }, { syncKey: hostKey })
    );
    expect(res.status).toBe(200);
    const meta = await res.json() as { scm: number; mod: number; usn: number; cont: boolean; empty: boolean };
    expect(meta.scm).toBe(0);
    expect(meta.usn).toBe(0);
    expect(meta.cont).toBe(true);
    expect(meta.empty).toBe(true);
  });

  it("returns collection metadata after upload", async () => {
    const hostKey = await authenticate();
    await uploadTestCollection(hostKey);

    const res = await SELF.fetch(
      syncRequest("meta", { v: 11, cv: "test" }, { syncKey: hostKey })
    );
    expect(res.status).toBe(200);
    const meta = await res.json() as { scm: number; mod: number; usn: number; empty: boolean };
    expect(meta.scm).toBeGreaterThan(0);
    expect(meta.usn).toBe(0); // initial USN is 0
    expect(meta.empty).toBe(false);
  });

  it("rejects invalid host key", async () => {
    const res = await SELF.fetch(
      syncRequest("meta", { v: 11, cv: "test" }, { syncKey: "invalid" })
    );
    expect(res.status).toBe(403);
  });
});

// ─── Full sync tests ───

describe("Full sync (upload/download)", () => {
  it("uploads a collection and stores it in R2 + D1", async () => {
    const hostKey = await authenticate();
    await uploadTestCollection(hostKey);

    // Verify data is in D1
    const decks = await env.DB.prepare("SELECT * FROM decks ORDER BY name").all();
    expect(decks.results.length).toBeGreaterThanOrEqual(2);
    expect(decks.results.map(d => d.name)).toContain("Test Deck");

    const cards = await env.DB.prepare("SELECT * FROM cards").all();
    expect(cards.results.length).toBe(2);

    const notes = await env.DB.prepare("SELECT * FROM notes").all();
    expect(notes.results.length).toBe(2);
  });

  it("downloads a previously uploaded collection", async () => {
    const hostKey = await authenticate();
    await uploadTestCollection(hostKey);

    const res = await SELF.fetch(
      syncRequest("download", null, { syncKey: hostKey })
    );
    expect(res.status).toBe(200);

    const data = new Uint8Array(await res.arrayBuffer());
    expect(data.length).toBeGreaterThan(0);

    // Verify it's a valid SQLite database by checking the magic bytes
    const header = new TextDecoder().decode(data.slice(0, 15));
    expect(header).toBe("SQLite format 3");
  });

  it("returns 404 when no collection to download", async () => {
    const hostKey = await authenticate();
    const res = await SELF.fetch(
      syncRequest("download", null, { syncKey: hostKey })
    );
    expect(res.status).toBe(404);
  });
});

// ─── Incremental sync tests ───

describe("Incremental sync flow", () => {
  let hostKey: string;

  beforeEach(async () => {
    hostKey = await authenticate();
    await uploadTestCollection(hostKey);
  });

  it("start returns empty graves when nothing deleted", async () => {
    const sessionKey = "incr-session-1";
    const res = await SELF.fetch(
      syncRequest("start", { minUsn: 0, lnewer: false }, { syncKey: hostKey, sessionKey })
    );
    expect(res.status).toBe(200);
    const graves = await res.json() as { cards: number[]; decks: number[]; notes: number[] };
    expect(graves.cards).toEqual([]);
    expect(graves.decks).toEqual([]);
    expect(graves.notes).toEqual([]);
  });

  it("applyGraves removes items from the collection", async () => {
    const sessionKey = "incr-session-2";

    // Start the sync
    await SELF.fetch(
      syncRequest("start", { minUsn: 0, lnewer: true }, { syncKey: hostKey, sessionKey })
    );

    // Apply graves (delete card 200)
    const gravesRes = await SELF.fetch(
      syncRequest("applyGraves", { graves: { cards: [200], decks: [], notes: [] } }, { syncKey: hostKey, sessionKey })
    );
    expect(gravesRes.status).toBe(200);

    // Verify card is deleted from R2 collection
    const { loadCollection } = await import("../src/anki-collection");
    const db = await loadCollection(env);
    expect(db).not.toBeNull();
    try {
      const cards = db!.exec("SELECT COUNT(*) FROM cards WHERE id = 200");
      expect(cards[0].values[0][0]).toBe(0); // card deleted
    } finally {
      db!.close();
    }
  });

  it("applyChanges exchanges unchunked data", async () => {
    const sessionKey = "incr-session-3";

    // Start
    await SELF.fetch(
      syncRequest("start", { minUsn: 0, lnewer: true }, { syncKey: hostKey, sessionKey })
    );

    // Apply graves (empty)
    await SELF.fetch(
      syncRequest("applyGraves", { graves: { cards: [], decks: [], notes: [] } }, { syncKey: hostKey, sessionKey })
    );

    // Apply changes - send a new deck from the client
    const clientChanges = {
      changes: {
        models: [],
        decks: [[
          { id: 2000, name: "Client Deck", mod: 0, usn: -1, collapsed: false, desc: "", dyn: 0, conf: 1, extendRev: 0, extendNew: 0 }
        ], []],
        tags: ["new-tag"],
      }
    };

    const changesRes = await SELF.fetch(
      syncRequest("applyChanges", clientChanges, { syncKey: hostKey, sessionKey })
    );
    expect(changesRes.status).toBe(200);

    const serverChanges = await changesRes.json() as { models: unknown[]; decks: [unknown[], unknown[]]; tags: string[] };
    // Server should return its changes (models, decks, tags that changed since client's USN)
    expect(serverChanges).toHaveProperty("models");
    expect(serverChanges).toHaveProperty("decks");
    expect(serverChanges).toHaveProperty("tags");

    // Verify client's deck was applied to the collection
    const { loadCollection } = await import("../src/anki-collection");
    const db = await loadCollection(env);
    try {
      const col = db!.exec("SELECT decks FROM col LIMIT 1");
      const decks = JSON.parse(col[0].values[0][0] as string);
      expect(decks["2000"]).toBeDefined();
      expect(decks["2000"].name).toBe("Client Deck");
    } finally {
      db!.close();
    }
  });

  it("chunk returns server changes and marks done", async () => {
    const sessionKey = "incr-session-4";

    // Start (with minUsn=0 so server sends all items)
    await SELF.fetch(
      syncRequest("start", { minUsn: 0, lnewer: false }, { syncKey: hostKey, sessionKey })
    );

    // Get chunk
    const chunkRes = await SELF.fetch(
      syncRequest("chunk", null, { syncKey: hostKey, sessionKey })
    );
    expect(chunkRes.status).toBe(200);

    const chunk = await chunkRes.json() as { done: boolean; cards?: unknown[][]; notes?: unknown[][]; revlog?: unknown[][] };
    // With minUsn=0, server should send all items
    expect(chunk.cards).toBeDefined();
    expect(chunk.notes).toBeDefined();

    // Second chunk call should return done
    const chunk2Res = await SELF.fetch(
      syncRequest("chunk", null, { syncKey: hostKey, sessionKey })
    );
    const chunk2 = await chunk2Res.json() as { done: boolean };
    expect(chunk2.done).toBe(true);
  });

  it("applyChunk applies client's card and note changes", async () => {
    const sessionKey = "incr-session-5";

    // Start
    await SELF.fetch(
      syncRequest("start", { minUsn: 0, lnewer: true }, { syncKey: hostKey, sessionKey })
    );

    // Send a chunk with a new note and card from client
    const now = Math.floor(Date.now() / 1000);
    const clientChunk = {
      chunk: {
        done: true,
        notes: [
          // [id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data]
          [500, "guid500", 1234567890, now, -1, " vocab ", "Apple\x1fManzana", "Apple", "", 0, ""]
        ],
        cards: [
          // [id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data]
          [600, 500, 1000, 0, now, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ""]
        ],
        revlog: [],
      }
    };

    const res = await SELF.fetch(
      syncRequest("applyChunk", clientChunk, { syncKey: hostKey, sessionKey })
    );
    expect(res.status).toBe(200);

    // Verify the note and card were added to the collection
    const { loadCollection } = await import("../src/anki-collection");
    const db = await loadCollection(env);
    try {
      const notes = db!.exec("SELECT id, flds FROM notes WHERE id = 500");
      expect(notes.length).toBe(1);
      expect(notes[0].values[0][1]).toBe("Apple\x1fManzana");

      const cards = db!.exec("SELECT id, nid FROM cards WHERE id = 600");
      expect(cards.length).toBe(1);
      expect(cards[0].values[0][1]).toBe(500);
    } finally {
      db!.close();
    }
  });

  it("sanityCheck returns ok when counts match", async () => {
    const sessionKey = "incr-session-6";

    // Start
    await SELF.fetch(
      syncRequest("start", { minUsn: 0, lnewer: false }, { syncKey: hostKey, sessionKey })
    );

    // Get the actual counts from the server collection
    const { loadCollection } = await import("../src/anki-collection");
    const db = await loadCollection(env);
    let cardCount: number, noteCount: number, revlogCount: number;
    try {
      cardCount = db!.exec("SELECT COUNT(*) FROM cards")[0].values[0][0] as number;
      noteCount = db!.exec("SELECT COUNT(*) FROM notes")[0].values[0][0] as number;
      revlogCount = db!.exec("SELECT COUNT(*) FROM revlog")[0].values[0][0] as number;
    } finally {
      db!.close();
    }

    // Send matching counts
    const sanityReq = {
      client: [[0, 0, 0], cardCount, noteCount, revlogCount, 0, 1, 2, 1]
    };

    const res = await SELF.fetch(
      syncRequest("sanityCheck2", sanityReq, { syncKey: hostKey, sessionKey })
    );
    expect(res.status).toBe(200);
    const result = await res.json() as { status: string };
    expect(result.status).toBe("ok");
  });

  it("sanityCheck returns bad when counts mismatch", async () => {
    const sessionKey = "incr-session-7";

    // Start
    await SELF.fetch(
      syncRequest("start", { minUsn: 0, lnewer: false }, { syncKey: hostKey, sessionKey })
    );

    // Send wrong counts
    const sanityReq = {
      client: [[0, 0, 0], 999, 999, 999, 0, 1, 2, 1]
    };

    const res = await SELF.fetch(
      syncRequest("sanityCheck2", sanityReq, { syncKey: hostKey, sessionKey })
    );
    expect(res.status).toBe(200);
    const result = await res.json() as { status: string; c: unknown; s: unknown };
    expect(result.status).toBe("bad");
    expect(result.c).toBeDefined();
    expect(result.s).toBeDefined();
  });

  it("finish increments USN and updates D1", async () => {
    const sessionKey = "incr-session-8";

    // Start
    await SELF.fetch(
      syncRequest("start", { minUsn: 0, lnewer: false }, { syncKey: hostKey, sessionKey })
    );

    // Finish
    const res = await SELF.fetch(
      syncRequest("finish", null, { syncKey: hostKey, sessionKey })
    );
    expect(res.status).toBe(200);
    const timestamp = await res.json() as number;
    expect(timestamp).toBeGreaterThan(0);

    // Verify USN was incremented in the collection
    const { loadCollection } = await import("../src/anki-collection");
    const db = await loadCollection(env);
    try {
      const col = db!.exec("SELECT usn FROM col LIMIT 1");
      expect(col[0].values[0][0]).toBe(1); // incremented from 0 to 1
    } finally {
      db!.close();
    }

    // Verify D1 was refreshed
    const d1Cards = await env.DB.prepare("SELECT COUNT(*) as cnt FROM cards").first();
    expect(d1Cards?.cnt).toBe(2);
  });

  it("abort cleans up the sync session", async () => {
    const sessionKey = "incr-session-9";

    // Start
    await SELF.fetch(
      syncRequest("start", { minUsn: 0, lnewer: false }, { syncKey: hostKey, sessionKey })
    );

    // Verify session exists
    const session = await env.DB.prepare("SELECT * FROM sync_session WHERE session_key = ?").bind(sessionKey).first();
    expect(session).not.toBeNull();

    // Abort
    const res = await SELF.fetch(
      syncRequest("abort", null, { syncKey: hostKey, sessionKey })
    );
    expect(res.status).toBe(200);

    // Verify session is cleaned up
    const sessionAfter = await env.DB.prepare("SELECT * FROM sync_session WHERE session_key = ?").bind(sessionKey).first();
    expect(sessionAfter).toBeNull();
  });
});

// ─── Full incremental sync flow (end-to-end) ───

describe("Full incremental sync flow (e2e)", () => {
  let hostKey: string;

  beforeEach(async () => {
    hostKey = await authenticate();
    await uploadTestCollection(hostKey);
  });

  it("completes a full incremental sync cycle", async () => {
    const sessionKey = "e2e-session-1";

    // 1. Start
    const startRes = await SELF.fetch(
      syncRequest("start", { minUsn: 0, lnewer: true }, { syncKey: hostKey, sessionKey })
    );
    expect(startRes.status).toBe(200);

    // 2. Apply graves (empty)
    const gravesRes = await SELF.fetch(
      syncRequest("applyGraves", { graves: { cards: [], decks: [], notes: [] } }, { syncKey: hostKey, sessionKey })
    );
    expect(gravesRes.status).toBe(200);

    // 3. Apply changes
    const changesRes = await SELF.fetch(
      syncRequest("applyChanges", {
        changes: { models: [], decks: [[], []], tags: [] }
      }, { syncKey: hostKey, sessionKey })
    );
    expect(changesRes.status).toBe(200);

    // 4. Get server chunks
    const chunkRes = await SELF.fetch(
      syncRequest("chunk", null, { syncKey: hostKey, sessionKey })
    );
    expect(chunkRes.status).toBe(200);
    const chunk = await chunkRes.json() as { done: boolean };
    expect(chunk.done).toBe(true); // small collection, fits in one chunk

    // 5. Send client chunk (new card)
    const now = Math.floor(Date.now() / 1000);
    const applyChunkRes = await SELF.fetch(
      syncRequest("applyChunk", {
        chunk: {
          done: true,
          notes: [
            [700, "guid700", 1234567890, now, -1, "", "New\x1fCard", "New", "", 0, ""]
          ],
          cards: [
            [800, 700, 1000, 0, now, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ""]
          ],
          revlog: [],
        }
      }, { syncKey: hostKey, sessionKey })
    );
    expect(applyChunkRes.status).toBe(200);

    // 6. Sanity check
    const { loadCollection } = await import("../src/anki-collection");
    let db = await loadCollection(env);
    let cardCount: number, noteCount: number, revlogCount: number;
    try {
      cardCount = db!.exec("SELECT COUNT(*) FROM cards")[0].values[0][0] as number;
      noteCount = db!.exec("SELECT COUNT(*) FROM notes")[0].values[0][0] as number;
      revlogCount = db!.exec("SELECT COUNT(*) FROM revlog")[0].values[0][0] as number;
    } finally {
      db!.close();
    }

    const sanityRes = await SELF.fetch(
      syncRequest("sanityCheck2", {
        client: [[0, 0, 0], cardCount, noteCount, revlogCount, 0, 1, 2, 1]
      }, { syncKey: hostKey, sessionKey })
    );
    expect(sanityRes.status).toBe(200);
    const sanity = await sanityRes.json() as { status: string };
    expect(sanity.status).toBe("ok");

    // 7. Finish
    const finishRes = await SELF.fetch(
      syncRequest("finish", null, { syncKey: hostKey, sessionKey })
    );
    expect(finishRes.status).toBe(200);

    // Verify: the new card should be in D1
    const d1Cards = await env.DB.prepare("SELECT COUNT(*) as cnt FROM cards").first();
    expect(d1Cards?.cnt).toBe(3); // 2 original + 1 new

    // Verify: the new note should be in D1
    const d1Notes = await env.DB.prepare("SELECT COUNT(*) as cnt FROM notes").first();
    expect(d1Notes?.cnt).toBe(3); // 2 original + 1 new

    // Verify: USN incremented
    db = await loadCollection(env);
    try {
      const col = db!.exec("SELECT usn FROM col LIMIT 1");
      expect(col[0].values[0][0]).toBe(1);
    } finally {
      db!.close();
    }
  });

  it("handles card deletion during incremental sync", async () => {
    const sessionKey = "e2e-session-2";

    // Start
    await SELF.fetch(
      syncRequest("start", { minUsn: 0, lnewer: true }, { syncKey: hostKey, sessionKey })
    );

    // Delete card 200 via graves
    await SELF.fetch(
      syncRequest("applyGraves", { graves: { cards: [200], decks: [], notes: [] } }, { syncKey: hostKey, sessionKey })
    );

    // Skip rest of sync, just finish
    await SELF.fetch(
      syncRequest("applyChanges", {
        changes: { models: [], decks: [[], []], tags: [] }
      }, { syncKey: hostKey, sessionKey })
    );

    // Get chunks
    await SELF.fetch(
      syncRequest("chunk", null, { syncKey: hostKey, sessionKey })
    );

    // Sanity check with updated counts
    const { loadCollection } = await import("../src/anki-collection");
    let db = await loadCollection(env);
    let cardCount: number, noteCount: number, revlogCount: number;
    try {
      cardCount = db!.exec("SELECT COUNT(*) FROM cards")[0].values[0][0] as number;
      noteCount = db!.exec("SELECT COUNT(*) FROM notes")[0].values[0][0] as number;
      revlogCount = db!.exec("SELECT COUNT(*) FROM revlog")[0].values[0][0] as number;
    } finally {
      db!.close();
    }

    await SELF.fetch(
      syncRequest("sanityCheck2", {
        client: [[0, 0, 0], cardCount, noteCount, revlogCount, 1, 1, 2, 1]
      }, { syncKey: hostKey, sessionKey })
    );

    // Finish
    await SELF.fetch(
      syncRequest("finish", null, { syncKey: hostKey, sessionKey })
    );

    // Verify card 200 is gone from D1
    const d1Card = await env.DB.prepare("SELECT * FROM cards WHERE id = 200").first();
    expect(d1Card).toBeNull();

    // Verify remaining card is still there
    const d1Remaining = await env.DB.prepare("SELECT COUNT(*) as cnt FROM cards").first();
    expect(d1Remaining?.cnt).toBe(1);
  });

  it("handles note deletion cascading to cards", async () => {
    const sessionKey = "e2e-session-cascade";

    // Start
    await SELF.fetch(
      syncRequest("start", { minUsn: 0, lnewer: true }, { syncKey: hostKey, sessionKey })
    );

    // Delete note 100 via graves (should cascade delete its card 200)
    await SELF.fetch(
      syncRequest("applyGraves", { graves: { cards: [], decks: [], notes: [100] } }, { syncKey: hostKey, sessionKey })
    );

    // Verify note and its card are deleted
    const { loadCollection } = await import("../src/anki-collection");
    const db = await loadCollection(env);
    try {
      const notes = db!.exec("SELECT COUNT(*) FROM notes WHERE id = 100");
      expect(notes[0].values[0][0]).toBe(0);
      const cards = db!.exec("SELECT COUNT(*) FROM cards WHERE nid = 100");
      expect(cards[0].values[0][0]).toBe(0);
    } finally {
      db!.close();
    }
  });

  it("handles deck deletion via graves", async () => {
    const sessionKey = "e2e-session-deck-del";

    // Start
    await SELF.fetch(
      syncRequest("start", { minUsn: 0, lnewer: true }, { syncKey: hostKey, sessionKey })
    );

    // Delete test deck 1000 via graves
    await SELF.fetch(
      syncRequest("applyGraves", { graves: { cards: [], decks: [1000], notes: [] } }, { syncKey: hostKey, sessionKey })
    );

    // Verify deck is removed from decks JSON and cards in that deck are deleted
    const { loadCollection } = await import("../src/anki-collection");
    const db = await loadCollection(env);
    try {
      const col = db!.exec("SELECT decks FROM col LIMIT 1");
      const decks = JSON.parse(col[0].values[0][0] as string);
      expect(decks["1000"]).toBeUndefined();
      // Cards that were in deck 1000 should be deleted
      const cards = db!.exec("SELECT COUNT(*) FROM cards WHERE did = 1000");
      expect(cards[0].values[0][0]).toBe(0);
    } finally {
      db!.close();
    }
  });

  it("applyGraves accepts 'chunk' field name per Anki protocol", async () => {
    const sessionKey = "e2e-session-chunk-field";

    // Start
    await SELF.fetch(
      syncRequest("start", { minUsn: 0, lnewer: true }, { syncKey: hostKey, sessionKey })
    );

    // Send graves using the "chunk" field name (what Anki actually sends)
    const gravesRes = await SELF.fetch(
      syncRequest("applyGraves", { chunk: { cards: [201], decks: [], notes: [] } }, { syncKey: hostKey, sessionKey })
    );
    expect(gravesRes.status).toBe(200);

    // Verify card 201 is deleted
    const { loadCollection } = await import("../src/anki-collection");
    const db = await loadCollection(env);
    try {
      const cards = db!.exec("SELECT COUNT(*) FROM cards WHERE id = 201");
      expect(cards[0].values[0][0]).toBe(0);
    } finally {
      db!.close();
    }
  });

  it("updates existing cards via applyChunk (upsert)", async () => {
    const sessionKey = "e2e-session-upsert";

    // Start
    await SELF.fetch(
      syncRequest("start", { minUsn: 0, lnewer: true }, { syncKey: hostKey, sessionKey })
    );

    // Update existing card 200: change interval from 21 to 42
    const now = Math.floor(Date.now() / 1000);
    const applyChunkRes = await SELF.fetch(
      syncRequest("applyChunk", {
        chunk: {
          done: true,
          notes: [],
          cards: [
            // Same card ID 200, but with updated interval (index 9 = ivl)
            [200, 100, 1000, 0, now, -1, 2, 2, 10, 42, 2500, 10, 1, 0, 0, 0, 0, ""]
          ],
          revlog: [],
        }
      }, { syncKey: hostKey, sessionKey })
    );
    expect(applyChunkRes.status).toBe(200);

    // Verify the card was updated (not duplicated)
    const { loadCollection } = await import("../src/anki-collection");
    const db = await loadCollection(env);
    try {
      const cards = db!.exec("SELECT ivl, reps, lapses FROM cards WHERE id = 200");
      expect(cards[0].values.length).toBe(1); // still just one card
      expect(cards[0].values[0][0]).toBe(42); // updated interval
      expect(cards[0].values[0][1]).toBe(10); // updated reps
      expect(cards[0].values[0][2]).toBe(1);  // updated lapses
    } finally {
      db!.close();
    }
  });

  it("handles model/notetype changes via applyChanges", async () => {
    const sessionKey = "e2e-session-models";

    // Start
    await SELF.fetch(
      syncRequest("start", { minUsn: 0, lnewer: true }, { syncKey: hostKey, sessionKey })
    );

    // Apply graves (empty)
    await SELF.fetch(
      syncRequest("applyGraves", { graves: { cards: [], decks: [], notes: [] } }, { syncKey: hostKey, sessionKey })
    );

    // Send a new model from client
    const newModel = {
      id: 9999999,
      name: "Cloze",
      mod: 0,
      usn: -1,
      flds: [{ name: "Text", ord: 0 }, { name: "Extra", ord: 1 }],
      tmpls: [{ name: "Cloze", qfmt: "{{cloze:Text}}", afmt: "{{cloze:Text}}<br>{{Extra}}", ord: 0 }],
      tags: [],
      did: 1,
      type: 1,
      css: "",
      sortf: 0,
    };

    const changesRes = await SELF.fetch(
      syncRequest("applyChanges", {
        changes: { models: [newModel], decks: [[], []], tags: ["cloze-tag"] }
      }, { syncKey: hostKey, sessionKey })
    );
    expect(changesRes.status).toBe(200);

    // Verify model was added
    const { loadCollection } = await import("../src/anki-collection");
    const db = await loadCollection(env);
    try {
      const col = db!.exec("SELECT models, tags FROM col LIMIT 1");
      const models = JSON.parse(col[0].values[0][0] as string);
      expect(models["9999999"]).toBeDefined();
      expect(models["9999999"].name).toBe("Cloze");
      // USN should be updated to server's USN
      expect(models["9999999"].usn).toBeGreaterThanOrEqual(0);

      const tags = JSON.parse(col[0].values[0][1] as string);
      expect(tags["cloze-tag"]).toBeDefined();
    } finally {
      db!.close();
    }
  });

  it("two consecutive incremental syncs work correctly", async () => {
    // First sync: add a card
    const session1 = "e2e-consec-1";
    await SELF.fetch(syncRequest("start", { minUsn: 0, lnewer: true }, { syncKey: hostKey, sessionKey: session1 }));
    await SELF.fetch(syncRequest("applyGraves", { graves: { cards: [], decks: [], notes: [] } }, { syncKey: hostKey, sessionKey: session1 }));
    await SELF.fetch(syncRequest("applyChanges", { changes: { models: [], decks: [[], []], tags: [] } }, { syncKey: hostKey, sessionKey: session1 }));
    await SELF.fetch(syncRequest("chunk", null, { syncKey: hostKey, sessionKey: session1 }));

    const now = Math.floor(Date.now() / 1000);
    await SELF.fetch(syncRequest("applyChunk", {
      chunk: {
        done: true,
        notes: [[300, "guid300", 1234567890, now, -1, "", "First\x1fSecond", "First", "", 0, ""]],
        cards: [[400, 300, 1000, 0, now, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ""]],
        revlog: [],
      }
    }, { syncKey: hostKey, sessionKey: session1 }));

    // Sanity check and finish first sync
    const { loadCollection } = await import("../src/anki-collection");
    let db = await loadCollection(env);
    let cc: number, nc: number, rc: number;
    try {
      cc = db!.exec("SELECT COUNT(*) FROM cards")[0].values[0][0] as number;
      nc = db!.exec("SELECT COUNT(*) FROM notes")[0].values[0][0] as number;
      rc = db!.exec("SELECT COUNT(*) FROM revlog")[0].values[0][0] as number;
    } finally { db!.close(); }

    await SELF.fetch(syncRequest("sanityCheck2", { client: [[0,0,0], cc, nc, rc, 0, 1, 2, 1] }, { syncKey: hostKey, sessionKey: session1 }));
    await SELF.fetch(syncRequest("finish", null, { syncKey: hostKey, sessionKey: session1 }));

    // Get new USN
    db = await loadCollection(env);
    let newUsn: number;
    try {
      newUsn = db!.exec("SELECT usn FROM col LIMIT 1")[0].values[0][0] as number;
    } finally { db!.close(); }
    expect(newUsn).toBe(1);

    // Second sync: add another card using the new USN
    const session2 = "e2e-consec-2";
    await SELF.fetch(syncRequest("start", { minUsn: 1, lnewer: true }, { syncKey: hostKey, sessionKey: session2 }));
    await SELF.fetch(syncRequest("applyGraves", { graves: { cards: [], decks: [], notes: [] } }, { syncKey: hostKey, sessionKey: session2 }));
    await SELF.fetch(syncRequest("applyChanges", { changes: { models: [], decks: [[], []], tags: [] } }, { syncKey: hostKey, sessionKey: session2 }));

    // Chunk should have no changes since we synced with minUsn=1
    const chunkRes = await SELF.fetch(syncRequest("chunk", null, { syncKey: hostKey, sessionKey: session2 }));
    const chunk = await chunkRes.json() as { done: boolean; cards?: unknown[]; notes?: unknown[] };
    expect(chunk.done).toBe(true);
    expect(chunk.cards).toBeUndefined();

    // Add another new card
    await SELF.fetch(syncRequest("applyChunk", {
      chunk: {
        done: true,
        notes: [[301, "guid301", 1234567890, now, -1, "", "Third\x1fFourth", "Third", "", 0, ""]],
        cards: [[401, 301, 1000, 0, now, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ""]],
        revlog: [],
      }
    }, { syncKey: hostKey, sessionKey: session2 }));

    db = await loadCollection(env);
    try {
      cc = db!.exec("SELECT COUNT(*) FROM cards")[0].values[0][0] as number;
      nc = db!.exec("SELECT COUNT(*) FROM notes")[0].values[0][0] as number;
      rc = db!.exec("SELECT COUNT(*) FROM revlog")[0].values[0][0] as number;
    } finally { db!.close(); }

    await SELF.fetch(syncRequest("sanityCheck2", { client: [[0,0,0], cc, nc, rc, 0, 1, 2, 1] }, { syncKey: hostKey, sessionKey: session2 }));
    await SELF.fetch(syncRequest("finish", null, { syncKey: hostKey, sessionKey: session2 }));

    // Verify: 4 cards total (2 original + 2 added)
    const d1Cards = await env.DB.prepare("SELECT COUNT(*) as cnt FROM cards").first();
    expect(d1Cards?.cnt).toBe(4);

    // Verify USN is now 2
    db = await loadCollection(env);
    try {
      const usn = db!.exec("SELECT usn FROM col LIMIT 1")[0].values[0][0] as number;
      expect(usn).toBe(2);
    } finally { db!.close(); }
  });

  it("subsequent sync with matching USN has no changes", async () => {
    // First sync to set USN
    const sessionKey1 = "e2e-session-3a";
    await SELF.fetch(syncRequest("start", { minUsn: 0, lnewer: false }, { syncKey: hostKey, sessionKey: sessionKey1 }));
    await SELF.fetch(syncRequest("applyGraves", { graves: { cards: [], decks: [], notes: [] } }, { syncKey: hostKey, sessionKey: sessionKey1 }));
    await SELF.fetch(syncRequest("applyChanges", { changes: { models: [], decks: [[], []], tags: [] } }, { syncKey: hostKey, sessionKey: sessionKey1 }));
    await SELF.fetch(syncRequest("chunk", null, { syncKey: hostKey, sessionKey: sessionKey1 }));
    await SELF.fetch(syncRequest("finish", null, { syncKey: hostKey, sessionKey: sessionKey1 }));

    // Now USN should be 1
    const { loadCollection } = await import("../src/anki-collection");
    const db = await loadCollection(env);
    let currentUsn: number;
    try {
      currentUsn = db!.exec("SELECT usn FROM col LIMIT 1")[0].values[0][0] as number;
    } finally {
      db!.close();
    }
    expect(currentUsn).toBe(1);

    // Second sync with minUsn = 1 (up to date)
    const sessionKey2 = "e2e-session-3b";
    const startRes = await SELF.fetch(
      syncRequest("start", { minUsn: 1, lnewer: false }, { syncKey: hostKey, sessionKey: sessionKey2 })
    );
    const graves = await startRes.json() as { cards: number[]; decks: number[]; notes: number[] };
    expect(graves.cards).toEqual([]);

    // Chunk should have no changes (everything has USN < 1)
    await SELF.fetch(syncRequest("applyGraves", { graves: { cards: [], decks: [], notes: [] } }, { syncKey: hostKey, sessionKey: sessionKey2 }));
    await SELF.fetch(syncRequest("applyChanges", { changes: { models: [], decks: [[], []], tags: [] } }, { syncKey: hostKey, sessionKey: sessionKey2 }));

    const chunkRes = await SELF.fetch(
      syncRequest("chunk", null, { syncKey: hostKey, sessionKey: sessionKey2 })
    );
    const chunk = await chunkRes.json() as { done: boolean; cards?: unknown[]; notes?: unknown[] };
    expect(chunk.done).toBe(true);
    // No items should be sent since all items have USN 0 < minUsn 1
    expect(chunk.cards).toBeUndefined();
    expect(chunk.notes).toBeUndefined();
  });
});
