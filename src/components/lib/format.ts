// Display formatting. Fixed locale so tables read consistently.

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const DATETIME = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const DATETIME_Y = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export const fmtDate = (iso: string | null | undefined) => (iso ? DATE.format(new Date(iso)) : "—");

export function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  return (d.getFullYear() === new Date().getFullYear() ? DATETIME : DATETIME_Y).format(d);
}

export function fmtAgo(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "never";
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 31) return `${d} d ago`;
  return fmtDate(iso);
}

export function fmtDuration(fromIso: string, toIso: string | null) {
  if (!toIso) return "—";
  const s = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  if (s < 1) return "<1s";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function shortUrl(url: string) {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

export function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Lower-cased host without a leading "www." — the one form used to compare and show hostnames. */
export function cleanHost(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  let host = v;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`).host;
  } catch {
    host = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0];
  }
  return host.toLowerCase().replace(/^(www\.)+/, "");
}

/** Option text for a site picker: the name, plus the hostname only when it adds information. */
export function siteOptionLabel(site: { name?: string | null; origin?: string | null }): string {
  const name = (site.name ?? "").trim();
  const host = cleanHost(site.origin);
  if (!name) return host || "Unnamed site";
  if (!host) return name;
  if (cleanHost(name) === host) return host; // the name is just the domain: show it once
  return `${name} (${host})`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
