CREATE TABLE IF NOT EXISTS decks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  card_count INTEGER DEFAULT 0,
  uploaded_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  deck_id TEXT NOT NULL,
  model_name TEXT,
  fields TEXT NOT NULL,
  field_names TEXT NOT NULL,
  tags TEXT DEFAULT '',
  FOREIGN KEY (deck_id) REFERENCES decks(id)
);

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY,
  note_id INTEGER NOT NULL,
  deck_id TEXT NOT NULL,
  ord INTEGER DEFAULT 0,
  type INTEGER DEFAULT 0,
  queue INTEGER DEFAULT 0,
  due INTEGER DEFAULT 0,
  ivl INTEGER DEFAULT 0,
  factor INTEGER DEFAULT 0,
  reps INTEGER DEFAULT 0,
  lapses INTEGER DEFAULT 0,
  flags INTEGER DEFAULT 0,
  FOREIGN KEY (note_id) REFERENCES notes(id),
  FOREIGN KEY (deck_id) REFERENCES decks(id)
);

CREATE TABLE IF NOT EXISTS revlog (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL,
  ease INTEGER NOT NULL,
  ivl INTEGER NOT NULL,
  last_ivl INTEGER NOT NULL,
  factor INTEGER NOT NULL,
  review_time INTEGER NOT NULL,
  type INTEGER NOT NULL,
  FOREIGN KEY (card_id) REFERENCES cards(id)
);

CREATE INDEX IF NOT EXISTS idx_notes_deck ON notes(deck_id);
CREATE INDEX IF NOT EXISTS idx_cards_deck ON cards(deck_id);
CREATE INDEX IF NOT EXISTS idx_cards_note ON cards(note_id);
CREATE INDEX IF NOT EXISTS idx_revlog_card ON revlog(card_id);
CREATE INDEX IF NOT EXISTS idx_revlog_id ON revlog(id);
CREATE INDEX IF NOT EXISTS idx_cards_lapses ON cards(lapses);
CREATE INDEX IF NOT EXISTS idx_cards_reps ON cards(reps);
CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due);

CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  host_key TEXT NOT NULL,
  schema_mod INTEGER DEFAULT 0,
  last_mod INTEGER DEFAULT 0,
  collection_r2_key TEXT
);
