// Playwright render pool (docs/SPEC.md Phase 5): renders crawled pages in headless Chromium to see what JavaScript
// changes. At most RENDER_BROWSERS browsers (default 1, max 4), each recycled after 100 pages; one isolated context
// per page; a 20 s budget per page.
//
// The browser never touches the network itself. Every request the page makes is intercepted and either fulfilled
// with the response of the SSRF-guarded fetcher (the same one the crawler uses: validated URL, pinned public
// address, allowed ports) or aborted. The page's own document is fulfilled from the HTML the crawler already
// stored, so the raw and rendered views come from one response. Backstops in case a request slips past
// interception: Chromium resolves no host name (--host-resolver-rules) and sends anything else to a dead proxy;
// service workers are blocked and WebSockets are closed without connecting.
import axe from "axe-core";
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Route } from "playwright";
import { SafeFetchError, type Fetcher } from "../fetch/safe-fetch";
import { isBlockedHost } from "./blocklist";

export const MAX_RENDER_BROWSERS = 4;
export const PAGES_PER_BROWSER = 100;
export const RENDER_BUDGET_MS = 20_000;
/** Requests kept on a render record (totals count all of them). */
export const MAX_LOGGED_REQUESTS = 300;
/** Elements kept per axe rule and per script-link kind. */
export const MAX_NODES = 20;
export const RENDER_USER_AGENT = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36 SiteSentryBot/1.0 (+https://sitesentry.app/bot)";
/**
 * A phone-sized viewport, as Google renders with its smartphone crawler. No CPU or network throttling. Not Chrome's
 * mobile emulation: with it, Chrome marks the layout shifts of the first half second as caused by input, which
 * removes them from CLS (measured: a 0.16 shift reported as input under emulation, counted without it).
 */
export const RENDER_VIEWPORT = { width: 412, height: 915 } as const;

/** axe-core rules the A11Y rules read (A11Y-001..004). target-size is WCAG 2.2's 24 px minimum. */
export const AXE_RULES = ["color-contrast", "label", "select-name", "button-name", "link-name", "input-button-name", "target-size"] as const;
export type AxeRuleId = (typeof AXE_RULES)[number];

/** RENDER_BROWSERS from the environment: default 1, clamped to 1..4. */
export function renderBrowsers(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.RENDER_BROWSERS ?? "", 10);
  return Number.isFinite(n) ? Math.min(MAX_RENDER_BROWSERS, Math.max(1, n)) : 1;
}

export interface RequestRecord {
  url: string;
  /** Playwright resource type: document, script, stylesheet, image, font, fetch, xhr, media, other... */
  type: string;
  outcome: "fulfilled" | "blocked" | "failed";
  /** Why a request was blocked or failed: "ads_analytics", "robots", "method", "ssrf" (refused target), "budget", or the fetch error. */
  reason?: string;
  status?: number;
  /** Bytes on the wire: Content-Length of a compressed response, else the decoded size. */
  transferBytes?: number;
  contentType?: string;
  cacheControl?: string;
  expires?: string;
  /** Not the page's own host, nor a subdomain of it (without "www."). */
  thirdParty: boolean;
}

export interface RenderMetrics {
  /** Lab data: one load in the render worker's browser, no throttling. Never field data. */
  source: "lab";
  lcpMs: number | null;
  /** CLS as Chrome defines it: the largest session window of unexpected layout shifts. */
  cls: number | null;
  lcpElement: { tag: string | null; url: string | null; loading: string | null; selector: string | null } | null;
  domNodes: number;
  viewport: { width: number; height: number };
}

export interface ScriptLink {
  tag: string;
  text: string;
  /** The inline onclick handler (capped), when there is one. */
  onclick: string | null;
  /** A URL literal found in the handler, if any. */
  target: string | null;
  selector: string;
}

export interface AxeNode {
  selector: string;
  html: string;
  summary: string;
}

export interface RenderResult {
  status: "rendered" | "timeout" | "error";
  error?: string;
  url: string;
  /** The URL the page ended on (a script may have changed it with history.pushState). */
  finalUrl: string;
  /** Serialised DOM after rendering; null when the page did not load. */
  html: string | null;
  elapsedMs: number;
  metrics: RenderMetrics | null;
  requests: RequestRecord[];
  requestTotals: { count: number; fulfilled: number; blocked: number; failed: number; logged: number };
  /** Navigations away from the page a script attempted (aborted; the render stays on the page). */
  scriptNavigations: string[];
  /** Elements that act as links only through JavaScript: inline onclick handlers and <a> without href. */
  scriptLinks: { onclick: ScriptLink[]; noHref: ScriptLink[]; counts: { onclick: number; noHref: number } } | null;
  /** Violations per axe rule (null when axe could not run). */
  a11y: { version: string; rules: Partial<Record<AxeRuleId, { count: number; nodes: AxeNode[] }>> } | null;
  consoleErrors: number;
}

/** May a request of the page go out? Same-host requests pass robots.txt and the host's politeness throttle here. */
export type RenderGate = (url: URL, signal: AbortSignal) => Promise<{ ok: true; done: (outcome: { status?: number; elapsedMs?: number }) => Promise<void> } | { ok: false; reason: string }>;

export interface RenderPoolOptions {
  fetch: Fetcher;
  browsers?: number;
  pagesPerBrowser?: number;
  budgetMs?: number;
  gate?: RenderGate;
  userAgent?: string;
  /** Extra launch options (tests). */
  launch?: LaunchOptions;
}

export interface RenderJob {
  /** The page URL (the snapshot's final URL). */
  url: string;
  /** The HTML the crawler stored for it: the document the browser renders. */
  html: string;
  signal?: AbortSignal;
  /** This page's gate (its crawl's robots.txt and host throttle); defaults to the pool's. */
  gate?: RenderGate;
}

const LAUNCH_ARGS = [
  // No name resolves inside the browser: anything not fulfilled by the route handler cannot reach a host by name.
  "--host-resolver-rules=MAP * ~NOTFOUND",
  // And anything else (an IP literal) goes to a proxy that is not there, loopback included.
  "--proxy-server=http://127.0.0.1:9",
  "--proxy-bypass-list=<-loopback>",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-sync",
  "--no-pings",
  "--dns-prefetch-disable",
];

interface Slot {
  browser: Browser | null;
  pages: number;
  busy: boolean;
}

export class RenderPool {
  private readonly slots: Slot[];
  private readonly waiters: ((s: Slot) => void)[] = [];
  private readonly perBrowser: number;
  private readonly budgetMs: number;
  private closed = false;
  /** Browsers launched so far (recycling launches new ones). */
  launched = 0;

  constructor(private readonly opts: RenderPoolOptions) {
    const n = Math.min(MAX_RENDER_BROWSERS, Math.max(1, opts.browsers ?? 1));
    this.slots = Array.from({ length: n }, () => ({ browser: null, pages: 0, busy: false }));
    this.perBrowser = opts.pagesPerBrowser ?? PAGES_PER_BROWSER;
    this.budgetMs = opts.budgetMs ?? RENDER_BUDGET_MS;
  }

  get size(): number {
    return this.slots.length;
  }

  async render(job: RenderJob): Promise<RenderResult> {
    const slot = await this.take();
    try {
      if (slot.browser && slot.pages >= this.perBrowser) {
        await slot.browser.close().catch(() => {});
        slot.browser = null;
      }
      if (!slot.browser || !slot.browser.isConnected()) {
        slot.browser = await chromium.launch({ headless: true, ...this.opts.launch, args: [...LAUNCH_ARGS, ...(this.opts.launch?.args ?? [])] });
        slot.pages = 0;
        this.launched++;
      }
      slot.pages++;
      return await this.renderIn(slot.browser, job);
    } finally {
      this.give(slot);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.slots.map((s) => s.browser?.close().catch(() => {})));
    for (const s of this.slots) s.browser = null;
  }

  private take(): Promise<Slot> {
    if (this.closed) return Promise.reject(new Error("The render pool is closed."));
    const free = this.slots.find((s) => !s.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    return new Promise((r) => this.waiters.push(r));
  }

  private give(slot: Slot): void {
    const next = this.waiters.shift();
    if (next) next(slot);
    else slot.busy = false;
  }

  private async renderIn(browser: Browser, job: RenderJob): Promise<RenderResult> {
    const started = Date.now();
    const deadline = started + this.budgetMs;
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(new Error("budget")), this.budgetMs);
    const onAbort = () => stop.abort(job.signal?.reason);
    job.signal?.addEventListener("abort", onAbort, { once: true });

    const pageUrl = new URL(job.url);
    pageUrl.hash = "";
    const base = pageUrl.hostname.replace(/^www\./, "");
    const thirdParty = (u: URL) => !(u.hostname === base || u.hostname.endsWith(`.${base}`));
    const requests: RequestRecord[] = [];
    const totals = { count: 0, fulfilled: 0, blocked: 0, failed: 0, logged: 0 };
    const log = (r: RequestRecord) => {
      totals.count++;
      totals[r.outcome]++;
      if (requests.length < MAX_LOGGED_REQUESTS) requests.push(r);
      totals.logged = requests.length;
    };
    const scriptNavigations: string[] = [];
    let documentServed = false;
    let consoleErrors = 0;

    const result = (status: RenderResult["status"], extra: Partial<RenderResult> = {}): RenderResult => ({
      status,
      url: pageUrl.toString(),
      finalUrl: pageUrl.toString(),
      html: null,
      elapsedMs: Date.now() - started,
      metrics: null,
      requests,
      requestTotals: totals,
      scriptNavigations,
      scriptLinks: null,
      a11y: null,
      consoleErrors,
      ...extra,
    });

    let context: BrowserContext | null = null;
    try {
      context = await browser.newContext({
        serviceWorkers: "block",
        // axe is injected into pages whose CSP would refuse it; the page's own CSP still governs its own scripts' content.
        bypassCSP: true,
        acceptDownloads: false,
        userAgent: this.opts.userAgent ?? RENDER_USER_AGENT,
        viewport: RENDER_VIEWPORT,
        deviceScaleFactor: 1,
        locale: "en-US",
      });
      await context.routeWebSocket(/.*/, (ws) => {
        log({ url: ws.url(), type: "websocket", outcome: "blocked", reason: "websocket", thirdParty: safeThirdParty(ws.url(), thirdParty) });
        void ws.close({ code: 1008, reason: "WebSockets are not opened while rendering." });
      });
      await context.route("**/*", (route) => this.handle(route, { pageUrl, html: job.html, gate: job.gate ?? this.opts.gate, deadline, signal: stop.signal, log, thirdParty, scriptNavigations, documentServed: () => documentServed, serve: () => (documentServed = true) }));
      await context.addInitScript({ content: METRICS_SCRIPT });

      const page = await context.newPage();
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors++;
      });
      page.on("pageerror", () => consoleErrors++);

      try {
        // Wait for the load event inside the page: once a script starts a navigation (aborted in handle), Playwright's
        // own load tracking follows the cancelled navigation and never resolves, although the document has loaded.
        await page.goto(pageUrl.toString(), { waitUntil: "commit", timeout: Math.max(1, deadline - Date.now()) });
        await page.waitForFunction("document.readyState === 'complete'", undefined, { timeout: Math.max(1, deadline - Date.now()), polling: 100 });
      } catch (e) {
        if (stop.signal.aborted || isTimeout(e)) return result("timeout", { error: `The page did not finish loading within ${this.budgetMs / 1000} s.` });
        throw e;
      }
      // Let late scripts and their requests settle, within the budget (a page that never goes idle still counts).
      await page.waitForLoadState("networkidle", { timeout: Math.max(1, Math.min(5_000, deadline - Date.now() - 4_000)) }).catch(() => {});
      if (Date.now() >= deadline) return result("timeout", { error: `The page did not settle within ${this.budgetMs / 1000} s.` });

      const metrics = (await page.evaluate(READ_METRICS)) as Omit<RenderMetrics, "source" | "viewport">;
      const scriptLinks = (await page.evaluate(`(${SCRIPT_LINKS})(${MAX_NODES})`)) as RenderResult["scriptLinks"];
      const html = await page.content();
      const finalUrl = page.url();
      let a11y: RenderResult["a11y"] = null;
      if (deadline - Date.now() > 1_000) {
        try {
          await page.evaluate(axe.source);
          a11y = (await Promise.race([
            page.evaluate(`(${RUN_AXE})(${JSON.stringify({ rules: AXE_RULES, max: MAX_NODES })})`),
            new Promise((_, rej) => setTimeout(() => rej(new Error("axe ran out of time")), Math.max(1, deadline - Date.now()))),
          ])) as RenderResult["a11y"];
        } catch {
          a11y = null;
        }
      }
      return result("rendered", { html, finalUrl, metrics: { source: "lab", ...metrics, viewport: { ...RENDER_VIEWPORT } }, scriptLinks, a11y });
    } catch (e) {
      if (stop.signal.aborted && !job.signal?.aborted) return result("timeout", { error: `The render ran out of its ${this.budgetMs / 1000} s budget.` });
      return result("error", { error: ((e as Error)?.message ?? String(e)).split("\n")[0].slice(0, 500) });
    } finally {
      clearTimeout(timer);
      job.signal?.removeEventListener("abort", onAbort);
      stop.abort(new Error("done"));
      await context?.close().catch(() => {});
    }
  }

  private async handle(
    route: Route,
    c: {
      pageUrl: URL;
      html: string;
      gate?: RenderGate;
      deadline: number;
      signal: AbortSignal;
      log: (r: RequestRecord) => void;
      thirdParty: (u: URL) => boolean;
      scriptNavigations: string[];
      documentServed: () => boolean;
      serve: () => void;
    },
  ): Promise<void> {
    const req = route.request();
    const raw = req.url();
    if (raw.startsWith("data:") || raw.startsWith("blob:")) return route.continue();
    const type = req.resourceType();
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return route.abort("blockedbyclient");
    }
    const third = c.thirdParty(url);
    const block = async (reason: string, outcome: "blocked" | "failed" = "blocked") => {
      c.log({ url: raw, type, outcome, reason, thirdParty: third });
      await route.abort(outcome === "blocked" ? "blockedbyclient" : "failed").catch(() => {});
    };

    const main = req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame();
    if (main) {
      const target = new URL(raw);
      target.hash = "";
      if (!c.documentServed() && target.toString() === c.pageUrl.toString()) {
        c.serve();
        c.log({ url: raw, type, outcome: "fulfilled", status: 200, transferBytes: Buffer.byteLength(c.html), contentType: "text/html; charset=utf-8", thirdParty: false });
        return route.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: c.html });
      }
      // A script sending the browser elsewhere: recorded, not followed (the render is of this page). ERR_ABORTED
      // cancels the navigation and leaves the current document; other errors would replace it with an error page.
      if (c.scriptNavigations.length < MAX_NODES) c.scriptNavigations.push(raw);
      c.log({ url: raw, type, outcome: "blocked", reason: "navigation", thirdParty: third });
      return route.abort("aborted").catch(() => {});
    }
    // A rendered audit reads; it never submits or posts.
    if (req.method() !== "GET") return block("method");
    if (url.protocol !== "http:" && url.protocol !== "https:") return block("scheme");
    if (isBlockedHost(url.hostname)) return block("ads_analytics");
    if (Date.now() >= c.deadline || c.signal.aborted) return block("budget", "failed");

    let pass: Awaited<ReturnType<RenderGate>> | null = null;
    if (c.gate) {
      try {
        pass = await c.gate(url, c.signal);
      } catch {
        return block("budget", "failed");
      }
      if (!pass.ok) return block(pass.reason);
    }
    const t = Date.now();
    try {
      const res = await this.opts.fetch(raw, { accept: "resource", followRedirects: false, signal: c.signal, timeoutMs: Math.max(1, c.deadline - Date.now()), userAgent: this.opts.userAgent ?? RENDER_USER_AGENT });
      if (pass?.ok) await pass.done({ status: res.status, elapsedMs: res.elapsedMs });
      const body = res.raw ?? Buffer.alloc(0);
      const wire = Number.parseInt(res.headers["content-length"] ?? "", 10);
      c.log({
        url: raw,
        type,
        outcome: "fulfilled",
        status: res.status,
        transferBytes: res.headers["content-encoding"] && Number.isFinite(wire) ? wire : res.bytes,
        contentType: res.contentType || undefined,
        cacheControl: res.headers["cache-control"],
        expires: res.headers.expires,
        thirdParty: third,
      });
      const headers: Record<string, string> = {};
      if (res.contentType) headers["content-type"] = res.contentType;
      if (res.location) headers.location = res.location;
      for (const h of ["cache-control", "access-control-allow-origin", "access-control-allow-credentials", "timing-allow-origin"]) if (res.headers[h]) headers[h] = res.headers[h];
      await route.fulfill({ status: res.status, headers, body }).catch(() => {});
    } catch (e) {
      if (pass?.ok) await pass.done(e instanceof SafeFetchError && e.code === "TIMEOUT" ? { status: 0, elapsedMs: Date.now() - t } : {});
      if (e instanceof SafeFetchError && (e.code === "BLOCKED_HOST" || e.code === "INVALID_URL")) return block("ssrf");
      return block(e instanceof SafeFetchError ? e.code.toLowerCase() : "network", "failed");
    }
  }
}

function safeThirdParty(raw: string, f: (u: URL) => boolean): boolean {
  try {
    return f(new URL(raw));
  } catch {
    return true;
  }
}

function isTimeout(e: unknown): boolean {
  return (e as Error)?.name === "TimeoutError" || /Timeout \d+ms exceeded/.test((e as Error)?.message ?? "");
}

// ---------- In-page scripts (run in the browser; kept as plain JavaScript) ----------

/** Records LCP and layout shifts from the start of the load (PerformanceObserver, buffered). */
const METRICS_SCRIPT = `(() => {
  const s = (window.__sitesentry = { lcp: null, lcpEntry: null, shifts: [] });
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) { s.lcp = e.startTime; s.lcpEntry = e; }
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) s.shifts.push([e.startTime, e.value]);
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
})();`;

const READ_METRICS = `(() => {
  const s = window.__sitesentry || { lcp: null, lcpEntry: null, shifts: [] };
  // CLS: the largest session window (shifts under 1 s apart, a window at most 5 s long).
  let best = 0, cur = 0, first = 0, last = 0;
  for (const [t, v] of s.shifts) {
    if (cur && t - last < 1000 && t - first < 5000) cur += v; else { cur = v; first = t; }
    last = t;
    best = Math.max(best, cur);
  }
  const sel = (el) => {
    if (!el || !el.tagName) return null;
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      let p = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(p + "#" + n.id); break; }
      const sib = n.parentElement ? [...n.parentElement.children].filter((x) => x.tagName === n.tagName) : [];
      if (sib.length > 1) p += ":nth-of-type(" + (sib.indexOf(n) + 1) + ")";
      parts.unshift(p);
    }
    return parts.join(" > ");
  };
  const e = s.lcpEntry;
  const el = e && e.element;
  return {
    lcpMs: s.lcp === null ? null : Math.round(s.lcp),
    cls: Math.round(best * 1000) / 1000,
    lcpElement: e ? { tag: el ? el.tagName.toLowerCase() : null, url: e.url || null, loading: el && el.getAttribute ? el.getAttribute("loading") : null, selector: sel(el) } : null,
    domNodes: document.getElementsByTagName("*").length,
  };
})()`;

/** Elements that only JavaScript makes into links: inline onclick handlers, and <a> without href. */
const SCRIPT_LINKS = `((max) => {
  const sel = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      let p = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(p + "#" + n.id); break; }
      const sib = n.parentElement ? [...n.parentElement.children].filter((x) => x.tagName === n.tagName) : [];
      if (sib.length > 1) p += ":nth-of-type(" + (sib.indexOf(n) + 1) + ")";
      parts.unshift(p);
    }
    return parts.join(" > ");
  };
  const text = (el) => (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120);
  const NAV = /location|window\\.open|navigate|href/i;
  const URL_LIT = /['"]((?:https?:)?\\/[^'"\\s]*|[^'"\\s]+\\.html?(?:[?#][^'"\\s]*)?)['"]/;
  const onclick = [], noHref = [];
  let nOnclick = 0, nNoHref = 0;
  for (const el of document.querySelectorAll("[onclick]")) {
    const h = el.getAttribute("onclick") || "";
    // Only handlers that navigate; a real <a href> with an onclick is still crawlable.
    if (!NAV.test(h) || (el.tagName === "A" && el.getAttribute("href") && !/^\\s*(#|javascript:)/i.test(el.getAttribute("href")))) continue;
    nOnclick++;
    const m = h.match(URL_LIT);
    if (onclick.length < max) onclick.push({ tag: el.tagName.toLowerCase(), text: text(el), onclick: h.slice(0, 200), target: m ? m[1] : null, selector: sel(el) });
  }
  for (const el of document.querySelectorAll("a:not([href])")) {
    if (el.hasAttribute("onclick")) continue; // counted above when it navigates
    if (!text(el) && !el.querySelector("img,svg")) continue; // an empty anchor (a named target) is not a link
    nNoHref++;
    if (noHref.length < max) noHref.push({ tag: "a", text: text(el), onclick: null, target: null, selector: sel(el) });
  }
  return { onclick, noHref, counts: { onclick: nOnclick, noHref: nNoHref } };
})`;

const RUN_AXE = `(async ({ rules, max }) => {
  const r = await window.axe.run(document, { runOnly: { type: "rule", values: rules }, resultTypes: ["violations"] });
  const out = {};
  for (const v of r.violations) {
    out[v.id] = {
      count: v.nodes.length,
      nodes: v.nodes.slice(0, max).map((n) => ({ selector: [].concat(n.target).join(" "), html: String(n.html).slice(0, 300), summary: String(n.failureSummary || "").slice(0, 300) })),
    };
  }
  return { version: window.axe.version, rules: out };
})`;
