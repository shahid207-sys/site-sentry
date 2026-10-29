import { afterEach, describe, expect, it } from "vitest";
import { applyDefect, DEFECTS, FIX_PATCH, FIX_PATCH_ENV, fixPatchOn } from "./defects";
import { cleanParts } from "./pages";

const ORIGIN = "https://fixture.test:1";
const BODY = "<p>body</p>";

afterEach(() => {
  delete process.env[FIX_PATCH_ENV];
});

describe("fixture fix patch", () => {
  it("names defect pages that carry the rule it fixes, with verified and audit-only fixes and a group fixed in part", () => {
    for (const f of FIX_PATCH) expect(DEFECTS[f.path]?.expect, f.path).toContain(f.ruleId);
    expect(new Set(FIX_PATCH.map((f) => f.path)).size).toBe(FIX_PATCH.length);
    expect(FIX_PATCH.some((f) => f.verify) && FIX_PATCH.some((f) => !f.verify)).toBe(true);
    // META-008 is on /meta/p-11 and /meta/p-12; only p-11 is fixed.
    expect(DEFECTS["/meta/p-12"].expect).toContain("META-008");
    expect(FIX_PATCH.map((f) => f.path)).not.toContain("/meta/p-12");
  });

  it("serves a patched page clean only while the flag is on, read per call; other defect pages stay broken", () => {
    const clean = (path: string) => cleanParts(path, ORIGIN, BODY);
    expect(fixPatchOn()).toBe(false);
    for (const f of FIX_PATCH) expect(applyDefect(f.path, ORIGIN, BODY), f.path).not.toEqual(clean(f.path));

    process.env[FIX_PATCH_ENV] = "1";
    expect(fixPatchOn()).toBe(true);
    for (const f of FIX_PATCH) expect(applyDefect(f.path, ORIGIN, BODY), f.path).toEqual(clean(f.path));
    for (const path of ["/meta/p-12", "/meta/p-1", "/content/p-5"]) expect(applyDefect(path, ORIGIN, BODY), path).not.toEqual(clean(path));

    process.env[FIX_PATCH_ENV] = "0";
    expect(applyDefect("/meta/p-3", ORIGIN, BODY)).not.toEqual(clean("/meta/p-3"));
    expect(fixPatchOn({ [FIX_PATCH_ENV]: "1" })).toBe(true);
  });
});
