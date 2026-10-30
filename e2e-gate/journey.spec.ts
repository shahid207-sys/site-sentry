// gate:p4 browser journeys (run by scripts/gate-p4.ts, one step per Playwright run, selected with --grep):
//   @audit   add the fixture site, run a Custom audit of /meta/ from the wizard, follow the live monitor until the
//            checks finish, triage on the Issues screen (assign, ignore with a reason, mark fixed: each read back from
//            the API), export a group as CSV, and run axe-core on every v2 screen in light and dark.
//   @verify  (the fixture's fix patch is on) Verify fix on the Fix board turns META-003 Verified.
//   @filter  time filter changes on the generated 50k-finding audit (performance measure "ss-filter").
// Each step writes what it observed to GATE_P4_OUT; the gate decides pass or fail from that file and the exit code.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const ORIGIN = process.env.GATE_P4_ORIGIN ?? "";
const GENERATED = process.env.GATE_P4_GENERATED ?? "";
const OUT = process.env.GATE_P4_OUT ?? "";
const AXE = readFileSync(path.join(process.cwd(), "node_modules/axe-core/axe.min.js"), "utf8");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const VERIFY_RULE = "META-003";

interface Out {
  auditId?: string;
  steps: { name: string; ok: boolean; detail: string }[];
  axe: { screen: string; theme: string; violations: { id: string; impact: string | null; nodes: number; help: string }[] }[];
  filter: { label: string; rows: number; ms: number }[];
}
const out: Out = { steps: [], axe: [], filter: [] };
const save = () => OUT && writeFileSync(OUT, JSON.stringify(out, null, 2));

/** Runs one named step and records it; a failure is recorded, then rethrown so the spec fails. */
async function step<T>(name: string, fn: () => Promise<{ value: T; detail: string }>): Promise<T> {
  try {
    const { value, detail } = await fn();
    out.steps.push({ name, ok: true, detail });
    save();
    return value;
  } catch (e) {
    out.steps.push({ name, ok: false, detail: (e as Error).message.split("\n")[0].slice(0, 300) });
    save();
    throw e;
  }
}

async function json<T>(page: Page, url: string): Promise<T> {
  const r = await page.request.get(url);
  expect(r.ok(), `${url} → HTTP ${r.status()}`).toBe(true);
  return (await r.json()) as T;
}

/** A screen is settled when the network is idle and no loading skeleton is left. */
async function settled(page: Page) {
  await page.waitForLoadState("networkidle");
  const loading = page.locator('[role=status][aria-label^="Loading"]');
  await expect
    .poll(() => loading.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label"))), { message: "loading regions left on the screen", timeout: 15_000 })
    .toEqual([]);
}

async function axe(page: Page, screen: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => {
      localStorage.setItem("ss-theme", t);
      document.documentElement.dataset.theme = t;
    }, theme);
    // Let the theme's tokens apply (CSS transitions are 150–200 ms).
    await page.waitForTimeout(400);
    if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ content: AXE });
    const violations = await page.evaluate(async (tags) => {
      // @ts-expect-error axe is injected above
      const r = await window.axe.run(document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] });
      return (r.violations as { id: string; impact: string | null; nodes: unknown[]; help: string }[]).map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help }));
    }, AXE_TAGS);
    out.axe.push({ screen, theme, violations });
  }
  save();
}

test("@audit add a site, audit it, triage, export, accessibility", async ({ page }) => {
  expect(ORIGIN, "GATE_P4_ORIGIN").not.toBe("");

  const siteId = await step("Add the site on the Sites screen", async () => {
    await page.goto("/live/sites?add=1");
    await page.locator("#site-name").fill("Gate fixture site");
    await page.locator("#site-origin").fill(ORIGIN);
    await page.getByRole("button", { name: "Add site", exact: true }).last().click();
    await expect(page.getByText("Gate fixture site added")).toBeVisible();
    const sites = await json<{ site: { id: string; origin: string } }[]>(page, "/api/live/sites");
    const s = sites.find((x) => x.site.origin === new URL(ORIGIN).origin);
    expect(s, "the new site is listed by the API").toBeTruthy();
    return { value: s!.site.id, detail: `site ${s!.site.id} (${ORIGIN})` };
  });

  const auditId = await step("Start a Custom audit of /meta/ from the wizard", async () => {
    await page.goto(`/live/audits/new?site=${siteId}`);
    await page.getByRole("radiogroup", { name: "Input method" }).getByRole("radio", { name: "Single URL" }).click();
    await page.locator("#na-url").fill("/meta/");
    await page.getByRole("radiogroup", { name: "Crawl profile" }).getByRole("radio", { name: "Custom" }).click();
    await page.locator("#na-sub").fill("/meta/");
    await page.getByRole("button", { name: "Start audit" }).click();
    await page.waitForURL(/\/live\/audits\/[^/?]+(\/progress)?$/);
    const id = new URL(page.url()).pathname.split("/")[3];
    out.auditId = id;
    return { value: id, detail: `audit ${id}` };
  });
  const auditBase = `/live/audits/${auditId}`;
  const auditApi = `/api/live/audits/${auditId}`;

  await step("The live monitor follows the crawl and the checks to the overview", async () => {
    // The wizard opens the audit page, which shows the live monitor and swaps it for the overview in place when the
    // analysis completes (no reload).
    await expect(page.getByRole("navigation", { name: "Audit sections" })).toBeVisible({ timeout: 8 * 60_000 });
    await expect(page.getByText("Analysis has not finished")).toHaveCount(0);
    const o = await json<{ analysed: boolean; issueGroups: number; health: { score: number } | null }>(page, `${auditApi}/overview`);
    expect(o.analysed).toBe(true);
    expect(o.issueGroups).toBeGreaterThan(0);
    return { value: null, detail: `${o.issueGroups} issue groups; health ${o.health?.score ?? "n/a"}` };
  });
  await settled(page);
  await axe(page, "Overview");

  type Triage = { entries: { subject: string; status: string; assignee: string | null; note: string | null }[] };
  const flat = page.getByRole("table", { name: "All issues" });
  const firstRow = () => flat.getByRole("row").nth(1);

  await step("Issues: assign an issue", async () => {
    await page.goto(`${auditBase}/issues?view=flat`);
    await settled(page);
    await firstRow().getByLabel("Select row").check();
    await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: "Assign…" }).click();
    await page.getByLabel("Assignee").fill("Gate reviewer");
    await page.getByRole("dialog").getByRole("button", { name: "Assign", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const t = await json<Triage>(page, `${auditApi}/triage`);
    const e = t.entries.find((x) => x.assignee === "Gate reviewer");
    expect(e, "an entry with the assignee").toBeTruthy();
    return { value: null, detail: `${e!.subject} assigned` };
  });
  await axe(page, "Issues (all URLs)");

  await step("Issues: ignore an issue with a reason", async () => {
    const deselect = page.getByRole("button", { name: "Deselect" });
    if (await deselect.isVisible()) await deselect.click();
    await flat.getByRole("row").nth(2).getByLabel("Select row").check();
    await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: "Ignore…" }).click();
    // No reason: refused.
    await page.getByRole("dialog").getByRole("button", { name: "Ignore", exact: true }).click();
    await expect(page.getByText("Say why these issues are ignored.")).toBeVisible();
    await page.getByLabel("Reason (required)").fill("Gate: intentionally left as is");
    await page.getByRole("dialog").getByRole("button", { name: "Ignore", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const t = await json<Triage>(page, `${auditApi}/triage`);
    const e = t.entries.find((x) => x.status === "ignored");
    expect(e?.note).toBe("Gate: intentionally left as is");
    return { value: null, detail: `${e!.subject} ignored with its reason` };
  });

  await step("Issues: mark an issue fixed", async () => {
    const deselect = page.getByRole("button", { name: "Deselect" });
    if (await deselect.isVisible()) await deselect.click();
    await flat.getByRole("row").nth(3).getByLabel("Select row").check();
    await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: "Mark fixed" }).click();
    await expect.poll(async () => (await json<Triage>(page, `${auditApi}/triage`)).entries.filter((x) => x.status === "fixed").length).toBeGreaterThan(0);
    // A mark is a claim: the counts do not move.
    const o = await json<{ states: Record<string, number> }>(page, `${auditApi}/overview`);
    return { value: null, detail: `marked fixed; overview states unchanged: ${JSON.stringify(o.states)}` };
  });

  await step(`Issues: export the ${VERIFY_RULE} group as CSV`, async () => {
    await page.goto(`${auditBase}/issues`);
    await settled(page);
    await page.getByRole("button", { name: new RegExp(`^Details of ${VERIFY_RULE}`) }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Export CSV" }).click()]);
    const file = await download.path();
    const lines = readFileSync(file, "utf8").trim().split(/\r?\n/);
    expect(lines.length).toBeGreaterThan(1);
    // Each row is one affected URL of the group, on the audited site.
    expect(lines.slice(1).every((l) => l.includes(new URL(ORIGIN).host))).toBe(true);
    return { value: null, detail: `${download.suggestedFilename()}: header + ${lines.length - 1} rows` };
  });
  await page.keyboard.press("Escape");
  await axe(page, "Issues (by rule)");

  // Every other v2 screen of the audit.
  const urls = await json<{ url: string }[]>(page, `${auditApi}/urls`);
  const screens: [string, string][] = [
    ["URLs", `${auditBase}/urls`],
    ["Page inspector", `${auditBase}/inspect?url=${encodeURIComponent(urls[0]?.url ?? `${ORIGIN}/meta/`)}`],
    ["Architecture", `${auditBase}/architecture`],
    ["Content", `${auditBase}/content`],
    ["Fix board", `${auditBase}/board`],
    ["Compare", `${auditBase}/compare`],
    ["Report", `/live/reports/${auditId}`],
    ["Live monitor", `${auditBase}/progress`],
  ];
  for (const [name, url] of screens) {
    await page.goto(url);
    await settled(page);
    await axe(page, name);
  }
  save();
});

test("@verify Verify fix on the Fix board earns Verified", async ({ page }) => {
  const auditId = process.env.GATE_P4_AUDIT ?? "";
  expect(auditId, "GATE_P4_AUDIT").not.toBe("");
  out.auditId = auditId;
  await step(`Verify fix for ${VERIFY_RULE}`, async () => {
    await page.goto(`/live/audits/${auditId}/board`);
    await settled(page);
    const card = page.getByTestId(`card-${VERIFY_RULE}`);
    await expect(card).not.toHaveAttribute("data-column", "verified");
    await card.getByRole("button", { name: `Verify fix for ${VERIFY_RULE}` }).click();
    // The verification re-crawls the group's URLs and analyses them; the board reloads when it is done.
    await expect(page.getByTestId(`card-${VERIFY_RULE}`)).toHaveAttribute("data-column", "verified", { timeout: 5 * 60_000 });
    const v = await json<{ status: string; states: Record<string, number> } | { verification: null }>(page, `/api/live/audits/${auditId}/groups/${VERIFY_RULE}/verify`);
    expect("status" in v && v.status).toBe("analysed");
    return { value: null, detail: `card in Verified; verification ${JSON.stringify("states" in v ? v.states : v)}` };
  });
  await axe(page, "Fix board (after verify)");
});

test("@filter filter 50k generated findings", async ({ page }) => {
  expect(GENERATED, "GATE_P4_GENERATED").not.toBe("");
  const rows = await step("Open the generated audit's flat issue list", async () => {
    await page.goto(`/live/audits/${GENERATED}/issues?view=flat`);
    await settled(page);
    const count = await page.getByTestId("issue-count").innerText();
    expect(count.replace(/[^\d]/g, "")).toMatch(/^50000/);
    return { value: 50_000, detail: count.trim() };
  });

  const input = page.locator("[data-filter-input]");
  // Typing that narrows, widens, regex, a no-match and clearing: each keystroke is one filter change.
  // Each expected count follows from the generated data: 5,000 URLs /section-(i % 50)/page-i, 10 rules each.
  const inputs: [string, string, number][] = [
    ["section-1", "type 'section-1'", 11_000],
    ["section-12", "narrow to 'section-12'", 1_000],
    ["page-49", "replace with 'page-49'", 1_110],
    ["re:page-4\\d{3}$", "regex", 10_000],
    ["zzz-nothing", "no match", 0],
    ["", "clear", 50_000],
  ];
  const lastMeasure = () =>
    page.evaluate(() => {
      const e = performance.getEntriesByName("ss-filter");
      return e[e.length - 1].duration;
    });
  const shownCount = async () => Number((await page.getByTestId("issue-count").innerText()).split(" of ")[0].replace(/[^\d]/g, ""));
  await page.evaluate(() => performance.clearMeasures("ss-filter"));
  for (const [value, label, expected] of inputs) {
    const before = await page.evaluate(() => performance.getEntriesByName("ss-filter").length);
    await input.fill(value);
    await expect.poll(() => page.evaluate(() => performance.getEntriesByName("ss-filter").length)).toBeGreaterThan(before);
    const ms = await lastMeasure();
    await expect.poll(shownCount, { message: `rows shown for ${label}` }).toBe(expected);
    out.filter.push({ label: `${label} → ${expected.toLocaleString("en")} rows`, rows, ms });
  }
  // A filter select (State) over the same rows; the select marks the change itself.
  const before = await page.evaluate(() => performance.getEntriesByName("ss-filter").length);
  await page.getByLabel("State").selectOption({ index: 1 });
  await expect.poll(() => page.evaluate(() => performance.getEntriesByName("ss-filter").length)).toBeGreaterThan(before);
  out.filter.push({ label: `State filter (select) → ${(await shownCount()).toLocaleString("en")} rows`, rows, ms: await lastMeasure() });
  save();
  out.steps.push({ name: "Filter timings", ok: true, detail: out.filter.map((f) => `${f.label}: ${f.ms.toFixed(1)} ms`).join("; ") });
  save();
});
