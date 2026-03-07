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
import { spanish_apkg, simple_apkg } from "./helpers";

// Apply schema before each test - D1 exec only handles one statement at a time
beforeEach(async () => {
  await env.DB.exec("CREATE TABLE IF NOT EXISTS decks (id TEXT PRIMARY KEY, name TEXT NOT NULL, card_count INTEGER DEFAULT 0, uploaded_at TEXT DEFAULT (datetime('now')))");
  await env.DB.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, deck_id TEXT NOT NULL, model_name TEXT, fields TEXT NOT NULL, field_names TEXT NOT NULL, tags TEXT DEFAULT '')");
  await env.DB.exec("CREATE TABLE IF NOT EXISTS cards (id INTEGER PRIMARY KEY, note_id INTEGER NOT NULL, deck_id TEXT NOT NULL, ord INTEGER DEFAULT 0, type INTEGER DEFAULT 0, queue INTEGER DEFAULT 0, due INTEGER DEFAULT 0, ivl INTEGER DEFAULT 0, factor INTEGER DEFAULT 0, reps INTEGER DEFAULT 0, lapses INTEGER DEFAULT 0, flags INTEGER DEFAULT 0)");
  await env.DB.exec("CREATE TABLE IF NOT EXISTS revlog (id INTEGER PRIMARY KEY, card_id INTEGER NOT NULL, ease INTEGER NOT NULL, ivl INTEGER NOT NULL, last_ivl INTEGER NOT NULL, factor INTEGER NOT NULL, review_time INTEGER NOT NULL, type INTEGER NOT NULL)");
  await env.DB.exec("DELETE FROM revlog");
  await env.DB.exec("DELETE FROM cards");
  await env.DB.exec("DELETE FROM notes");
  await env.DB.exec("DELETE FROM decks");
});

describe("Health check", () => {
  it("GET / returns ok", async () => {
    const res = await SELF.fetch("https://fake.host/");
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("ankimcp");
  });

  it("GET /health returns ok", async () => {
    const res = await SELF.fetch("https://fake.host/health");
    expect(res.status).toBe(200);
  });
});

describe("404 for unknown routes", () => {
  it("returns 404 for random path", async () => {
    const res = await SELF.fetch("https://fake.host/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("Upload endpoint", () => {
  it("rejects requests without auth", async () => {
    const res = await SELF.fetch("https://fake.host/upload", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("rejects requests with wrong token", async () => {
    const res = await SELF.fetch("https://fake.host/upload", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects non-.apkg files", async () => {
    const form = new FormData();
    form.append("file", new File(["data"], "notes.txt", { type: "text/plain" }));
    const res = await SELF.fetch("https://fake.host/upload", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret-token" },
      body: form,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(".apkg");
  });

  it("rejects requests with no file", async () => {
    const form = new FormData();
    const res = await SELF.fetch("https://fake.host/upload", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret-token" },
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it("uploads and stores scheduling data + review history", async () => {
    const form = new FormData();
    form.append("file", new File([spanish_apkg], "spanish.apkg", { type: "application/octet-stream" }));

    const res = await SELF.fetch("https://fake.host/upload", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret-token" },
      body: form,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean;
      r2Key: string;
      decks: Array<{ name: string; notes: number; cards: number }>;
      reviewCount: number;
    };
    expect(body.success).toBe(true);
    expect(body.decks[0].name).toBe("Spanish Vocab");
    expect(body.decks[0].cards).toBe(3);
    expect(body.reviewCount).toBe(9);

    // Verify cards have scheduling data
    const cardResult = await env.DB.prepare("SELECT * FROM cards WHERE ivl > 0").all();
    expect(cardResult.results.length).toBeGreaterThan(0);

    // Verify review history
    const revResult = await env.DB.prepare("SELECT * FROM revlog").all();
    expect(revResult.results).toHaveLength(9);
  });
});

describe("Sync endpoint", () => {
  it("rejects requests without auth", async () => {
    const res = await SELF.fetch("https://fake.host/sync", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("merges data without deleting existing decks", async () => {
    // Seed an existing deck
    await env.DB.prepare("INSERT INTO decks (id, name, card_count) VALUES (?, ?, ?)")
      .bind("existing-deck", "Existing Deck", 1).run();
    await env.DB.prepare("INSERT INTO notes (id, deck_id, model_name, fields, field_names, tags) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(999, "existing-deck", "Basic", '["old front","old back"]', '["Front","Back"]', "").run();
    await env.DB.prepare("INSERT INTO cards (id, note_id, deck_id, ord) VALUES (?, ?, ?, ?)")
      .bind(999, 999, "existing-deck", 0).run();

    const form = new FormData();
    form.append("file", new File([spanish_apkg], "spanish.apkg", { type: "application/octet-stream" }));

    const res = await SELF.fetch("https://fake.host/sync", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret-token" },
      body: form,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean;
      totals: { notesUpserted: number; cardsUpserted: number; reviewsImported: number };
    };
    expect(body.success).toBe(true);
    expect(body.totals.notesUpserted).toBe(3);
    expect(body.totals.reviewsImported).toBe(9);

    // Existing deck preserved
    const deckResult = await env.DB.prepare("SELECT * FROM decks ORDER BY name").all();
    expect(deckResult.results).toHaveLength(2);
    expect(deckResult.results.map((d) => d.name)).toContain("Existing Deck");
    expect(deckResult.results.map((d) => d.name)).toContain("Spanish Vocab");
  });

  it("upserts without duplicating on re-sync", async () => {
    const form1 = new FormData();
    form1.append("file", new File([simple_apkg], "simple.apkg", { type: "application/octet-stream" }));
    await SELF.fetch("https://fake.host/sync", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret-token" },
      body: form1,
    });

    const notesBefore = await env.DB.prepare("SELECT * FROM notes").all();
    expect(notesBefore.results).toHaveLength(2);

    const form2 = new FormData();
    form2.append("file", new File([simple_apkg], "simple.apkg", { type: "application/octet-stream" }));
    await SELF.fetch("https://fake.host/sync", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret-token" },
      body: form2,
    });

    const notesAfter = await env.DB.prepare("SELECT * FROM notes").all();
    expect(notesAfter.results).toHaveLength(2);
  });
});

describe("Query data (after upload)", () => {
  beforeEach(async () => {
    await env.DB.prepare("INSERT INTO decks (id, name, card_count) VALUES (?, ?, ?)")
      .bind("d1", "Japanese N5", 2).run();

    await env.DB.prepare("INSERT INTO notes (id, deck_id, model_name, fields, field_names, tags) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(101, "d1", "Basic", '["犬","dog"]', '["Front","Back"]', "animal").run();
    await env.DB.prepare("INSERT INTO notes (id, deck_id, model_name, fields, field_names, tags) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(102, "d1", "Basic", '["猫","cat"]', '["Front","Back"]', "animal").run();

    await env.DB.prepare("INSERT INTO cards (id, note_id, deck_id, ord, type, ivl, factor, reps, lapses) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(201, 101, "d1", 0, 2, 21, 2500, 10, 1).run();
    await env.DB.prepare("INSERT INTO cards (id, note_id, deck_id, ord, type, ivl, factor, reps, lapses) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(202, 102, "d1", 0, 2, 7, 1800, 5, 3).run();

    // Add review history
    const now = Date.now();
    await env.DB.prepare("INSERT INTO revlog (id, card_id, ease, ivl, last_ivl, factor, review_time, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(now - 86400000, 201, 3, 21, 10, 2500, 5000, 1).run();
    await env.DB.prepare("INSERT INTO revlog (id, card_id, ease, ivl, last_ivl, factor, review_time, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(now - 172800000, 202, 1, -600, 7, 1800, 8000, 1).run();
    await env.DB.prepare("INSERT INTO revlog (id, card_id, ease, ivl, last_ivl, factor, review_time, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(now, 202, 3, 7, 1, 1800, 3000, 2).run();
  });

  it("joins cards with notes and decks", async () => {
    const cards = await env.DB.prepare(
      "SELECT c.id as card_id, c.ivl, c.lapses, n.fields, d.name as deck_name FROM cards c JOIN notes n ON c.note_id = n.id JOIN decks d ON c.deck_id = d.id WHERE d.name LIKE ? ORDER BY c.id"
    ).bind("%Japanese%").all();

    expect(cards.results).toHaveLength(2);
    expect(cards.results[0].deck_name).toBe("Japanese N5");
    expect(cards.results[0].ivl).toBe(21);
  });

  it("can query cards sorted by lapses (difficulty)", async () => {
    const result = await env.DB.prepare(
      "SELECT c.id, c.lapses FROM cards c WHERE c.lapses > 0 ORDER BY c.lapses DESC"
    ).all();

    expect(result.results).toHaveLength(2);
    expect(result.results[0].id).toBe(202); // 猫 has more lapses
    expect(result.results[0].lapses).toBe(3);
  });

  it("can query review history", async () => {
    const result = await env.DB.prepare(
      "SELECT r.ease, r.ivl, r.card_id FROM revlog r ORDER BY r.id ASC"
    ).all();

    expect(result.results).toHaveLength(3);
  });

  it("search query works across fields", async () => {
    const result = await env.DB.prepare(
      "SELECT c.id as card_id FROM cards c JOIN notes n ON c.note_id = n.id WHERE n.fields LIKE ? LIMIT 20"
    ).bind("%dog%").all();

    expect(result.results).toHaveLength(1);
    expect(result.results[0].card_id).toBe(201);
  });
});
