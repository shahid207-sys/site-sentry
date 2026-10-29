// Read-only share links to an audit's report (docs/SPEC.md "Collaboration": public read-only share links with optional
// password and expiry). The token is 32 random bytes, shown once and stored only as its SHA-256. A password is
// stored as a scrypt hash; once given, a cookie scoped to the link's path carries SHA-256(token hash, password hash),
// which only the database can produce. Expiry is checked against the database clock. Every response is noindex.
import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, type BinaryLike, type ScryptOptions } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import type { Branding } from "../model";
import { reportData } from "../results/report";
import { crawlOverview, ResultsError } from "../results/queries";
import { groupUrlsCsv } from "./csv";
import { esc, renderReport, REPORT_CSP } from "./html";

type Exec = Pick<Db, "execute">;

const scrypt = (pw: BinaryLike, salt: BinaryLike, len: number, o: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(pw, salt, len, o, (e, k) => (e ? reject(e) : resolve(k))));
const SCRYPT = { N: 16384, r: 8, p: 1 };
const sha256 = (s: string) => createHash("sha256").update(s).digest("base64url");

export const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const MIN_PASSWORD = 8;
export const MAX_EXPIRY_DAYS = 365;
export const SHARE_COOKIE = "ss_share";

/** Headers on every share response, the password form and the errors included. */
export const SHARE_HEADERS = {
  "content-security-policy": REPORT_CSP,
  "x-robots-tag": "noindex, nofollow, noarchive",
  "referrer-policy": "no-referrer",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64url")}$${(await scrypt(pw, salt, 32, SCRYPT)).toString("base64url")}`;
}

export async function passwordMatches(pw: string, stored: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64url");
  const got = await scrypt(pw, Buffer.from(salt, "base64url"), want.length, SCRYPT);
  return timingSafeEqual(got, want);
}

export interface ShareInfo {
  id: string;
  auditId: string;
  hasPassword: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreatedShare extends ShareInfo {
  /** Shown once: only its hash is stored. */
  token: string;
  path: string;
}

export async function createShare(db: Exec, o: { workspace: string; auditId: string; crawlId: string; password?: string | null; expiresInDays?: number | null }): Promise<CreatedShare> {
  const ov = await crawlOverview(db, o.crawlId);
  if (ov.workspace !== o.workspace) throw new ResultsError("NOT_FOUND", "Audit not found.");
  if (!ov.analysed) throw new ResultsError("INVALID", "The audit is not analysed yet: share its report once the analysis finishes.");
  if (o.password != null && o.password.length < MIN_PASSWORD) throw new ResultsError("INVALID", `Use a password of at least ${MIN_PASSWORD} characters, or none.`);
  const days = o.expiresInDays ?? null;
  if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= MAX_EXPIRY_DAYS)) throw new ResultsError("INVALID", `Expiry must be 1 to ${MAX_EXPIRY_DAYS} days, or none.`);
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const passwordHash = o.password ? await hashPassword(o.password) : null;
  const r = await db.execute(sql`insert into report_shares (id, token_hash, workspace, audit_id, crawl_id, password_hash, expires_at)
    values (${id}::uuid, ${sha256(token)}, ${o.workspace}, ${o.auditId}, ${o.crawlId}::uuid, ${passwordHash}, ${days === null ? null : sql`now() + make_interval(days => ${days})`})
    returning expires_at, created_at`);
  const row = r.rows[0] as { expires_at: Date | string | null; created_at: Date | string };
  return {
    id,
    auditId: o.auditId,
    hasPassword: !!passwordHash,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    revokedAt: null,
    createdAt: new Date(row.created_at).toISOString(),
    token,
    path: `/r/${token}`,
  };
}

export async function listShares(db: Exec, workspace: string, auditId: string): Promise<ShareInfo[]> {
  const r = await db.execute(sql`select id, audit_id, password_hash is not null as has_password, expires_at, revoked_at, created_at from report_shares
    where workspace = ${workspace} and audit_id = ${auditId} order by created_at desc`);
  const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
  return (r.rows as { id: string; audit_id: string; has_password: boolean; expires_at: Date | null; revoked_at: Date | null; created_at: Date }[]).map((x) => ({
    id: x.id,
    auditId: x.audit_id,
    hasPassword: x.has_password,
    expiresAt: iso(x.expires_at),
    revokedAt: iso(x.revoked_at),
    createdAt: iso(x.created_at)!,
  }));
}

/** Stops a link working at once. */
export async function revokeShare(db: Exec, workspace: string, auditId: string, id: string): Promise<boolean> {
  const r = await db.execute(sql`update report_shares set revoked_at = coalesce(revoked_at, now()) where id = ${id}::uuid and workspace = ${workspace} and audit_id = ${auditId} returning id`);
  return r.rows.length > 0;
}

export interface ShareRequest {
  method: "GET" | "POST";
  /** What is asked for: the report, or one group's CSV. */
  want: { report: true } | { csv: string };
  /** The form's password (POST). */
  password?: string;
  /** The SHARE_COOKIE value sent. */
  cookie?: string;
  /** https: the access cookie gets Secure. */
  secure: boolean;
}

export interface ShareResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const page = (title: string, inner: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${esc(title)}</title>
<style>body{margin:0;background:#fff;color:#1a1a1a;font:15px/1.5 system-ui,sans-serif}main{max-width:420px;margin:12vh auto;padding:0 16px}input,button{font:inherit;padding:8px;width:100%;margin-top:8px;box-sizing:border-box}.err{color:#a40000}</style>
</head><body><main>${inner}</main></body></html>`;

const html = (status: number, body: string, extra: Record<string, string> = {}): ShareResponse => ({ status, headers: { ...SHARE_HEADERS, "content-type": "text/html; charset=utf-8", ...extra }, body });

const passwordForm = (error?: string) =>
  html(
    401,
    page(
      "Password required",
      `<h1>Password required</h1><p>This audit report is protected. Enter the password you were given.</p>${error ? `<p class="err">${esc(error)}</p>` : ""}<form method="post"><label>Password<input type="password" name="password" autocomplete="current-password" required autofocus></label><button type="submit">Open the report</button></form>`,
    ),
  );

/** Answers one request to a share link. Branding is looked up per request, so a site's new logo shows at once. */
export async function serveShare(db: Exec, token: string, req: ShareRequest, branding: (workspace: string, auditId: string) => Promise<Branding>): Promise<ShareResponse> {
  const gone = (status: number, msg: string) => html(status, page("Report unavailable", `<h1>Report unavailable</h1><p>${esc(msg)}</p>`));
  if (!TOKEN.test(token)) return gone(404, "This link is not valid.");
  const tokenHash = sha256(token);
  const r = await db.execute(sql`select s.workspace, s.audit_id, s.crawl_id, s.password_hash, s.expires_at, s.revoked_at is not null as revoked,
      (s.expires_at is not null and s.expires_at <= now()) as expired
    from report_shares s where s.token_hash = ${tokenHash}`);
  const s = r.rows[0] as { workspace: string; audit_id: string; crawl_id: string; password_hash: string | null; expires_at: Date | null; revoked: boolean; expired: boolean } | undefined;
  if (!s) return gone(404, "This link is not valid.");
  if (s.revoked) return gone(410, "This link was turned off by its owner.");
  if (s.expired) return gone(410, "This link has expired. Ask its owner for a new one.");

  if (s.password_hash) {
    const access = sha256(`${tokenHash}:${s.password_hash}`);
    const ok = !!req.cookie && req.cookie.length === access.length && timingSafeEqual(Buffer.from(req.cookie), Buffer.from(access));
    if (req.method === "POST") {
      if (!req.password || !(await passwordMatches(req.password, s.password_hash))) return passwordForm("That password is not right.");
      const maxAge = s.expires_at ? Math.max(1, Math.floor((new Date(s.expires_at).getTime() - Date.now()) / 1000)) : 30 * 86400;
      const cookie = `${SHARE_COOKIE}=${access}; Path=/r/${token}; HttpOnly; SameSite=Strict; Max-Age=${Math.min(maxAge, 30 * 86400)}${req.secure ? "; Secure" : ""}`;
      // Post/redirect/get: the report loads with a GET, and a refresh does not resend the password.
      return { status: 303, headers: { ...SHARE_HEADERS, location: `/r/${token}`, "set-cookie": cookie }, body: "" };
    }
    if (!ok) return passwordForm();
  } else if (req.method === "POST") {
    return { status: 303, headers: { ...SHARE_HEADERS, location: `/r/${token}` }, body: "" };
  }

  if ("csv" in req.want) {
    const csv = await groupUrlsCsv(db, s.crawl_id, req.want.csv);
    return { status: 200, headers: { ...SHARE_HEADERS, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${req.want.csv.replace(/[^\w-]/g, "_")}-urls.csv"` }, body: csv };
  }
  const data = await reportData(db, s.crawl_id, await branding(s.workspace, s.audit_id));
  return html(200, renderReport(data, { csvHref: (rule) => `/r/${token}/csv/${encodeURIComponent(rule)}` }));
}
