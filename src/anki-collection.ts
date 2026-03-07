/**
 * Helpers for loading/saving the Anki SQLite collection from/to R2,
 * and operating on it with sql.js.
 *
 * The Anki sync protocol always uses "schema 11" format:
 * - col table: id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags
 * - notes table: id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data
 * - cards table: id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data
 * - revlog table: id, cid, usn, ease, ivl, lastIvl, factor, time, type
 * - graves table: usn, oid, type
 */
import "./polyfills";
// @ts-expect-error -- no types for asm build
import initSqlJs from "sql.js/dist/sql-asm.js";
import type { Env } from "./types";

export const COLLECTION_R2_KEY = "collections/user.anki2";

/**
 * Extended Database interface for sql.js asm build.
 * The sql.js types package doesn't fully cover the asm build's API.
 */
export interface AnkiDatabase {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  run(sql: string, params?: unknown[]): void;
  export(): Uint8Array;
  close(): void;
}

/**
 * Load the Anki collection SQLite database from R2.
 * Returns null if no collection exists yet.
 */
export async function loadCollection(env: Env): Promise<AnkiDatabase | null> {
  const object = await env.BUCKET.get(COLLECTION_R2_KEY);
  if (!object) return null;

  const data = new Uint8Array(await object.arrayBuffer());
  const SQL = await initSqlJs();
  return new SQL.Database(data) as AnkiDatabase;
}

/**
 * Save the Anki collection SQLite database back to R2.
 */
export async function saveCollection(env: Env, db: AnkiDatabase): Promise<void> {
  const data = db.export();
  await env.BUCKET.put(COLLECTION_R2_KEY, data);
}

/**
 * Create a new empty Anki collection database.
 */
export async function createEmptyCollection(): Promise<AnkiDatabase> {
  const SQL = await initSqlJs();
  const db = new SQL.Database() as AnkiDatabase;

  const now = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();

  db.run(`
    CREATE TABLE col (
      id integer PRIMARY KEY,
      crt integer NOT NULL,
      mod integer NOT NULL,
      scm integer NOT NULL,
      ver integer NOT NULL,
      dty integer NOT NULL,
      usn integer NOT NULL,
      ls integer NOT NULL,
      conf text NOT NULL,
      models text NOT NULL,
      decks text NOT NULL,
      dconf text NOT NULL,
      tags text NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE notes (
      id integer PRIMARY KEY,
      guid text NOT NULL,
      mid integer NOT NULL,
      mod integer NOT NULL,
      usn integer NOT NULL,
      tags text NOT NULL,
      flds text NOT NULL,
      sfld text NOT NULL,
      csum integer NOT NULL,
      flags integer NOT NULL,
      data text NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE cards (
      id integer PRIMARY KEY,
      nid integer NOT NULL,
      did integer NOT NULL,
      ord integer NOT NULL,
      mod integer NOT NULL,
      usn integer NOT NULL,
      type integer NOT NULL,
      queue integer NOT NULL,
      due integer NOT NULL,
      ivl integer NOT NULL,
      factor integer NOT NULL,
      reps integer NOT NULL,
      lapses integer NOT NULL,
      left integer NOT NULL,
      odue integer NOT NULL,
      odid integer NOT NULL,
      flags integer NOT NULL,
      data text NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE revlog (
      id integer PRIMARY KEY,
      cid integer NOT NULL,
      usn integer NOT NULL,
      ease integer NOT NULL,
      ivl integer NOT NULL,
      lastIvl integer NOT NULL,
      factor integer NOT NULL,
      time integer NOT NULL,
      type integer NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS graves (
      usn integer NOT NULL,
      oid integer NOT NULL,
      type integer NOT NULL
    )
  `);

  // Default deck
  const defaultDecks = JSON.stringify({
    "1": { id: 1, name: "Default", mod: now, usn: 0, collapsed: false, desc: "", dyn: 0, conf: 1, extendRev: 0, extendNew: 0 }
  });

  // Default deck config
  const defaultDconf = JSON.stringify({
    "1": { id: 1, name: "Default", mod: 0, usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true, new: { delays: [1, 10], ints: [1, 4, 7], initialFactor: 2500, order: 1, perDay: 20 }, rev: { perDay: 200, ease4: 1.3, fuzz: 0.05, minSpace: 1, ivlFct: 1, maxIvl: 36500 }, lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 0 } }
  });

  db.run(
    `INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, '{}', '{}', ?, ?, '{}')`,
    [now, nowMs, nowMs, defaultDecks, defaultDconf]
  );

  return db;
}

/**
 * Get the collection metadata from the col table.
 */
export function getColMeta(db: AnkiDatabase): { mod: number; scm: number; usn: number; ls: number; crt: number } {
  const result = db.exec("SELECT mod, scm, usn, ls, crt FROM col LIMIT 1");
  if (result.length === 0 || result[0].values.length === 0) {
    throw new Error("No collection metadata found");
  }
  const row = result[0].values[0];
  return {
    mod: row[0] as number,
    scm: row[1] as number,
    usn: row[2] as number,
    ls: row[3] as number,
    crt: row[4] as number,
  };
}

/**
 * Ensure the graves table exists (older collections may not have it).
 */
export function ensureGravesTable(db: AnkiDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS graves (
      usn integer NOT NULL,
      oid integer NOT NULL,
      type integer NOT NULL
    )
  `);
}
