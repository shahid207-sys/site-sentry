import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { resetSample, trackErrors } from "./helpers";

test.beforeEach(async ({ request }) => resetSample(request));
test.afterAll(async ({ request }) => resetSample(request));

test("sample fix loop: investigate, create task, verify failing, deploy fix, verify passing", async ({ page }) => {
  const errors = trackErrors(page);

  // Overview
  await page.goto("/sample");
  await expect(page.getByRole("heading", { name: "SEO operations overview", level: 1 })).toBeVisible();
  await expect(page.getByText(/Two fictional sites with deterministic results/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Next actions" })).toBeVisible();

  // Sites → site dashboard
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Sites" }).click();
  await expect(page.getByRole("heading", { name: "Sites", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Northwind Outdoor", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Northwind Outdoor", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Important URLs" })).toBeVisible();

  // Latest audit results
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Audits" }).click();
  await expect(page.getByRole("heading", { name: "Audits", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Northwind Outdoor", exact: true }).first().click();
  await expect(page.getByText("15 findings")).toBeVisible();

  // Filter by severity, then by text; both are reflected in the URL
  await page.getByRole("group", { name: "Severity" }).getByRole("button", { name: "high" }).click();
  await expect(page.getByText("1 of 15 findings")).toBeVisible();
  await expect(page).toHaveURL(/severity=high/);
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.getByPlaceholder("Search title, rule, URL, value…").fill("meta description");
  await expect(page.getByText(/^\d+ of 15 findings$/)).toBeVisible();
  await expect(page).toHaveURL(/q=meta/);
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByText("15 findings")).toBeVisible();

  // Open the finding and review its evidence
  await page.getByRole("button", { name: "Missing <title> element" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText("Observation · measured")).toBeVisible();
  await expect(drawer.getByText("Acceptance criteria")).toBeVisible();
  await expect(drawer.getByText("titleCount")).toBeVisible();

  // Create a task from it
  await drawer.getByRole("button", { name: "Create fix task" }).click();
  const modal = page.getByRole("dialog", { name: "Create fix task" });
  await modal.getByLabel("Owner").fill("E2E tester");
  await modal.getByRole("button", { name: "Create task" }).click();
  await expect(page).toHaveURL(/\/sample\/tasks\/[\w-]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Missing <title> element");
  await expect(page.getByLabel("Owner")).toHaveValue("E2E tester");

  // Workflow moves
  await page.getByRole("button", { name: "In progress" }).click();
  await expect(page.getByText("Moved to In progress")).toBeVisible();
  await page.getByRole("button", { name: "Ready to verify" }).click();
  await expect(page.getByText("Moved to Ready to verify")).toBeVisible();

  // Verify against the still-broken site
  await page.getByRole("button", { name: "Verify now" }).click();
  await expect(page.getByText("Still failing")).toBeVisible();
  await expect(page.getByRole("region", { name: "Verification history" }).getByText("Failing")).toBeVisible();
  const taskUrl = page.url();

  // "Deploy" the fix with the sample simulator, then verify again
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await page.getByRole("radio", { name: "Fully fixed" }).click();
  await expect(page.getByText("Simulated sites: Fully fixed")).toBeVisible();
  await page.goto(taskUrl);
  await page.getByRole("button", { name: "Verify now" }).click();
  await expect(page.getByText("Verified: all criteria pass")).toBeVisible();
  await page.getByRole("button", { name: "Resolved" }).click();
  await expect(page.getByText("Moved to Resolved")).toBeVisible();

  // The task shows up in the queue under Closed
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Fix Queue" }).click();
  await expect(page.getByRole("heading", { name: "Fix Queue", level: 1 })).toBeVisible();
  await page.getByRole("radio", { name: /Closed/ }).click();
  await expect(page.getByRole("link", { name: /Missing <title> element/ })).toBeVisible();

  expect(errors).toEqual([]);
});

test("comparison, exports and reports reflect stored audits", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/sample/audits/smp-013/compare");
  await expect(page.getByRole("heading", { name: "What changed on Northwind Outdoor" })).toBeVisible();
  await expect(page.getByRole("region").filter({ hasText: "Not found before on a scope" })).toBeVisible();

  // Filtered CSV export matches the on-screen filter
  await page.goto("/sample/audits/smp-013?severity=high");
  await expect(page.getByText("1 of 15 findings")).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "CSV" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^northwind-outdoor-2026-10-15-sample-findings\.csv$/);
  const csv = (await readFile((await download.path())!, "utf8")).replace(/^﻿/, "").trim().split("\r\n");
  expect(csv[0]).toContain("priority,severity");
  expect(csv).toHaveLength(2);

  // Printable audit report
  await page.goto("/sample/reports");
  await page.getByRole("link", { name: "Open report" }).click();
  await expect(page.getByRole("article", { name: "Audit report" })).toBeVisible();
  await expect(page.getByText("Priority 1")).toBeVisible();
  await expect(page.getByText(/Sample data: a fictional website/)).toBeVisible();

  // Developer handoff
  await page.goto("/sample/reports");
  await page.getByRole("link", { name: "Open handoff" }).click();
  await expect(page.getByRole("article", { name: "Developer handoff" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a new sample audit runs step by step to completion", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/sample/audits/new?site=smp-site-hd");
  await expect(page.getByRole("heading", { name: "New audit" })).toBeVisible();
  await expect(page.getByText("This audit will")).toBeVisible();
  await page.getByRole("radio", { name: "URL list" }).click();
  await page.getByLabel("URLs", { exact: true }).fill("/\n/book\n/services/");
  await expect(page.getByText("Inspect 3 listed URLs")).toBeVisible();
  await page.getByRole("button", { name: "Start audit" }).click();
  await expect(page).toHaveURL(/\/sample\/audits\/[\w-]+$/);
  // Either the progress panel or (if it finished instantly) the results.
  await expect(page.getByRole("tab", { name: /Findings/ }).or(page.getByRole("link", { name: /^Findings/ }))).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Completed").first()).toBeVisible();
  await expect(page.getByText(/New since previous/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("bulk actions in the fix queue respect allowed transitions", async ({ page }) => {
  await page.goto("/sample/tasks?view=all");
  await page.getByRole("checkbox", { name: "Select all" }).check();
  // Mixed statuses: no single move is valid for all of them.
  await expect(page.getByRole("combobox", { name: "Move selected to" })).toBeDisabled();
  await page.getByRole("button", { name: "Deselect" }).click();
  await page.getByRole("radio", { name: /Active/ }).click();
  await page.getByRole("checkbox", { name: /Important URL is blocked by robots\.txt/ }).check();
  await page.getByRole("button", { name: "Assign" }).click();
  await page.getByRole("dialog").getByLabel("Owner").fill("Bulk owner");
  await page.getByRole("dialog").getByRole("button", { name: "Assign", exact: true }).click();
  await expect(page.getByText("1 task updated")).toBeVisible();
  await expect(page.getByRole("row", { name: /Important URL is blocked/ })).toContainText("Bulk owner");
});

test("won't fix requires a reason", async ({ page }) => {
  await page.goto("/sample/tasks");
  await page.getByRole("link", { name: /Important URL is blocked by robots\.txt/ }).click();
  await page.getByRole("button", { name: "Won't fix" }).click();
  const dialog = page.getByRole("dialog", { name: "Won't fix this task?" });
  await expect(dialog.getByRole("button", { name: "Mark won't fix" })).toBeDisabled();
  await dialog.getByLabel("Reason").fill("Intentional: booking moved to a third-party system.");
  await dialog.getByRole("button", { name: "Mark won't fix" }).click();
  await expect(page.getByText("Intentional: booking moved to a third-party system.").first()).toBeVisible();
});

test("offline sample site makes verification inconclusive, not fixed", async ({ page, request }) => {
  await request.put("/api/sample/sample", { data: { state: "offline" } });
  await page.goto("/sample/tasks?view=ready");
  await page.getByRole("link", { name: /Page is blocked from indexing/ }).click();
  await page.getByRole("button", { name: "Verify now" }).click();
  await expect(page.getByText("Verification inconclusive")).toBeVisible();
});

test("validation and error states", async ({ page, request }) => {
  // Private and local targets are refused before anything is stored.
  for (const origin of ["http://127.0.0.1", "http://localhost:3000", "http://169.254.169.254", "ftp://example.com"]) {
    const r = await request.post("/api/live/sites", { data: { name: "x", origin } });
    expect(r.status(), origin).toBe(400);
  }
  // Sample sites are read-only on the server, not just hidden in the UI.
  expect((await request.post("/api/sample/sites", { data: { name: "x", origin: "https://example.com" } })).status()).toBe(403);
  expect((await request.get("/api/nope/overview")).status()).toBe(404);
  expect((await request.post("/api/sample/tasks", { data: "not json" })).status()).toBe(400);

  // UI: inline validation on the add-site form (live workspace, nothing is created).
  await page.goto("/live/sites?add=1");
  await page.getByLabel("Name").fill("Local test");
  await page.getByLabel("Address").fill("http://192.168.1.10");
  await page.getByRole("button", { name: "Add site" }).last().click();
  const fieldError = page.locator("p[role=alert]");
  await expect(fieldError).toBeVisible();
  await expect(page.getByLabel("Address")).toHaveAttribute("aria-invalid", "true");

  // Unknown ids show a not-found state, not a crash.
  await page.goto("/sample/audits/does-not-exist");
  await expect(page.getByText("Not found", { exact: true })).toBeVisible();
  await page.goto("/sample/tasks/does-not-exist");
  await expect(page.getByText("Task not found.")).toBeVisible();
});

test("command palette and labelled sidebar", async ({ page }) => {
  await page.goto("/sample");
  await expect(page.getByRole("region", { name: "Next actions" })).toBeVisible();
  // Sidebar items always show their labels, in workflow order.
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link")).toHaveText(["Overview", "Sites", "Audits", "Issues", "Fix Queue", "Reports", "Settings"]);
  await expect(nav.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");

  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Search and jump to" });
  await palette.getByPlaceholder("Jump to a section or site…").fill("harbor");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Harbor Family Dental", level: 1 })).toBeVisible();
});

test("issues are grouped by check, with every instance one click away", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/sample/issues");
  await expect(page.getByText(/\d+ issue types? · \d+ instances?/)).toBeVisible();
  await page.getByRole("radio", { name: "Every page" }).click();
  await expect(page).toHaveURL(/view=list/);
  await page.getByRole("radio", { name: "Grouped by check" }).click();
  await expect(page).not.toHaveURL(/view=list/);
  expect(errors).toEqual([]);
});

test("every workspace page has a breadcrumb trail rooted at the workspace", async ({ page }) => {
  const pages: [string, string][] = [
    ["/sample", "Overview"],
    ["/sample/sites", "Sites"],
    ["/sample/sites/smp-site-nw", "Northwind Outdoor"],
    ["/sample/audits", "Audits"],
    ["/sample/audits/new", "New audit"],
    ["/sample/audits/smp-013", "Northwind Outdoor ·"],
    ["/sample/audits/smp-013/compare", "Comparison"],
    ["/sample/issues", "Issues"],
    ["/sample/tasks", "Fix Queue"],
    ["/sample/tasks/smp-004", ""],
    ["/sample/reports", "Reports"],
    ["/sample/reports/smp-013", "Audit report"],
    ["/sample/reports/handoff?site=smp-site-nw", "Developer handoff"],
    ["/sample/settings", "Settings"],
    ["/live", "Overview"],
  ];
  for (const [path, current] of pages) {
    await page.goto(path);
    const trail = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(trail, path).toBeVisible();
    const items = trail.getByRole("listitem");
    await expect(items.first(), path).toHaveText(path.startsWith("/live") ? "Live workspace" : "Sample workspace");
    await expect(trail.locator("[aria-current=page]"), path).toContainText(current);
  }
  // Crumbs navigate: from a task back to the queue, then to the workspace root.
  await page.goto("/sample/tasks/smp-004");
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Fix Queue" }).click();
  await expect(page.getByRole("heading", { name: "Fix Queue", level: 1 })).toBeVisible();
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Sample workspace" }).click();
  await expect(page.getByRole("heading", { name: "SEO operations overview", level: 1 })).toBeVisible();
  // On the overview the root crumb is the current page, so it is not a link.
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link")).toHaveCount(0);
});

test("audits can be deleted one at a time or as a site's whole history", async ({ page, request }) => {
  const errors = trackErrors(page);
  const count = async (site?: string) => ((await (await request.get(`/api/sample/audits${site ? `?site=${site}` : ""}`)).json()) as unknown[]).length;
  const total = await count();

  // One audit, from its own page: confirm, then back to the list without it.
  await page.goto("/sample/audits/smp-013");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete this audit?" });
  await expect(dialog).toContainText("Fix tasks are kept");
  await dialog.getByRole("button", { name: "Delete audit" }).click();
  await expect(page).toHaveURL(/\/sample\/audits$/);
  await expect(page.getByText("Audit deleted")).toBeVisible();
  expect(await count()).toBe(total - 1);
  expect((await request.get("/api/sample/audits/smp-013")).status()).toBe(404);

  // Cancelling the recycle-bin dialog deletes nothing.
  await page.getByRole("button", { name: /^Delete audit of / }).first().click();
  await page.getByRole("dialog", { name: "Delete this audit?" }).getByRole("button", { name: "Cancel" }).click();
  expect(await count()).toBe(total - 1);

  // A whole site's history, from the filtered list.
  await page.goto("/sample/audits?site=smp-site-hd");
  await page.getByRole("button", { name: "Delete all audits of Harbor Family Dental" }).click();
  await page.getByRole("dialog", { name: /Delete all audits of Harbor Family Dental/ }).getByRole("button", { name: "Delete audit history" }).click();
  await expect(page.getByText("Audit history cleared for Harbor Family Dental")).toBeVisible();
  await expect(page.getByText("No audits yet")).toBeVisible();
  expect(await count("smp-site-hd")).toBe(0);
  expect((await request.get("/api/sample/sites/smp-site-hd")).ok()).toBe(true);
  expect(errors).toEqual([]);
});

test("new audit starts with no site selected and validates the choice", async ({ page }) => {
  await page.goto("/sample/audits/new?site=smp-site-hd");
  const select = page.getByLabel("Site", { exact: true });
  await expect(select).not.toHaveValue("");
  // The generic New audit entry point never carries a site, and nothing is persisted.
  await page.goto("/sample/audits/new");
  await expect(select).toHaveValue("");
  await expect(page.getByText("Choose a website before starting the audit.").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Start audit" })).toBeDisabled();
  await page.getByRole("link", { name: "New audit" }).first().click();
  await expect(page).toHaveURL(/\/sample\/audits\/new$/);
  await expect(select).toHaveValue("");
  const opts = await select.locator("option").allTextContents();
  expect(opts[0]).toBe("Choose a site");
  for (const o of opts) expect(o).not.toMatch(/·|(\b[\w.-]+\.\w+\b).*\b\1\b/);
  await select.selectOption({ index: 1 });
  await expect(page.getByRole("button", { name: "Start audit" })).toBeEnabled();
});
