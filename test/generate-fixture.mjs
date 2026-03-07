#!/usr/bin/env node
/**
 * Generate test .apkg fixture files.
 * Run: node test/generate-fixture.mjs
 */
import { zipSync } from "fflate";
import initSqlJs from "sql.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function buildApkg(deckName, cards) {
  return initSqlJs().then((SQL) => {
    const db = new SQL.Database();

    db.run(`CREATE TABLE col (id INTEGER PRIMARY KEY, crt INTEGER, mod INTEGER, scm INTEGER, ver INTEGER, dty INTEGER, usn INTEGER, ls INTEGER, conf TEXT, models TEXT, decks TEXT, dconf TEXT, tags TEXT)`);
    db.run(`CREATE TABLE notes (id INTEGER PRIMARY KEY, guid TEXT, mid INTEGER, mod INTEGER, usn INTEGER, tags TEXT, flds TEXT, sfld TEXT, csum INTEGER, flags INTEGER, data TEXT)`);
    db.run(`CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER, ord INTEGER, mod INTEGER, usn INTEGER, type INTEGER, queue INTEGER, due INTEGER, ivl INTEGER, factor INTEGER, reps INTEGER, lapses INTEGER, left INTEGER, odue INTEGER, odid INTEGER, flags INTEGER, data TEXT)`);

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

    cards.forEach((card, i) => {
      const noteId = 1000 + i;
      const cardId = 2000 + i;
      db.run(
        `INSERT INTO notes VALUES (?, ?, ?, 0, 0, '', ?, ?, 0, 0, '')`,
        [noteId, `guid${i}`, modelId, `${card.front}\x1f${card.back}`, card.front]
      );
      db.run(
        `INSERT INTO cards VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '')`,
        [cardId, noteId, deckId]
      );
    });

    const dbData = db.export();
    db.close();
    return zipSync({ "collection.anki21": dbData });
  });
}

async function main() {
  const fixtureDir = join(__dirname, "fixtures");
  mkdirSync(fixtureDir, { recursive: true });

  const spanish = await buildApkg("Spanish Vocab", [
    { front: "hola", back: "hello" },
    { front: "gato", back: "cat" },
    { front: "perro", back: "dog" },
  ]);
  writeFileSync(join(fixtureDir, "spanish.apkg"), spanish);

  const simple = await buildApkg("Test Deck", [
    { front: "What is 2+2?", back: "4" },
    { front: "Capital of France?", back: "Paris" },
  ]);
  writeFileSync(join(fixtureDir, "simple.apkg"), simple);

  // Invalid zip - just garbage bytes
  writeFileSync(join(fixtureDir, "invalid.bin"), Buffer.from("not a zip file"));

  // Valid zip but no collection db
  const noDb = zipSync({ "readme.txt": new TextEncoder().encode("hi") });
  writeFileSync(join(fixtureDir, "no-collection.zip"), noDb);

  console.log("Fixtures generated in test/fixtures/");
}

main().catch(console.error);
