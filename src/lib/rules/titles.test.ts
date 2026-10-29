import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RULES } from "./registry";
import { RULE_TITLES } from "./titles";

describe("rule titles", () => {
  it("every registered rule has its catalog name, and every name matches docs/SPEC.md", () => {
    const spec = readFileSync("docs/SPEC.md", "utf8");
    const catalog = Object.fromEntries([...spec.matchAll(/^\| ([A-Z0-9]+-\d{3}) \| (.+?) \| [DHA] \| (?:\d|—) \|$/gm)].map((m) => [m[1], m[2].trim()]));
    expect(RULES.filter((r) => !RULE_TITLES[r.id]).map((r) => r.id)).toEqual([]);
    expect(RULE_TITLES).toEqual(catalog);
  });
});
