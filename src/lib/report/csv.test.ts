import { describe, expect, it } from "vitest";
import { csvCell } from "./csv";

describe("csv cells", () => {
  it("quotes separators and quotes, and defuses spreadsheet formulas", () => {
    expect(csvCell("https://a.test/x")).toBe("https://a.test/x");
    expect(csvCell("https://a.test/x?a=1,2")).toBe('"https://a.test/x?a=1,2"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-1+1")).toBe("'-1+1");
  });
});
