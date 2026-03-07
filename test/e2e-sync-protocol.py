#!/usr/bin/env python3
"""
End-to-end test for the Anki sync protocol implementation.

This script simulates a real Anki client by making HTTP requests with
proper zstd compression and the v11 protocol format. It exercises the
full sync flow (hostKey → meta → upload → download) and the incremental
sync flow (start → applyGraves → applyChanges → chunk → applyChunk →
sanityCheck2 → finish).

Requirements: pip install zstandard requests
Usage: python test/e2e-sync-protocol.py [base_url]
  Default base_url: http://127.0.0.1:8799
"""

import json
import os
import sqlite3
import struct
import sys
import tempfile
import time
import uuid
from pathlib import Path

try:
    import zstandard as zstd
    import requests
except ImportError:
    print("Missing dependencies. Install with: pip install zstandard requests")
    sys.exit(1)

BASE_URL = os.environ.get("SYNC_URL", sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8799")
USERNAME = os.environ.get("SYNC_USERNAME", "testuser")
PASSWORD = os.environ.get("SYNC_PASSWORD", "testpass")

# Track test results
passed = 0
failed = 0


def test(name):
    """Decorator to register and run a test."""
    def decorator(fn):
        fn._test_name = name
        return fn
    return decorator


def run_tests(tests):
    global passed, failed
    for fn in tests:
        name = fn._test_name
        try:
            fn()
            passed += 1
            print(f"  ✓ {name}")
        except Exception as e:
            failed += 1
            print(f"  ✗ {name}: {e}")


class AnkiSyncClient:
    """Simulates an Anki client using the v11 sync protocol."""

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self.host_key = ""
        self.session_key = ""
        self.compressor = zstd.ZstdCompressor()
        self.decompressor = zstd.ZstdDecompressor()

    def _sync_request(self, endpoint: str, body=None, compress=True):
        """Make a v11 protocol sync request."""
        url = f"{self.base_url}/sync/{endpoint}"
        headers = {
            "anki-sync": json.dumps({
                "v": 11,
                "k": self.host_key,
                "c": "e2e-test-client",
                "s": self.session_key,
            })
        }

        if body is not None:
            data = json.dumps(body).encode("utf-8")
            if compress and len(data) > 0:
                data = self.compressor.compress(data)
        else:
            data = b""

        resp = requests.post(url, headers=headers, data=data)
        return resp

    def _sync_request_raw(self, endpoint: str, raw_body: bytes):
        """Make a v11 protocol sync request with raw bytes."""
        url = f"{self.base_url}/sync/{endpoint}"
        headers = {
            "anki-sync": json.dumps({
                "v": 11,
                "k": self.host_key,
                "c": "e2e-test-client",
                "s": self.session_key,
            })
        }
        resp = requests.post(url, headers=headers, data=raw_body)
        return resp

    def authenticate(self, username: str, password: str) -> str:
        """POST /sync/hostKey - authenticate and get a host key."""
        resp = self._sync_request("hostKey", {"u": username, "p": password}, compress=False)
        assert resp.status_code == 200, f"hostKey failed: {resp.status_code} {resp.text}"
        data = resp.json()
        self.host_key = data["key"]
        return self.host_key

    def meta(self):
        """POST /sync/meta - get server metadata."""
        resp = self._sync_request("meta", {"v": 11, "cv": "e2e-test"})
        assert resp.status_code == 200, f"meta failed: {resp.status_code} {resp.text}"
        return resp.json()

    def upload(self, db_bytes: bytes):
        """POST /sync/upload - full upload of SQLite collection."""
        resp = self._sync_request_raw("upload", db_bytes)
        assert resp.status_code == 200, f"upload failed: {resp.status_code} {resp.text}"
        return resp.text

    def download(self) -> bytes:
        """POST /sync/download - full download of SQLite collection."""
        resp = self._sync_request("download", None)
        assert resp.status_code == 200, f"download failed: {resp.status_code} {resp.text}"
        return resp.content

    def start(self, min_usn: int, lnewer: bool):
        """POST /sync/start - begin incremental sync."""
        self.session_key = str(uuid.uuid4())
        resp = self._sync_request("start", {"minUsn": min_usn, "lnewer": lnewer})
        assert resp.status_code == 200, f"start failed: {resp.status_code} {resp.text}"
        return resp.json()

    def apply_graves(self, graves: dict):
        """POST /sync/applyGraves"""
        resp = self._sync_request("applyGraves", {"chunk": graves})
        assert resp.status_code == 200, f"applyGraves failed: {resp.status_code} {resp.text}"

    def apply_changes(self, changes: dict):
        """POST /sync/applyChanges"""
        resp = self._sync_request("applyChanges", {"changes": changes})
        assert resp.status_code == 200, f"applyChanges failed: {resp.status_code} {resp.text}"
        return resp.json()

    def chunk(self):
        """POST /sync/chunk"""
        resp = self._sync_request("chunk", None)
        assert resp.status_code == 200, f"chunk failed: {resp.status_code} {resp.text}"
        return resp.json()

    def apply_chunk(self, chunk: dict):
        """POST /sync/applyChunk"""
        resp = self._sync_request("applyChunk", {"chunk": chunk})
        assert resp.status_code == 200, f"applyChunk failed: {resp.status_code} {resp.text}"

    def sanity_check(self, counts):
        """POST /sync/sanityCheck2"""
        resp = self._sync_request("sanityCheck2", {"client": counts})
        assert resp.status_code == 200, f"sanityCheck2 failed: {resp.status_code} {resp.text}"
        return resp.json()

    def finish(self):
        """POST /sync/finish"""
        resp = self._sync_request("finish", None)
        assert resp.status_code == 200, f"finish failed: {resp.status_code} {resp.text}"
        return resp.json()

    def abort(self):
        """POST /sync/abort"""
        resp = self._sync_request("abort", None)
        assert resp.status_code == 200, f"abort failed: {resp.status_code} {resp.text}"


def create_test_collection(
    notes=None,
    decks=None,
    model_id=1234567890,
) -> bytes:
    """Create a minimal Anki SQLite collection database in memory.

    Returns the raw SQLite bytes.
    """
    with tempfile.NamedTemporaryFile(suffix=".anki2", delete=False) as f:
        db_path = f.name

    try:
        conn = sqlite3.connect(db_path)
        c = conn.cursor()

        now = int(time.time())
        now_ms = int(time.time() * 1000)

        # Create tables
        c.execute("""CREATE TABLE col (
            id integer PRIMARY KEY, crt integer NOT NULL, mod integer NOT NULL,
            scm integer NOT NULL, ver integer NOT NULL, dty integer NOT NULL,
            usn integer NOT NULL, ls integer NOT NULL, conf text NOT NULL,
            models text NOT NULL, decks text NOT NULL, dconf text NOT NULL,
            tags text NOT NULL)""")

        c.execute("""CREATE TABLE notes (
            id integer PRIMARY KEY, guid text NOT NULL, mid integer NOT NULL,
            mod integer NOT NULL, usn integer NOT NULL, tags text NOT NULL,
            flds text NOT NULL, sfld text NOT NULL, csum integer NOT NULL,
            flags integer NOT NULL, data text NOT NULL)""")

        c.execute("""CREATE TABLE cards (
            id integer PRIMARY KEY, nid integer NOT NULL, did integer NOT NULL,
            ord integer NOT NULL, mod integer NOT NULL, usn integer NOT NULL,
            type integer NOT NULL, queue integer NOT NULL, due integer NOT NULL,
            ivl integer NOT NULL, factor integer NOT NULL, reps integer NOT NULL,
            lapses integer NOT NULL, left integer NOT NULL, odue integer NOT NULL,
            odid integer NOT NULL, flags integer NOT NULL, data text NOT NULL)""")

        c.execute("""CREATE TABLE revlog (
            id integer PRIMARY KEY, cid integer NOT NULL, usn integer NOT NULL,
            ease integer NOT NULL, ivl integer NOT NULL, lastIvl integer NOT NULL,
            factor integer NOT NULL, time integer NOT NULL, type integer NOT NULL)""")

        c.execute("""CREATE TABLE IF NOT EXISTS graves (
            usn integer NOT NULL, oid integer NOT NULL, type integer NOT NULL)""")

        # Models
        models = {
            str(model_id): {
                "id": model_id, "name": "Basic", "mod": 0, "usn": 0,
                "flds": [{"name": "Front", "ord": 0}, {"name": "Back", "ord": 1}],
                "tmpls": [{"name": "Card 1", "qfmt": "{{Front}}", "afmt": "{{Back}}", "ord": 0}],
                "tags": [], "did": 1, "type": 0, "css": "", "sortf": 0,
            }
        }

        # Decks
        deck_json = {
            "1": {"id": 1, "name": "Default", "mod": 0, "usn": 0,
                  "collapsed": False, "desc": "", "dyn": 0, "conf": 1,
                  "extendRev": 0, "extendNew": 0}
        }
        if decks:
            for d in decks:
                deck_json[str(d["id"])] = d

        # Default config
        dconf = {
            "1": {"id": 1, "name": "Default", "mod": 0, "usn": 0, "maxTaken": 60,
                  "autoplay": True, "timer": 0, "replayq": True,
                  "new": {"delays": [1, 10], "ints": [1, 4, 7], "initialFactor": 2500, "order": 1, "perDay": 20},
                  "rev": {"perDay": 200, "ease4": 1.3, "fuzz": 0.05, "minSpace": 1, "ivlFct": 1, "maxIvl": 36500},
                  "lapse": {"delays": [10], "mult": 0, "minInt": 1, "leechFails": 8, "leechAction": 0}}
        }

        c.execute("INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, '{}', ?, ?, ?, '{}')",
                  (now, now_ms, now_ms, json.dumps(models), json.dumps(deck_json), json.dumps(dconf)))

        # Add notes and cards
        if notes:
            for note in notes:
                c.execute(
                    "INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (note["id"], note.get("guid", f"g{note['id']}"), model_id,
                     now, 0, note.get("tags", ""),
                     note["front"] + "\x1f" + note["back"],
                     note["front"], 0, 0, "")
                )
                c.execute(
                    "INSERT INTO cards VALUES (?, ?, ?, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '')",
                    (note["id"] * 10, note["id"], note.get("deck_id", 1), now)
                )

        conn.commit()
        conn.close()

        return Path(db_path).read_bytes()
    finally:
        Path(db_path).unlink(missing_ok=True)


# ─── Tests ───

client = AnkiSyncClient(BASE_URL)


@test("hostKey: authenticate with correct credentials")
def test_auth():
    key = client.authenticate(USERNAME, PASSWORD)
    assert len(key) == 64, f"Expected 64-char hex key, got {len(key)} chars"


@test("hostKey: reject wrong credentials")
def test_auth_wrong():
    c = AnkiSyncClient(BASE_URL)
    resp = c._sync_request("hostKey", {"u": "wrong", "p": "wrong"}, compress=False)
    assert resp.status_code == 403, f"Expected 403, got {resp.status_code}"


@test("meta: returns empty state with no collection")
def test_meta_empty():
    meta = client.meta()
    assert "scm" in meta
    assert "ts" in meta
    assert meta["cont"] is True


@test("full upload: upload test collection")
def test_full_upload():
    db_bytes = create_test_collection(
        notes=[
            {"id": 1, "front": "Hello", "back": "World", "deck_id": 1000},
            {"id": 2, "front": "Foo", "back": "Bar", "deck_id": 1000},
            {"id": 3, "front": "Baz", "back": "Qux", "deck_id": 1000},
        ],
        decks=[
            {"id": 1000, "name": "Test Deck", "mod": 0, "usn": 0,
             "collapsed": False, "desc": "", "dyn": 0, "conf": 1,
             "extendRev": 0, "extendNew": 0}
        ],
    )
    result = client.upload(db_bytes)
    assert result == "OK", f"Expected 'OK', got '{result}'"


@test("meta: returns collection metadata after upload")
def test_meta_after_upload():
    meta = client.meta()
    assert meta["scm"] > 0, f"Expected scm > 0, got {meta['scm']}"
    assert meta["empty"] is False


@test("full download: retrieve uploaded collection")
def test_full_download():
    data = client.download()
    assert len(data) > 0, "Empty download"
    header = data[:15].decode("ascii", errors="ignore")
    assert header == "SQLite format 3", f"Not a SQLite file: {header}"

    # Verify contents
    with tempfile.NamedTemporaryFile(suffix=".anki2", delete=False) as f:
        f.write(data)
        f.flush()
        conn = sqlite3.connect(f.name)
        c = conn.cursor()
        c.execute("SELECT COUNT(*) FROM notes")
        count = c.fetchone()[0]
        conn.close()
        Path(f.name).unlink()
    assert count == 3, f"Expected 3 notes, got {count}"


@test("incremental sync: full cycle with no changes")
def test_incr_no_changes():
    graves = client.start(min_usn=0, lnewer=False)
    assert "cards" in graves
    assert "decks" in graves
    assert "notes" in graves

    client.apply_graves({"cards": [], "decks": [], "notes": []})
    server_changes = client.apply_changes({"models": [], "decks": [[], []], "tags": []})
    assert "models" in server_changes
    assert "decks" in server_changes

    chunk = client.chunk()
    assert "done" in chunk

    # If server sent items, get remaining chunks
    while not chunk.get("done"):
        chunk = client.chunk()

    result = client.finish()
    assert result > 0, f"Expected positive timestamp, got {result}"


@test("incremental sync: add a card from client")
def test_incr_add_card():
    # Re-upload fresh collection
    db_bytes = create_test_collection(
        notes=[
            {"id": 1, "front": "Hello", "back": "World"},
            {"id": 2, "front": "Foo", "back": "Bar"},
        ],
    )
    client.upload(db_bytes)

    # Start incremental sync
    client.start(min_usn=0, lnewer=True)
    client.apply_graves({"cards": [], "decks": [], "notes": []})
    client.apply_changes({"models": [], "decks": [[], []], "tags": []})

    # Get server chunks
    chunk = client.chunk()
    while not chunk.get("done"):
        chunk = client.chunk()

    # Send a new note+card from client
    now = int(time.time())
    client.apply_chunk({
        "done": True,
        "notes": [
            [100, "guid100", 1234567890, now, -1, " vocab ", "Apple\x1fManzana", "Apple", "", 0, ""]
        ],
        "cards": [
            [1000, 100, 1, 0, now, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ""]
        ],
        "revlog": [],
    })

    # Sanity check — count cards/notes/revlog in downloaded collection
    # We need to match server counts, so download and check
    # For now, we know: 2 original notes + 1 new = 3 notes, 2 original cards + 1 new = 3 cards
    result = client.sanity_check([[0, 0, 0], 3, 3, 0, 0, 1, 1, 1])
    assert result["status"] == "ok", f"Sanity check failed: {result}"

    ts = client.finish()
    assert ts > 0

    # Verify by downloading
    data = client.download()
    with tempfile.NamedTemporaryFile(suffix=".anki2", delete=False) as f:
        f.write(data)
        f.flush()
        conn = sqlite3.connect(f.name)
        c = conn.cursor()
        c.execute("SELECT COUNT(*) FROM notes")
        note_count = c.fetchone()[0]
        c.execute("SELECT COUNT(*) FROM cards")
        card_count = c.fetchone()[0]
        c.execute("SELECT flds FROM notes WHERE id = 100")
        flds = c.fetchone()
        conn.close()
        Path(f.name).unlink()

    assert note_count == 3, f"Expected 3 notes, got {note_count}"
    assert card_count == 3, f"Expected 3 cards, got {card_count}"
    assert flds is not None, "New note not found"
    assert "Apple" in flds[0], f"Expected 'Apple' in fields, got {flds[0]}"


@test("incremental sync: delete a card via graves")
def test_incr_delete_card():
    # Re-upload fresh collection
    db_bytes = create_test_collection(
        notes=[
            {"id": 1, "front": "Keep", "back": "This"},
            {"id": 2, "front": "Delete", "back": "This"},
        ],
    )
    client.upload(db_bytes)

    # Delete card for note 2 (card id = 20)
    client.start(min_usn=0, lnewer=True)
    client.apply_graves({"cards": [20], "decks": [], "notes": []})
    client.apply_changes({"models": [], "decks": [[], []], "tags": []})
    chunk = client.chunk()
    while not chunk.get("done"):
        chunk = client.chunk()

    # Counts: 1 card remaining, 2 notes, 0 revlog
    result = client.sanity_check([[0, 0, 0], 1, 2, 0, 1, 1, 1, 1])
    assert result["status"] == "ok", f"Sanity check failed: {result}"

    client.finish()

    # Verify
    data = client.download()
    with tempfile.NamedTemporaryFile(suffix=".anki2", delete=False) as f:
        f.write(data)
        f.flush()
        conn = sqlite3.connect(f.name)
        c = conn.cursor()
        c.execute("SELECT COUNT(*) FROM cards")
        card_count = c.fetchone()[0]
        c.execute("SELECT id FROM cards")
        ids = [row[0] for row in c.fetchall()]
        conn.close()
        Path(f.name).unlink()

    assert card_count == 1, f"Expected 1 card, got {card_count}"
    assert 20 not in ids, f"Card 20 should be deleted, remaining: {ids}"


@test("incremental sync: add new deck via applyChanges")
def test_incr_add_deck():
    db_bytes = create_test_collection(notes=[{"id": 1, "front": "A", "back": "B"}])
    client.upload(db_bytes)

    client.start(min_usn=0, lnewer=True)
    client.apply_graves({"cards": [], "decks": [], "notes": []})

    new_deck = {
        "id": 5000, "name": "Languages", "mod": 0, "usn": -1,
        "collapsed": False, "desc": "", "dyn": 0, "conf": 1,
        "extendRev": 0, "extendNew": 0
    }
    server_changes = client.apply_changes({
        "models": [],
        "decks": [[new_deck], []],
        "tags": ["lang-tag"]
    })

    chunk = client.chunk()
    while not chunk.get("done"):
        chunk = client.chunk()

    result = client.sanity_check([[0, 0, 0], 1, 1, 0, 0, 1, 2, 1])
    assert result["status"] == "ok", f"Sanity check failed: {result}"
    client.finish()

    # Verify deck exists
    data = client.download()
    with tempfile.NamedTemporaryFile(suffix=".anki2", delete=False) as f:
        f.write(data)
        f.flush()
        conn = sqlite3.connect(f.name)
        c = conn.cursor()
        c.execute("SELECT decks FROM col LIMIT 1")
        decks = json.loads(c.fetchone()[0])
        c.execute("SELECT tags FROM col LIMIT 1")
        tags = json.loads(c.fetchone()[0])
        conn.close()
        Path(f.name).unlink()

    assert "5000" in decks, f"Deck 5000 not found in {list(decks.keys())}"
    assert decks["5000"]["name"] == "Languages"
    assert "lang-tag" in tags


@test("incremental sync: two consecutive syncs with USN tracking")
def test_incr_consecutive_syncs():
    # Fresh upload
    db_bytes = create_test_collection(notes=[{"id": 1, "front": "A", "back": "B"}])
    client.upload(db_bytes)

    # First sync
    client.start(min_usn=0, lnewer=False)
    client.apply_graves({"cards": [], "decks": [], "notes": []})
    client.apply_changes({"models": [], "decks": [[], []], "tags": []})
    chunk = client.chunk()
    while not chunk.get("done"):
        chunk = client.chunk()
    client.sanity_check([[0, 0, 0], 1, 1, 0, 0, 1, 1, 1])
    client.finish()

    # Check USN was incremented
    data = client.download()
    with tempfile.NamedTemporaryFile(suffix=".anki2", delete=False) as f:
        f.write(data)
        f.flush()
        conn = sqlite3.connect(f.name)
        c = conn.cursor()
        c.execute("SELECT usn FROM col LIMIT 1")
        usn = c.fetchone()[0]
        conn.close()
        Path(f.name).unlink()
    assert usn == 1, f"Expected USN 1 after first sync, got {usn}"

    # Second sync with USN 1 — should have no changes
    client.start(min_usn=1, lnewer=False)
    client.apply_graves({"cards": [], "decks": [], "notes": []})
    client.apply_changes({"models": [], "decks": [[], []], "tags": []})
    chunk = client.chunk()
    assert chunk.get("done") is True, "Expected done=true for up-to-date sync"
    # No cards/notes should be in the chunk
    assert chunk.get("cards") is None, f"Expected no cards, got {chunk.get('cards')}"
    assert chunk.get("notes") is None, f"Expected no notes, got {chunk.get('notes')}"

    client.sanity_check([[0, 0, 0], 1, 1, 0, 0, 1, 1, 1])
    client.finish()


@test("incremental sync: abort cleans up session")
def test_incr_abort():
    db_bytes = create_test_collection(notes=[{"id": 1, "front": "A", "back": "B"}])
    client.upload(db_bytes)

    client.start(min_usn=0, lnewer=False)
    # Abort mid-sync
    client.abort()

    # Starting a new sync should work (session was cleaned up)
    client.start(min_usn=0, lnewer=False)
    client.apply_graves({"cards": [], "decks": [], "notes": []})
    client.apply_changes({"models": [], "decks": [[], []], "tags": []})
    chunk = client.chunk()
    while not chunk.get("done"):
        chunk = client.chunk()
    client.sanity_check([[0, 0, 0], 1, 1, 0, 0, 1, 1, 1])
    client.finish()


@test("incremental sync: update existing note fields")
def test_incr_update_note():
    db_bytes = create_test_collection(
        notes=[{"id": 1, "front": "Old Front", "back": "Old Back"}]
    )
    client.upload(db_bytes)

    client.start(min_usn=0, lnewer=True)
    client.apply_graves({"cards": [], "decks": [], "notes": []})
    client.apply_changes({"models": [], "decks": [[], []], "tags": []})
    chunk = client.chunk()
    while not chunk.get("done"):
        chunk = client.chunk()

    # Update the note with new fields
    now = int(time.time())
    client.apply_chunk({
        "done": True,
        "notes": [
            [1, "g1", 1234567890, now, -1, "", "New Front\x1fNew Back", "New Front", "", 0, ""]
        ],
        "cards": [],
        "revlog": [],
    })

    client.sanity_check([[0, 0, 0], 1, 1, 0, 0, 1, 1, 1])
    client.finish()

    # Verify
    data = client.download()
    with tempfile.NamedTemporaryFile(suffix=".anki2", delete=False) as f:
        f.write(data)
        f.flush()
        conn = sqlite3.connect(f.name)
        c = conn.cursor()
        c.execute("SELECT flds FROM notes WHERE id = 1")
        flds = c.fetchone()[0]
        c.execute("SELECT COUNT(*) FROM notes")
        count = c.fetchone()[0]
        conn.close()
        Path(f.name).unlink()

    assert count == 1, f"Expected 1 note (not duplicated), got {count}"
    assert "New Front" in flds, f"Expected updated fields, got {flds}"


@test("incremental sync: add review log entries")
def test_incr_add_revlog():
    db_bytes = create_test_collection(
        notes=[{"id": 1, "front": "Review", "back": "Me"}]
    )
    client.upload(db_bytes)

    client.start(min_usn=0, lnewer=True)
    client.apply_graves({"cards": [], "decks": [], "notes": []})
    client.apply_changes({"models": [], "decks": [[], []], "tags": []})
    chunk = client.chunk()
    while not chunk.get("done"):
        chunk = client.chunk()

    # Send review log entries
    now_ms = int(time.time() * 1000)
    client.apply_chunk({
        "done": True,
        "notes": [],
        "cards": [],
        "revlog": [
            # [id, cid, usn, ease, ivl, lastIvl, factor, time, type]
            [now_ms - 100000, 10, -1, 3, 1, 0, 2500, 5000, 0],
            [now_ms - 50000, 10, -1, 3, 10, 1, 2500, 8000, 1],
            [now_ms, 10, -1, 2, 10, 10, 2350, 12000, 1],
        ],
    })

    client.sanity_check([[0, 0, 0], 1, 1, 3, 0, 1, 1, 1])
    client.finish()

    # Verify
    data = client.download()
    with tempfile.NamedTemporaryFile(suffix=".anki2", delete=False) as f:
        f.write(data)
        f.flush()
        conn = sqlite3.connect(f.name)
        c = conn.cursor()
        c.execute("SELECT COUNT(*) FROM revlog")
        count = c.fetchone()[0]
        conn.close()
        Path(f.name).unlink()

    assert count == 3, f"Expected 3 revlog entries, got {count}"


# ─── Main ───

if __name__ == "__main__":
    print(f"\nAnki Sync Protocol E2E Tests")
    print(f"Server: {BASE_URL}")
    print(f"{'=' * 50}")

    tests = [
        test_auth,
        test_auth_wrong,
        test_meta_empty,
        test_full_upload,
        test_meta_after_upload,
        test_full_download,
        test_incr_no_changes,
        test_incr_add_card,
        test_incr_delete_card,
        test_incr_add_deck,
        test_incr_consecutive_syncs,
        test_incr_abort,
        test_incr_update_note,
        test_incr_add_revlog,
    ]

    run_tests(tests)

    print(f"\n{'=' * 50}")
    print(f"Results: {passed} passed, {failed} failed, {passed + failed} total")

    if failed > 0:
        sys.exit(1)
    else:
        print("All tests passed!")
        sys.exit(0)
