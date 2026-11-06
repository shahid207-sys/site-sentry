// HTML for fixture pages. Every page starts clean (it passes every Phase 2a rule) and a defect, if any, edits its
// parts (defects.ts). Pure functions of the path and origin, so the fast fixture test and the server render the same.
import { deflateSync } from "node:zlib";
import { paragraph, topic } from "./text";

export interface Parts {
  /** Content-Type header; the default carries charset=utf-8. */
  type: string;
  headers: Record<string, string>;
  /** Attribute text inside <html>, e.g. ' lang="en"'. */
  lang: string;
  /** Everything in <head>, in order; defects replace or remove single entries. */
  charset: string;
  title: string;
  description: string;
  viewport: string;
  canonical: string;
  icon: string;
  og: string;
  twitter: string;
  head: string;
  /** Inside <body>, before <main>. */
  header: string;
  /** After the header: links to neighbouring pages (server.ts), so every page has two inbound links. */
  nav: string;
  h1: string;
  /** Main content after the H1 (text, then links). */
  text: string;
  body: string;
  footer: string;
  /** Wraps <main> content in an extra element (a different template). */
  wrap: [string, string];
}

export const OG_IMAGE = "/assets/og.png";
export const SITE_NAME = "Fixture Site";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// The home page's title names the site, as its schema does (CNT-020 and META-020 negative).
export const pageLabel = (path: string) => (path === "/" ? SITE_NAME : path);
export const pageTitle = (path: string) => `${topic(path)} | ${pageLabel(path)}`;
export const pageH1 = (path: string) => topic(path);
export function pageDescription(path: string): string {
  const words = paragraph(`desc:${path}`, 30).replace(/[.,]/g, "").split(" ");
  let d = `${topic(path)} on ${pageLabel(path)}:`;
  for (const w of words) {
    if (d.length + w.length + 1 > 115) break;
    d += ` ${w.toLowerCase()}`;
  }
  // A call to action (META-021 negative).
  return `${d}. Learn more.`;
}

/** An Organization block with every property Google recommends (SD-004 silent). */
export const organization = (origin: string, name: string) => ({
  "@context": "https://schema.org",
  "@type": "Organization",
  name,
  legalName: `${name} Ltd`,
  url: `${origin}/`,
  logo: `${origin}${OG_IMAGE}`,
  description: `${name} is a test site for SiteSentry.`,
  email: "hello@fixture.test",
  telephone: "+44 20 7946 0000",
  address: { "@type": "PostalAddress", streetAddress: "1 Garden Road", addressLocality: "London", postalCode: "N1 1AA", addressCountry: "GB" },
  contactPoint: { "@type": "ContactPoint", contactType: "customer service", telephone: "+44 20 7946 0000" },
  sameAs: ["https://example.org/fixture-site"],
});

export function cleanParts(path: string, origin: string, body = ""): Parts {
  const self = `${origin}${path}`;
  const title = pageTitle(path);
  return {
    type: "text/html; charset=utf-8",
    headers: {},
    lang: ' lang="en"',
    charset: '<meta charset="utf-8">',
    title: `<title>${esc(title)}</title>`,
    description: `<meta name="description" content="${esc(pageDescription(path))}">`,
    viewport: '<meta name="viewport" content="width=device-width, initial-scale=1">',
    canonical: `<link rel="canonical" href="${self}">`,
    icon: '<link rel="icon" href="/favicon.ico">',
    og: `<meta property="og:title" content="${esc(title)}"><meta property="og:image" content="${origin}${OG_IMAGE}"><meta property="og:url" content="${self}">`,
    twitter: '<meta name="twitter:card" content="summary_large_image">',
    // The home page names the organisation (SD-007 negative).
    head: path === "/" ? `<script type="application/ld+json">${JSON.stringify(organization(origin, SITE_NAME))}</script>` : "",
    header: `<header><a href="/">${SITE_NAME}</a></header>`,
    nav: "",
    h1: `<h1>${esc(pageH1(path))}</h1>`,
    text: `<p>${paragraph(path)}</p>`,
    body,
    footer: `<footer><p>${SITE_NAME}, a test site for SiteSentry.</p></footer>`,
    wrap: ["", ""],
  };
}

export const renderParts = (p: Parts) =>
  `<!doctype html><html${p.lang}><head>${p.charset}${p.title}${p.description}${p.viewport}${p.canonical}${p.icon}${p.og}${p.twitter}${p.head}</head>` +
  `<body>${p.header}${p.nav}<main>${p.wrap[0]}${p.h1}${p.text}${p.body}${p.wrap[1]}</main>${p.footer}</body></html>`;

export const links = (paths: string[]) => `<ul>${paths.map((p) => `<li><a href="${p}">${esc(p)}</a></li>`).join("")}</ul>`;

/** A minimal valid PNG of the given size (the size is all a probe reads). */
export function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(h * (w + 1)))), chunk("IEND", Buffer.alloc(0))]);
}

/** A 1×1 ICO, enough for a favicon probe. */
export const FAVICON = Buffer.from("AAABAAEAAQEAAAEAIAAwAAAAFgAAACgAAAABAAAAAgAAAAEAIAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAA/wAAAAA=", "base64");
