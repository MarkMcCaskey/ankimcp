import { describe, it, expect } from "vitest";
import { parseApkg } from "../src/apkg";
import { simple_apkg, spanish_apkg, invalid_bin, no_collection_zip } from "./helpers";

describe("parseApkg", () => {
  it("parses a valid .apkg file and extracts decks, notes, and cards", async () => {
    const { decks, reviews } = await parseApkg(simple_apkg.buffer);

    expect(decks).toHaveLength(1);
    const deck = decks[0];
    expect(deck.name).toBe("Test Deck");
    expect(deck.cards).toHaveLength(2);
    expect(deck.notes).toHaveLength(2);

    const note = deck.notes[0];
    expect(note.modelName).toBe("Basic");
    expect(note.fieldNames).toEqual(["Front", "Back"]);
    expect(note.fields).toEqual(["What is 2+2?", "4"]);

    // Simple deck has no reviews
    expect(reviews).toHaveLength(0);
  });

  it("extracts card scheduling data", async () => {
    const { decks } = await parseApkg(spanish_apkg.buffer);

    const deck = decks[0];
    // "hola" card has type=2 (review), ivl=21, factor=2500
    const holaCard = deck.cards.find((c) => {
      const note = deck.notes.find((n) => n.id === c.noteId);
      return note?.fields[0] === "hola";
    });
    expect(holaCard).toBeDefined();
    expect(holaCard!.type).toBe(2);
    expect(holaCard!.ivl).toBe(21);
    expect(holaCard!.factor).toBe(2500);
    expect(holaCard!.reps).toBe(8);
    expect(holaCard!.lapses).toBe(0);
  });

  it("extracts review history", async () => {
    const { reviews } = await parseApkg(spanish_apkg.buffer);

    expect(reviews.length).toBeGreaterThan(0);
    // "hola" has 4 reviews, "gato" has 5 reviews = 9 total
    expect(reviews).toHaveLength(9);

    const firstReview = reviews[0];
    expect(firstReview.ease).toBeGreaterThanOrEqual(1);
    expect(firstReview.ease).toBeLessThanOrEqual(4);
    expect(firstReview.cardId).toBeDefined();
  });

  it("throws on invalid zip data", async () => {
    await expect(parseApkg(invalid_bin.buffer)).rejects.toThrow();
  });

  it("throws when no collection db is found in zip", async () => {
    await expect(parseApkg(no_collection_zip.buffer)).rejects.toThrow(
      /No collection\.anki21b.*found in \.apkg/
    );
  });
});
