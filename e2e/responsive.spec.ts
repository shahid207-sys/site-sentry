import { expect, test } from "@playwright/test";

const PAGES = [
  "/",
  "/features",
  "/how-it-works",
  "/methodology",
  "/sample-audit",
  "/sample",
  "/sample/sites",
  "/sample/sites/smp-site-nw",
  "/sample/audits",
  "/sample/audits/new",
  "/sample/audits/smp-013",
  "/sample/audits/smp-013?tab=pages",
  "/sample/audits/smp-013?tab=crawl",
  "/sample/audits/smp-013/compare",
  "/sample/issues",
  "/sample/tasks",
  "/sample/tasks/smp-004",
  "/sample/reports",
  "/sample/reports/smp-013",
  "/sample/settings",
  "/live",
];

for (const path of PAGES) {
  test(`no horizontal scroll: ${path}`, async ({ page }) => {
    await page.goto(path, { waitUntil: "networkidle" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("mobile navigation drawer opens and navigates", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "The drawer only exists below md.");
  await page.goto("/sample");
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Issues" }).click();
  await expect(page.getByRole("heading", { name: "Issues", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close menu" })).toHaveCount(0);
});

test("public site menu opens, closes on Escape and navigates", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "The menu button only exists below lg.");
  await page.goto("/");
  const toggle = page.getByRole("button", { name: /menu/i });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Methodology" }).click();
  await expect(page.getByRole("heading", { name: /Evidence first/, level: 1 })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("print layout hides app chrome and keeps every row", async ({ page }, info) => {
  test.skip(info.project.name !== "tablet", "Print rendering is viewport-independent; run once.");
  await page.emulateMedia({ media: "print" });
  await page.goto("/sample/audits/smp-013/compare", { waitUntil: "networkidle" });
  await expect(page.getByRole("complementary")).toBeHidden();
  await expect(page.getByRole("banner")).toBeHidden();
  await expect(page.getByRole("button", { name: /Show all/ })).toBeHidden();
  // The persistent group is collapsed on screen (10 rows) but prints in full.
  const persistent = page.locator("#change-persistent li");
  await expect(persistent).toHaveCount(10);
  for (const li of await persistent.all()) await expect(li).toBeVisible();
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(255, 255, 255)");
});
