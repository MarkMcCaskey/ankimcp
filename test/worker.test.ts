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
import { spanish_apkg } from "./helpers";

// Apply schema before each test - D1 exec only handles one statement at a time
beforeEach(async () => {
  await env.DB.exec("CREATE TABLE IF NOT EXISTS decks (id TEXT PRIMARY KEY, name TEXT NOT NULL, card_count INTEGER DEFAULT 0, uploaded_at TEXT DEFAULT (datetime('now')))");
  await env.DB.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, deck_id TEXT NOT NULL, model_name TEXT, fields TEXT NOT NULL, field_names TEXT NOT NULL, tags TEXT DEFAULT '')");
  await env.DB.exec("CREATE TABLE IF NOT EXISTS cards (id INTEGER PRIMARY KEY, note_id INTEGER NOT NULL, deck_id TEXT NOT NULL, ord INTEGER DEFAULT 0)");
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
    const res = await SELF.fetch("https://fake.host/upload", {
      method: "POST",
    });
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

  it("successfully uploads and parses an .apkg file", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File([spanish_apkg], "spanish.apkg", {
        type: "application/octet-stream",
      })
    );

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
    };
    expect(body.success).toBe(true);
    expect(body.r2Key).toMatch(/^uploads\//);
    expect(body.decks).toHaveLength(1);
    expect(body.decks[0].name).toBe("Spanish Vocab");
    expect(body.decks[0].cards).toBe(3);

    // Verify data was inserted into D1
    const deckResult = await env.DB.prepare("SELECT * FROM decks").all();
    expect(deckResult.results).toHaveLength(1);
    expect(deckResult.results[0].name).toBe("Spanish Vocab");

    const noteResult = await env.DB.prepare("SELECT * FROM notes").all();
    expect(noteResult.results).toHaveLength(3);

    const cardResult = await env.DB.prepare("SELECT * FROM cards").all();
    expect(cardResult.results).toHaveLength(3);

    // Verify R2 storage
    const objects = await env.BUCKET.list();
    expect(objects.objects).toHaveLength(1);
  });
});

describe("Query endpoints (after upload)", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      "INSERT INTO decks (id, name, card_count) VALUES (?, ?, ?)"
    ).bind("d1", "Japanese N5", 2).run();

    await env.DB.prepare(
      "INSERT INTO notes (id, deck_id, model_name, fields, field_names, tags) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(101, "d1", "Basic", '["犬","dog"]', '["Front","Back"]', "animal").run();

    await env.DB.prepare(
      "INSERT INTO notes (id, deck_id, model_name, fields, field_names, tags) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(102, "d1", "Basic", '["猫","cat"]', '["Front","Back"]', "animal").run();

    await env.DB.prepare(
      "INSERT INTO cards (id, note_id, deck_id, ord) VALUES (?, ?, ?, ?)"
    ).bind(201, 101, "d1", 0).run();

    await env.DB.prepare(
      "INSERT INTO cards (id, note_id, deck_id, ord) VALUES (?, ?, ?, ?)"
    ).bind(202, 102, "d1", 0).run();
  });

  it("has correct data in D1 after seeding", async () => {
    const decks = await env.DB.prepare("SELECT * FROM decks").all();
    expect(decks.results).toHaveLength(1);

    const cards = await env.DB.prepare(
      "SELECT c.id as card_id, n.fields, n.field_names, d.name as deck_name FROM cards c JOIN notes n ON c.note_id = n.id JOIN decks d ON c.deck_id = d.id WHERE d.name LIKE ? ORDER BY c.id LIMIT 50 OFFSET 0"
    ).bind("%Japanese%").all();

    expect(cards.results).toHaveLength(2);
    const firstCard = cards.results[0];
    expect(firstCard.deck_name).toBe("Japanese N5");
    const fields = JSON.parse(firstCard.fields as string);
    expect(fields).toEqual(["犬", "dog"]);
  });

  it("search query works across fields", async () => {
    const result = await env.DB.prepare(
      "SELECT c.id as card_id, n.fields, d.name as deck_name FROM cards c JOIN notes n ON c.note_id = n.id JOIN decks d ON c.deck_id = d.id WHERE n.fields LIKE ? ORDER BY c.id LIMIT 20"
    ).bind("%dog%").all();

    expect(result.results).toHaveLength(1);
    expect(result.results[0].card_id).toBe(201);
  });

  it("search with no results returns empty", async () => {
    const result = await env.DB.prepare(
      "SELECT c.id as card_id FROM cards c JOIN notes n ON c.note_id = n.id WHERE n.fields LIKE ? LIMIT 20"
    ).bind("%nonexistent%").all();

    expect(result.results).toHaveLength(0);
  });
});
