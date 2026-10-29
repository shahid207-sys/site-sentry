// Page rules marked `groupByTemplate` report once per template group instead of once per page: an optional property
// missing from a CMS template is one fix, not N findings. Each issue's evidence.groupKey (e.g. the schema type) is
// grouped with the page's template fingerprint; the group is reported at its first URL in sort order, so the subject
// does not depend on crawl order. Memory is one entry per group with a bounded sample, whatever the crawl size.
import type { Finding } from "./contract";

/** Pages listed in a grouped finding's evidence. */
export const GROUP_SAMPLE = 5;

interface Group {
  first: Finding;
  pages: number;
  /** The smallest URLs seen, sorted; sample[0] is the subject. */
  sample: string[];
  missing: Set<string>;
}

export class TemplateGroups {
  private readonly groups = new Map<string, Group>();

  /** Adds one page's findings of a grouped rule. Inconclusive findings are not grouped and are returned as they are. */
  add(findings: Finding[], template: string | null): Finding[] {
    const passThrough: Finding[] = [];
    for (const f of findings) {
      if (f.outcome !== "issue") {
        passThrough.push(f);
        continue;
      }
      const key = `${f.ruleId}\u0000${template ?? `url:${f.url}`}\u0000${String(f.evidence.groupKey ?? "")}`;
      const g = this.groups.get(key) ?? { first: f, pages: 0, sample: [], missing: new Set<string>() };
      g.pages++;
      if (!g.sample.includes(f.url)) {
        g.sample.push(f.url);
        g.sample.sort();
        if (g.sample.length > GROUP_SAMPLE) g.sample.pop();
      }
      if (f.url < g.first.url) g.first = f;
      for (const m of (f.evidence.missing as string[] | undefined) ?? []) g.missing.add(m);
      this.groups.set(key, g);
    }
    return passThrough;
  }

  /** One finding per group, at the group's first URL. */
  findings(): Finding[] {
    return [...this.groups.values()].map((g) => {
      const f = g.first;
      const ev = { ...f.evidence, ...(g.missing.size ? { missing: [...g.missing].sort() } : {}), pages: g.pages, sample: g.sample };
      const message = g.pages > 1 ? `${f.message} The same holds on ${g.pages - 1} other page(s) built from this template.` : f.message;
      return { ...f, url: g.sample[0], message, evidence: ev };
    });
  }
}
