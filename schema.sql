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
  FOREIGN KEY (note_id) REFERENCES notes(id),
  FOREIGN KEY (deck_id) REFERENCES decks(id)
);

CREATE INDEX IF NOT EXISTS idx_notes_deck ON notes(deck_id);
CREATE INDEX IF NOT EXISTS idx_cards_deck ON cards(deck_id);
CREATE INDEX IF NOT EXISTS idx_cards_note ON cards(note_id);
