import { expect, type APIRequestContext, type Page } from "@playwright/test";

export async function resetSample(request: APIRequestContext) {
  const r = await request.put("/api/sample/sample", { data: { reset: true } });
  expect(r.ok()).toBeTruthy();
}

export async function setSampleState(request: APIRequestContext, state: "original" | "current" | "fixed" | "offline") {
  const r = await request.put("/api/sample/sample", { data: { state } });
  expect(r.ok()).toBeTruthy();
}

/** Collect console errors and uncaught exceptions for the whole test. */
export function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  return errors;
}
