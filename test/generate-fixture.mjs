#!/usr/bin/env node
/**
 * Generate test .apkg fixture files with scheduling data and review history.
 * Run: node test/generate-fixture.mjs
 */
import { zipSync } from "fflate";
import initSqlJs from "sql.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function buildApkg(deckName, cards, opts = {}) {
  return initSqlJs().then((SQL) => {
    const db = new SQL.Database();

    db.run(`CREATE TABLE col (id INTEGER PRIMARY KEY, crt INTEGER, mod INTEGER, scm INTEGER, ver INTEGER, dty INTEGER, usn INTEGER, ls INTEGER, conf TEXT, models TEXT, decks TEXT, dconf TEXT, tags TEXT)`);
    db.run(`CREATE TABLE notes (id INTEGER PRIMARY KEY, guid TEXT, mid INTEGER, mod INTEGER, usn INTEGER, tags TEXT, flds TEXT, sfld TEXT, csum INTEGER, flags INTEGER, data TEXT)`);
    db.run(`CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER, ord INTEGER, mod INTEGER, usn INTEGER, type INTEGER, queue INTEGER, due INTEGER, ivl INTEGER, factor INTEGER, reps INTEGER, lapses INTEGER, left INTEGER, odue INTEGER, odid INTEGER, flags INTEGER, data TEXT)`);
    db.run(`CREATE TABLE revlog (id INTEGER PRIMARY KEY, cid INTEGER, usn INTEGER, ease INTEGER, ivl INTEGER, lastIvl INTEGER, factor INTEGER, time INTEGER, type INTEGER)`);

    const deckId = 1234567890;
    const modelId = 9876543210;

    const decks = JSON.stringify({ [deckId]: { name: deckName, id: deckId } });
    const models = JSON.stringify({
      [modelId]: { name: "Basic", id: modelId, flds: [{ name: "Front" }, { name: "Back" }] },
    });

    db.run(
      `INSERT INTO col VALUES (1, 0, 0, 0, 11, 0, 0, 0, '{}', ?, ?, '{}', '{}')`,
      [models, decks]
    );

    const baseTime = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago

    cards.forEach((card, i) => {
      const noteId = 1000 + i;
      const cardId = 2000 + i;
      const tags = card.tags || "";
      const type = card.type ?? 0;
      const ivl = card.ivl ?? 0;
      const factor = card.factor ?? 0;
      const reps = card.reps ?? 0;
      const lapses = card.lapses ?? 0;

      db.run(
        `INSERT INTO notes VALUES (?, ?, ?, 0, 0, ?, ?, ?, 0, 0, '')`,
        [noteId, `guid${i}`, modelId, tags, `${card.front}\x1f${card.back}`, card.front]
      );
      db.run(
        `INSERT INTO cards VALUES (?, ?, ?, 0, 0, 0, ?, 0, 0, ?, ?, ?, ?, 0, 0, 0, 0, '')`,
        [cardId, noteId, deckId, type, ivl, factor, reps, lapses]
      );

      // Generate review history for this card
      if (card.reviews) {
        card.reviews.forEach((rev, ri) => {
          const revId = baseTime + i * 100000 + ri * 86400000; // spread reviews across days
          db.run(
            `INSERT INTO revlog VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)`,
            [revId, cardId, rev.ease, rev.ivl ?? 1, rev.lastIvl ?? 0, rev.factor ?? 2500, rev.time ?? 5000, rev.type ?? 1]
          );
        });
      }
    });

    const dbData = db.export();
    db.close();
    return zipSync({ "collection.anki21": dbData });
  });
}

async function main() {
  const fixtureDir = join(__dirname, "fixtures");
  mkdirSync(fixtureDir, { recursive: true });

  // Spanish deck with study history
  const spanish = await buildApkg("Spanish Vocab", [
    {
      front: "hola", back: "hello", type: 2, ivl: 21, factor: 2500, reps: 8, lapses: 0,
      reviews: [
        { ease: 3, ivl: 1, lastIvl: 0, factor: 2500, type: 0 },
        { ease: 3, ivl: 3, lastIvl: 1, factor: 2500, type: 1 },
        { ease: 4, ivl: 10, lastIvl: 3, factor: 2650, type: 1 },
        { ease: 3, ivl: 21, lastIvl: 10, factor: 2650, type: 1 },
      ],
    },
    {
      front: "gato", back: "cat", type: 2, ivl: 7, factor: 2100, reps: 6, lapses: 2,
      reviews: [
        { ease: 3, ivl: 1, lastIvl: 0, factor: 2500, type: 0 },
        { ease: 1, ivl: -600, lastIvl: 1, factor: 2300, type: 1 },
        { ease: 3, ivl: 3, lastIvl: 1, factor: 2300, type: 2 },
        { ease: 1, ivl: -600, lastIvl: 3, factor: 2100, type: 1 },
        { ease: 3, ivl: 7, lastIvl: 1, factor: 2100, type: 2 },
      ],
    },
    {
      front: "perro", back: "dog", type: 0, ivl: 0, factor: 0, reps: 0, lapses: 0,
      tags: "animals",
    },
  ]);
  writeFileSync(join(fixtureDir, "spanish.apkg"), spanish);

  // Simple deck (no review history)
  const simple = await buildApkg("Test Deck", [
    { front: "What is 2+2?", back: "4" },
    { front: "Capital of France?", back: "Paris" },
  ]);
  writeFileSync(join(fixtureDir, "simple.apkg"), simple);

  // Invalid zip
  writeFileSync(join(fixtureDir, "invalid.bin"), Buffer.from("not a zip file"));

  // Valid zip but no collection db
  const noDb = zipSync({ "readme.txt": new TextEncoder().encode("hi") });
  writeFileSync(join(fixtureDir, "no-collection.zip"), noDb);

  console.log("Fixtures generated in test/fixtures/");
}

main().catch(console.error);
