import { describe, expect, it } from "vitest";
import { joinedWords, likelyTypo, matchCase, misspelling } from "./spelling";

describe("misspelling", () => {
  it("finds the typos on arch-graphic.com with the word meant", () => {
    expect(misspelling("Tabels")).toBe("tables");
    expect(misspelling("Humve")?.toLowerCase()).toBe("humvee");
    expect(misspelling("Tomnes")).toBe("tonnes");
  });
  it("accepts English words, British spellings, place names and the allowlist", () => {
    for (const w of ["Furniture", "Howitzer", "colour", "centre", "Woollen", "skilful", "organise", "catalogue", "Dubai", "Sharjah", "Keychain", "Pinterest"]) expect(misspelling(w), w).toBeNull();
    expect(misspelling("Chunmoo", new Set(["chunmoo"]))).toBeNull();
  });
  it("leaves short names, acronyms and words with digits alone", () => {
    for (const w of ["Frej", "Hosn", "Mila", "Aldar", "Himars", "UAE", "CNC", "3D"]) expect(misspelling(w), w).toBeNull();
  });
  it("weighs the kind of edit by the word's length", () => {
    expect(likelyTypo("tabels", "tables")).toBe(true);
    expect(likelyTypo("hosn", "hons")).toBe(false);
    expect(likelyTypo("humve", "humvee")).toBe(true);
    expect(likelyTypo("mila", "milan")).toBe(false);
    expect(likelyTypo("aldar", "alder")).toBe(false);
  });
  it("finds words run together and keeps the case as written", () => {
    expect(joinedWords("FilesPLOAD")).toBe(true);
    expect(joinedWords("iPhone")).toBe(false);
    expect(joinedWords("PRINTING")).toBe(false);
    expect(matchCase("Tabels", "tables")).toBe("Tables");
    expect(matchCase("TABELS", "tables")).toBe("TABLES");
  });
});
