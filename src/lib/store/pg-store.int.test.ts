import { mkdtemp, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { migrateDb } from "../db/client";
import { getAuditDetail } from "../server/queries";
import { testDb } from "../../test/db";
import { __setStoresForTests } from "../workspace";
import { backupJsonStore, countRows, migrateJsonStore, MigrationRefused, readJsonStore } from "./json-to-pg";
import { LEGACY_V1_NOTE } from "../audit/legacy";
import { PgStore } from "./pg-store";
import { MemoryStore } from "./store";

const db = testDb();
const pool = db.$client;

// A v1 store.json (the single-page engine before v2) with one live audit and one failing title rule.
const V1_AUDIT_ID = "11111111-1111-4111-8111-111111111111";
const v1 = {
  audits: {
    [V1_AUDIT_ID]: {
      id: V1_AUDIT_ID,
      source: "live",
      requestedUrl: "https://legacy.example/",
      finalUrl: "https://legacy.example/",
      httpStatus: 200,
      redirectChain: [],
      fetchedAt: "2026-10-24T04:45:09.647Z",
      bytes: 1200,
      truncated: false,
      expectations: {},
      rules: [
        {
          ruleId: "title",
          name: "Page title",
          status: "fail",
          facts: { titleText: "" },
          snippets: ["<title></title>"],
          missingExpectations: [],
          findings: [
            {
              ruleCode: "title/missing",
              ruleId: "title",
              pageUrl: "https://legacy.example/",
              severity: "high",
              title: "Title is missing",
              message: "The page has no title.",
              observed: "empty",
              expected: "a title",
              evidence: { snippets: ["<title></title>"], facts: { titleText: "" } },
              recommendations: ["Add a title."],
              acceptanceCriteria: [{ id: "title-present", description: "The page has a title.", params: {} }],
            },
          ],
        },
      ],
    },
  },
  findings: {},
  expectations: {},
  sampleState: "current",
};

async function clear() {
  await pool.query("delete from workspaces where id in ('live', 'sample')");
}

beforeEach(async () => {
  await migrateDb(db);
  await clear();
});
afterAll(async () => {
  await clear();
  await pool.end();
});

describe("PgStore", () => {
  it("reads back what it wrote, deletes removed rows, and loses no write under concurrent updates", async () => {
    const store = new PgStore(pool, "live");
    expect(Object.keys((await store.read()).sites)).toEqual([]);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.update((d) => {
          d.sites[`s${i}`] = { id: `s${i}`, name: `Site ${i}`, origin: `https://s${i}.example`, createdAt: "2026-10-29T00:00:00.000Z" };
        }),
      ),
    );
    expect(Object.keys((await store.read()).sites)).toHaveLength(20);
    await store.update((d) => {
      delete d.sites.s3;
      d.settings.severityOverrides = { "title/missing": "low" };
    });
    const after = await store.read();
    expect(after.sites.s3).toBeUndefined();
    expect(after.settings.severityOverrides).toEqual({ "title/missing": "low" });
    expect((await countRows(pool, "live")).sites).toBe(19);
  });

  it("rolls back when the mutation throws", async () => {
    const store = new PgStore(pool, "live");
    await expect(
      store.update((d) => {
        d.sites.x = { id: "x", name: "x", origin: "https://x.example", createdAt: "2026-10-29T00:00:00.000Z" };
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await store.read()).sites).toEqual({});
  });

  it("stores audit results per workspace", async () => {
    const live = new PgStore(pool, "live");
    const sample = new PgStore(pool, "sample");
    await live.writeAudit("a1", { snapshots: [], findings: [] });
    expect(await sample.readAudit("a1")).toEqual({ snapshots: [], findings: [] });
    await live.deleteAudit("a1");
    expect((await countRows(pool, "live")).audit_results).toBe(0);
  });
});

describe("JSON store to Postgres", () => {
  it("dry run and real run give the same row counts; a second run is refused; the legacy audit still displays", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ss-json-store-"));
    await writeFile(path.join(dir, "store.json"), JSON.stringify(v1));
    const sources = await readJsonStore(dir);
    expect(sources.map((s) => [s.workspace, s.from])).toEqual([["live", "store.json (v1, converted)"]]);

    const dry = await migrateJsonStore(pool, sources, { dryRun: true });
    expect(dry.every((r) => r.json === r.postgres)).toBe(true);
    expect(Object.values(await countRows(pool, "live")).every((n) => n === 0)).toBe(true); // rolled back

    const real = await migrateJsonStore(pool, sources, { dryRun: false });
    expect(real).toEqual(dry);
    expect(real.find((r) => r.table === "audits")).toMatchObject({ json: 1, postgres: 1 });
    expect(real.find((r) => r.table === "audit_results")).toMatchObject({ json: 1, postgres: 1 });
    await expect(migrateJsonStore(pool, sources, { dryRun: false })).rejects.toBeInstanceOf(MigrationRefused);
    expect(await migrateJsonStore(pool, sources, { dryRun: false, replace: true })).toEqual(real);

    __setStoresForTests(new PgStore(pool, "live"), new MemoryStore());
    const detail = await getAuditDetail("live", V1_AUDIT_ID);
    expect(detail.site.origin).toBe("https://legacy.example");
    expect(detail.findings.map((f) => f.ruleCode)).toEqual(["title/missing"]);
    expect(detail.audit.coverage.map((c) => c.message)).toContain(LEGACY_V1_NOTE);

    const backup = await backupJsonStore(dir, sources, "test");
    expect(await readdir(backup)).toEqual(["store.json"]);
  });

  it("prefers the v2 files and counts every audit file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ss-json-store-"));
    await mkdir(path.join(dir, "live", "audits"), { recursive: true });
    const state = {
      schemaVersion: 2,
      sites: { s1: { id: "s1", name: "S", origin: "https://s.example", createdAt: "2026-10-29T00:00:00.000Z" } },
      pages: {},
      audits: {},
      tasks: {},
      settings: { ruleConfig: {}, severityOverrides: {} },
    };
    await writeFile(path.join(dir, "live", "state.json"), JSON.stringify(state));
    await writeFile(path.join(dir, "live", "audits", "a1.json"), JSON.stringify({ snapshots: [], findings: [] }));
    await writeFile(path.join(dir, "store.json"), JSON.stringify(v1)); // ignored: live/ exists
    const sources = await readJsonStore(dir);
    expect(sources.map((s) => s.from)).toEqual(["live/state.json + 1 audit files"]);
    const rows = await migrateJsonStore(pool, sources, { dryRun: false });
    expect(Object.fromEntries(rows.map((r) => [r.table, r.postgres]))).toEqual({ workspaces: 1, sites: 1, page_intents: 0, audits: 0, tasks: 0, audit_results: 1 });
  });
});
