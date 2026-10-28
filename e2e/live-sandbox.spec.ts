import { expect, test } from "@playwright/test";
import { trackErrors } from "./helpers";

// Writes to the LIVE workspace. Runs only against a server started with an empty, disposable
// SITE_SENTRY_DATA_DIR and E2E_LIVE_SANDBOX=1, so it can never touch real data.
test.skip(!process.env.E2E_LIVE_SANDBOX, "Set E2E_LIVE_SANDBOX=1 and point E2E_BASE_URL at a server with a throwaway data dir.");

test.beforeEach(async ({ request }) => {
  // Never clear data: refuse to run unless the live workspace is already empty (a fresh sandbox).
  const sites = (await (await request.get("/api/live/sites")).json()) as { site: { id: string } }[];
  if (sites.length) throw new Error(`Refusing to run: the live workspace at this server has ${sites.length} site(s). Use a server with an empty SITE_SENTRY_DATA_DIR.`);
  await request.put("/api/live/settings", { data: { ruleConfig: { thinContentWords: 250 }, severityOverrides: {} } });
});

test("live workspace: add a site, manage important URLs, delete the site", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/live");
  await expect(page.getByRole("region", { name: "Add your first site" })).toBeVisible();

  // Validation
  await page.getByRole("button", { name: "Add site" }).click();
  await expect(page.getByText("Give the site a name.")).toBeVisible();

  // Create (no fetch happens on creation; the origin is only validated)
  await page.getByLabel("Name").fill("Example Domain");
  await page.getByLabel("Address").fill("example.com");
  await page.getByRole("button", { name: "Add site" }).click();
  await expect(page.getByRole("heading", { name: "Example Domain", level: 1 })).toBeVisible();
  await expect(page.getByText("Not audited yet")).toBeVisible();

  // Duplicate origin is a conflict with a link to the existing site
  await page.goto("/live/sites?add=1");
  await page.getByLabel("Name").fill("Again");
  await page.getByLabel("Address").fill("https://example.com");
  await page.getByRole("button", { name: "Add site" }).last().click();
  await expect(page.getByText(/already set up as "Example Domain"/)).toBeVisible();
  await page.getByRole("link", { name: "Open the existing site" }).click();

  // Important URL: add, edit, remove
  await page.getByRole("button", { name: "Add URL" }).click();
  const add = page.getByRole("dialog", { name: "Add an important URL" });
  await add.getByLabel("URL", { exact: true }).fill("/pricing");
  await add.getByLabel("Page type").selectOption("landing");
  await add.getByLabel("Labels").fill("campaign, core");
  await add.getByRole("button", { name: "Add URL" }).click();
  const urls = page.getByRole("region", { name: "Important URLs" });
  const table = urls.getByRole("table");
  await expect(table.getByText("/pricing")).toBeVisible();
  await expect(table.getByText("campaign")).toBeVisible();

  await urls.getByRole("button", { name: "Edit /pricing" }).first().click();
  const edit = page.getByRole("dialog", { name: "Edit important URL" });
  await edit.getByLabel("Intended indexing").selectOption("noindex");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(table.getByRole("cell", { name: "Noindex" })).toBeVisible();

  await urls.getByRole("button", { name: "Remove /pricing" }).first().click();
  await page.getByRole("dialog", { name: "Remove this important URL?" }).getByRole("button", { name: "Remove" }).click();
  await expect(urls.getByText("No important URLs yet")).toBeVisible();

  // Settings are editable in the live workspace
  await page.goto("/live/settings");
  await page.getByLabel("Thin content threshold").fill("300");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Thin content threshold")).toHaveValue("300");

  // Delete with confirmation
  await page.goto("/live/sites");
  await page.getByRole("link", { name: "Example Domain" }).first().click();
  await page.getByRole("button", { name: "Delete site" }).click();
  await page.getByRole("dialog", { name: "Delete Example Domain?" }).getByRole("button", { name: "Delete permanently" }).click();
  await expect(page.getByRole("heading", { name: "Sites", level: 1 })).toBeVisible();
  await expect(page.getByText("Example Domain deleted")).toBeVisible();

  // Expected 4xx responses (validation, duplicate) are logged by the browser as resource errors.
  expect(errors.filter((e) => !/Failed to load resource: the server responded with a status of 4\d\d/.test(e)), errors.join("\n")).toEqual([]);
});
