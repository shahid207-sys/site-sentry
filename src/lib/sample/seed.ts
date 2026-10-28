// Builds the sample workspace by running the real engine over the fixture sites with a fixed clock
// and fixed ids, so the seed is identical on every machine and every run.
import { createAudit, ALL_CATEGORIES, runAuditToCompletion } from "../crawl/engine";
import type { AuditConfig, PageIntent, SampleState } from "../model";
import { DEFAULT_RULE_CONFIG } from "../audit/types";
import { MemoryStore, type AuditBlob, type StoreData } from "../store/store";
import type { Deps } from "../workflow/deps";
import { createTask, updateTask, verifyTask } from "../workflow/tasks";
import { sampleFetcher } from "./fetcher";
import { SAMPLE_SITES } from "./fixtures";

export const SEED_VERSION = "5";

const NW = SAMPLE_SITES[0].origin;
const HD = SAMPLE_SITES[1].origin;

export async function buildSampleSeed(): Promise<{ state: StoreData; blobs: Record<string, AuditBlob> }> {
  const store = new MemoryStore();
  let t = 0;
  let n = 0;
  let state: SampleState = "original";
  const deps: Deps = {
    store,
    get fetch() {
      return sampleFetcher(state);
    },
    now: () => new Date(t),
    newId: () => `smp-${(++n).toString().padStart(3, "0")}`,
    source: "sample",
    clockMs: () => 0,
  } as Deps;
  const at = (iso: string) => {
    t = Date.parse(iso);
  };
  const tick = () => {
    t += 60_000;
  };

  at("2026-09-20T08:00:00Z");
  await store.update((d) => {
    d.sites["smp-site-nw"] = { id: "smp-site-nw", name: "Northwind Outdoor", origin: NW, createdAt: new Date(t).toISOString(), notes: "SAMPLE: fictional outdoor-gear shop." };
    d.sites["smp-site-hd"] = { id: "smp-site-hd", name: "Harbor Family Dental", origin: HD, createdAt: new Date(t).toISOString(), notes: "SAMPLE: fictional two-location dental clinic." };
    const intent = (id: string, siteId: string, url: string, pageType: PageIntent["pageType"], labels: string[], extra: Partial<PageIntent> = {}): PageIntent => ({
      id,
      siteId,
      url,
      pageType,
      labels,
      indexability: "index",
      createdAt: new Date(t).toISOString(),
      updatedAt: new Date(t).toISOString(),
      ...extra,
    });
    for (const p of [
      intent("smp-pg-1", "smp-site-nw", `${NW}/`, "home", ["core"]),
      intent("smp-pg-2", "smp-site-nw", `${NW}/tents/`, "category", ["tents"]),
      intent("smp-pg-3", "smp-site-nw", `${NW}/tents/alpine-2p`, "product", ["tents", "bestseller"], { canonicalUrl: `${NW}/tents/alpine-2p` }),
      intent("smp-pg-4", "smp-site-nw", `${NW}/backpacks/`, "category", ["backpacks"]),
      intent("smp-pg-5", "smp-site-nw", `${NW}/contact`, "contact", ["core"]),
      intent("smp-pg-6", "smp-site-hd", `${HD}/`, "home", ["core"]),
      intent("smp-pg-7", "smp-site-hd", `${HD}/services/emergency-dentist`, "service", ["emergency"]),
      intent("smp-pg-8", "smp-site-hd", `${HD}/locations/downtown`, "location", ["downtown"]),
      intent("smp-pg-9", "smp-site-hd", `${HD}/book`, "landing", ["conversion"]),
    ]) {
      d.pages[p.id] = p;
    }
  });

  const nwConfig: AuditConfig = { mode: "single", urls: [`${NW}/`], maxPages: 30, maxDepth: 2, categories: ALL_CATEGORIES, checkLinks: true, includeImportant: true };
  const hdConfig: AuditConfig = { mode: "list", urls: [`${HD}/`, `${HD}/services/`], maxPages: 20, maxDepth: 1, categories: ALL_CATEGORIES, checkLinks: true, includeImportant: true };
  const audit = async (siteId: string, config: AuditConfig) => {
    const { audit: a } = await createAudit({ siteId, config }, deps);
    return runAuditToCompletion(a.id, deps);
  };
  const fpOf = async (auditId: string, ruleCode: string, pageUrl?: string) => {
    const { findings } = await store.readAudit(auditId);
    const f = findings.find((x) => x.ruleCode === ruleCode && (!pageUrl || x.pageUrl === pageUrl));
    if (!f) throw new Error(`Sample seed: ${ruleCode} ${pageUrl ?? ""} not found in ${auditId}`);
    return f.fingerprint;
  };

  // --- Week 1: first audits of the original sites.
  at("2026-10-01T09:00:00Z");
  const nw1 = await audit("smp-site-nw", nwConfig);
  tick();
  const hd1 = await audit("smp-site-hd", hdConfig);

  at("2026-10-02T10:00:00Z");
  const noindex = await createTask({ auditId: nw1.id, fingerprints: [await fpOf(nw1.id, "indexability/unexpected-noindex", `${NW}/tents/`)], owner: "Priya (web dev)", notes: "Staging robots meta survived the last deploy." }, deps);
  tick();
  const jsonld = await createTask({ auditId: nw1.id, fingerprints: [await fpOf(nw1.id, "structured-data/invalid-json", `${NW}/tents/alpine-2p`)], owner: "Sam (platform)" }, deps);
  tick();
  const desc = await createTask({ auditId: nw1.id, fingerprints: [await fpOf(nw1.id, "meta-description/missing", `${NW}/backpacks/`)], owner: "Alex (content)" }, deps);
  tick();
  const broken = await createTask({ auditId: nw1.id, fingerprints: [await fpOf(nw1.id, "links/broken-internal", `${NW}/sale`)], owner: "Priya (web dev)" }, deps);
  tick();
  const robots = await createTask({ auditId: hd1.id, fingerprints: [await fpOf(hd1.id, "robots/blocks-important", `${HD}/book`)], owner: "Lee (agency dev)", notes: "Booking page must be crawlable; it is linked from every ad." }, deps);
  tick();
  const thin = await createTask({ auditId: hd1.id, fingerprints: [await fpOf(hd1.id, "content/thin", `${HD}/services/`)] }, deps);

  tick();
  for (const id of [noindex.task.id, jsonld.task.id, desc.task.id, broken.task.id]) await updateTask(id, { workflowStatus: "in_progress" }, deps);
  await updateTask(robots.task.id, { workflowStatus: "triaged" }, deps);
  await updateTask(thin.task.id, { workflowStatus: "wont_fix", wontFixReason: "The services hub is a deliberately short navigation page; detail lives on each service page." }, deps);

  // --- Week 2: fixes deployed (and one template regression), then verified.
  at("2026-10-14T16:00:00Z");
  state = "current";
  for (const id of [noindex.task.id, desc.task.id, broken.task.id, jsonld.task.id]) await updateTask(id, { workflowStatus: "ready_to_verify" }, deps);
  const env = (origin: string) => ({ config: DEFAULT_RULE_CONFIG, origin });
  for (const id of [noindex.task.id, desc.task.id, broken.task.id, jsonld.task.id]) {
    tick();
    await verifyTask(id, deps, env(NW));
  }
  tick();
  await updateTask(desc.task.id, { workflowStatus: "resolved" }, deps);
  await updateTask(broken.task.id, { workflowStatus: "resolved" }, deps);
  await updateTask(jsonld.task.id, { workflowStatus: "in_progress", notes: "Re-check failed: the trailing commas are still in the template." }, deps);

  at("2026-10-15T09:00:00Z");
  await audit("smp-site-nw", nwConfig);
  tick();
  await audit("smp-site-hd", hdConfig);

  await store.update((d) => {
    d.sampleState = "current";
    d.seedVersion = SEED_VERSION;
  });
  const finalState = await store.read();
  const blobs: Record<string, AuditBlob> = {};
  for (const id of Object.keys(finalState.audits)) blobs[id] = await store.readAudit(id);
  return { state: finalState, blobs };
}
