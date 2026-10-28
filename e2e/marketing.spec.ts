import { expect, test } from "@playwright/test";
import { trackErrors } from "./helpers";

test("homepage explains the product and links into the sample", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "From SEO findings to fixes you can verify.", level: 1 })).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Main" });
  for (const name of ["Product", "How it works", "Sample audit", "Methodology"]) await expect(nav.getByRole("link", { name })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open workspace" }).first()).toHaveAttribute("href", "/live");

  // The product preview is built from the real engine and labelled as sample data.
  await expect(page.getByText("Sample data").first()).toBeVisible();

  // FAQ items are real disclosure widgets.
  const faq = page.locator("details").first();
  await faq.locator("summary").click();
  await expect(faq).toHaveAttribute("open", "");

  await page.getByRole("link", { name: /Explore an interactive sample audit/ }).click();
  await expect(page).toHaveURL(/\/sample-audit$/);
  await page.getByRole("link", { name: "Open the sample workspace" }).click();
  await expect(page.getByRole("heading", { name: "SEO operations overview", level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
});

test("hero audit form validates before calling the server", async ({ page }) => {
  let posted = false;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/")) posted = true;
  });
  await page.goto("/");
  const form = page.locator("#audit");
  const input = form.getByRole("textbox");
  for (const bad of ["", "localhost", "http://intranet", "ftp://example.com"]) {
    await input.fill(bad);
    await form.getByRole("button", { name: /audit/i }).click();
    await expect(form.getByRole("alert"), bad || "(empty)").toBeVisible();
    await expect(input).toHaveAttribute("aria-invalid", "true");
  }
  expect(posted).toBe(false);
});

test("public pages render and /app aliases the workspace", async ({ page }) => {
  const errors = trackErrors(page);
  for (const [path, h1] of [
    ["/features", /Everything you need for complete SEO operations/],
    ["/how-it-works", /four-step workflow from audit to verified results/],
    ["/methodology", /Evidence first/],
    ["/sample-audit", /Explore a full audit/],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 }), path).toHaveText(h1);
  }
  await page.goto("/app/fix-queue");
  await expect(page).toHaveURL(/\/live\/tasks$/);
  await page.goto("/app");
  await expect(page).toHaveURL(/\/live$/);
  expect(errors).toEqual([]);
});
