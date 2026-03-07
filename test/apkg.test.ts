import { describe, it, expect } from "vitest";
import { parseApkg } from "../src/apkg";
import { simple_apkg, invalid_bin, no_collection_zip } from "./helpers";

describe("parseApkg", () => {
  it("parses a valid .apkg file and extracts decks, notes, and cards", async () => {
    const decks = await parseApkg(simple_apkg.buffer);

    expect(decks).toHaveLength(1);
    const deck = decks[0];
    expect(deck.name).toBe("Test Deck");
    expect(deck.cards).toHaveLength(2);
    expect(deck.notes).toHaveLength(2);

    const note = deck.notes[0];
    expect(note.modelName).toBe("Basic");
    expect(note.fieldNames).toEqual(["Front", "Back"]);
    expect(note.fields).toEqual(["What is 2+2?", "4"]);
  });

  it("throws on invalid zip data", async () => {
    await expect(parseApkg(invalid_bin.buffer)).rejects.toThrow();
  });

  it("throws when no collection db is found in zip", async () => {
    await expect(parseApkg(no_collection_zip.buffer)).rejects.toThrow(
      /No collection\.anki21 or collection\.anki2/
    );
  });
});
