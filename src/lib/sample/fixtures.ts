// SAMPLE DATA — fictional websites on the reserved .example TLD, not real businesses.
// The sample workspace runs the real crawler and rules against these fixtures, so every sample
// finding, comparison and verification is genuine engine output on synthetic input.
import type { SampleState } from "../model";

export interface FixturePage {
  path: string;
  status?: number;
  redirect?: string;
  contentType?: string;
  /** null = no <title>; array = multiple <title> elements. */
  title?: string | string[] | null;
  description?: string | null;
  h1?: string | null;
  robots?: string;
  canonical?: string;
  lang?: string | null;
  hreflang?: [string, string][];
  og?: boolean;
  jsonld?: string[];
  images?: { src: string; alt?: string | null; dims?: boolean }[];
  links?: string[];
  words?: number;
  topic?: string;
}

export interface FixtureSite {
  key: "northwind" | "harbor";
  name: string;
  origin: string;
  robots: string | null;
  sitemap: string | null;
  pages: FixturePage[];
}

const VOCAB = [
  "trail", "weather", "pack", "lightweight", "guide", "season", "comfort", "durable", "fabric", "layer",
  "camp", "fit", "warranty", "support", "choose", "outdoor", "waterproof", "breathable", "pitch", "carry",
];
const DENTAL = ["patient", "appointment", "care", "gentle", "clinic", "treatment", "smile", "family", "dentist", "visit", "comfort", "insurance", "team", "emergency", "plan", "options", "hygiene", "checkup", "friendly", "location"];

/** Deterministic filler text, so word counts are exact and stable. */
function words(n: number, topic = "outdoor"): string {
  const vocab = topic === "dental" ? DENTAL : VOCAB;
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(vocab[(i * 7 + n) % vocab.length]);
  const sentences: string[] = [];
  for (let i = 0; i < out.length; i += 12) {
    const s = out.slice(i, i + 12).join(" ");
    sentences.push(s.charAt(0).toUpperCase() + s.slice(1) + ".");
  }
  return sentences.join(" ");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export function renderPage(site: FixtureSite, p: FixturePage): string {
  const head: string[] = ['<meta charset="utf-8">'];
  const titles = p.title === undefined ? [] : p.title === null ? [] : Array.isArray(p.title) ? p.title : [p.title];
  for (const t of titles) head.push(`<title>${esc(t)}</title>`);
  if (p.description !== undefined && p.description !== null) head.push(`<meta name="description" content="${esc(p.description)}">`);
  if (p.robots) head.push(`<meta name="robots" content="${esc(p.robots)}">`);
  if (p.canonical) head.push(`<link rel="canonical" href="${esc(p.canonical)}">`);
  for (const [code, href] of p.hreflang ?? []) head.push(`<link rel="alternate" hreflang="${esc(code)}" href="${esc(href)}">`);
  if (p.og !== false) {
    head.push(`<meta property="og:title" content="${esc(titles[0] ?? site.name)}">`);
    head.push(`<meta property="og:description" content="${esc(p.description ?? site.name)}">`);
    head.push(`<meta property="og:image" content="${site.origin}/images/share.jpg">`);
  }
  for (const j of p.jsonld ?? []) head.push(`<script type="application/ld+json">${j}</script>`);
  const nav = (p.links ?? []).map((l) => `<a href="${esc(l)}">${esc(l === "/" ? "Home" : l.replace(/\/$/, "").split("/").pop()!.replace(/-/g, " "))}</a>`).join(" ");
  const imgs = (p.images ?? [])
    .map((i) => `<img src="${esc(i.src)}"${i.alt === undefined ? ' alt="Product photo"' : i.alt === null ? "" : ` alt="${esc(i.alt)}"`}${i.dims === false ? "" : ' width="800" height="600"'}>`)
    .join("\n");
  const lang = p.lang === null ? "" : ` lang="${p.lang ?? "en"}"`;
  return `<!doctype html>
<html${lang}>
<head>
${head.join("\n")}
</head>
<body>
<header><nav>${nav}</nav></header>
<main>
${p.h1 === null ? "" : `<h1>${esc(p.h1 ?? titles[0]?.split("|")[0].trim() ?? "Page")}</h1>`}
${imgs}
<p>${words(p.words ?? 320, p.topic)}</p>
</main>
<footer><p>SAMPLE FIXTURE — fictional site used by the Site Sentry demo.</p></footer>
</body>
</html>`;
}

// ---------------- Northwind Outdoor (fictional e-commerce site) ----------------

const NW = "https://www.northwind-outdoor.example";
const NW_NAV = ["/", "/tents/", "/backpacks/", "/blog/", "/about", "/contact"];
const productLd = (valid: boolean) =>
  valid
    ? `{"@context":"https://schema.org","@type":"Product","name":"Alpine 2P Tent","offers":{"@type":"Offer","price":"349.00","priceCurrency":"USD"}}`
    : `{"@context":"https://schema.org","@type":"Product","name":"Alpine 2P Tent","offers":{"@type":"Offer","price":"349.00","priceCurrency":"USD",},}`;

function northwind(state: Exclude<SampleState, "offline">): FixtureSite {
  const original = state === "original";
  const fixed = state === "fixed";
  const pages: FixturePage[] = [
    {
      path: "/",
      title: "Northwind Outdoor | Tents, Backpacks & Trail Gear",
      description: "Tents, backpacks and trail gear tested on real trips. Free returns within 60 days and a lifetime repair programme.",
      canonical: `${NW}/`,
      jsonld: [`{"@context":"https://schema.org","@type":"Organization","name":"Northwind Outdoor","url":"${NW}/"}`],
      images: [{ src: "/images/hero.jpg", alt: "Tent pitched by a lake" }, ...(original ? [{ src: "/images/hero-missing.jpg", alt: "Autumn collection" }] : [])],
      links: [...NW_NAV, ...(original ? ["/sale"] : []), "/old-catalog", ...(state !== "original" ? ["/tents/ultralight-1p"] : [])],
    },
    {
      path: "/tents/",
      title: "Tents for Backpacking and Car Camping | Northwind Outdoor",
      description: "Compare our backpacking and family tents by weight, capacity and season rating.",
      robots: original ? "noindex, follow" : undefined,
      canonical: `${NW}/tents/`,
      links: [...NW_NAV, "/tents/alpine-2p", ...(state !== "original" ? ["/tents/ultralight-1p"] : [])],
    },
    {
      path: "/tents/alpine-2p",
      title: original
        ? ["Alpine 2P Tent – Lightweight Two Person Backpacking Tent for Three Season Trips | Free Shipping | Northwind Outdoor", "Northwind Outdoor"]
        : "Alpine 2P Backpacking Tent | Northwind Outdoor",
      description: "A 1.6 kg two-person, three-season tent with two doors, two vestibules and a lifetime repair guarantee.",
      canonical: original ? `${NW}/tents/alpine-2p?utm_source=newsletter` : `${NW}/tents/alpine-2p`,
      jsonld: [productLd(fixed)],
      images: [
        { src: "/images/alpine-2p.jpg", alt: original ? null : "Alpine 2P tent, side view" },
        { src: "/images/alpine-2p-inside.jpg", alt: original ? null : "Inside the Alpine 2P", dims: fixed },
      ],
      links: [...NW_NAV, "/tents/"],
    },
    {
      path: "/tents/ultralight-1p",
      title: "Ultralight 1P Tent | Northwind Outdoor",
      description: fixed ? "A 900 g solo tent for fast-and-light trips, pitched with trekking poles." : null,
      canonical: `${NW}/tents/ultralight-1p`,
      jsonld: [`{"@context":"https://schema.org","@type":"Product","name":"Ultralight 1P Tent"}`],
      links: [...NW_NAV, "/tents/"],
    },
    {
      path: "/backpacks/",
      title: fixed ? "Backpacks for Hiking and Travel | Northwind Outdoor" : "Backpacks | Northwind Outdoor",
      description: original ? null : "Hiking backpacks and daypacks from 18 to 65 litres, fitted in store or online.",
      canonical: `${NW}/backpacks/`,
      links: [...NW_NAV, "/backpacks/daypacks"],
    },
    {
      path: "/backpacks/daypacks",
      title: fixed ? "Daypacks: 18–30 L Hiking Packs | Northwind Outdoor" : "Backpacks | Northwind Outdoor",
      description: "Light daypacks for hikes, commutes and travel.",
      canonical: `${NW}/backpacks/daypacks`,
      words: fixed ? 420 : original ? 60 : 140,
      links: [...NW_NAV, "/backpacks/"],
    },
    {
      path: "/blog/",
      title: "Trail Notes: Guides and Gear Advice | Northwind Outdoor",
      description: "Practical guides for planning trips and choosing gear, written by our staff.",
      canonical: `${NW}/blog/`,
      links: [...NW_NAV, "/blog/layering-guide"],
    },
    {
      path: "/blog/layering-guide",
      title: "How to Layer Clothing for Hiking | Northwind Outdoor",
      description: "A practical guide to base, mid and outer layers for changeable mountain weather.",
      canonical: `${NW}/blog/layering-guide`,
      hreflang: [[fixed ? "en-GB" : "en-UK", `${NW}/blog/layering-guide`], ["x-default", `${NW}/blog/layering-guide`]],
      jsonld: [`{"@context":"https://schema.org","@type":"Article","author":"Northwind staff"${fixed ? ',"headline":"How to layer clothing for hiking"' : ""}}`],
      links: [...NW_NAV, "/blog/"],
    },
    {
      path: "/about",
      title: "About Northwind Outdoor | Our Story and Repair Programme",
      description: "Founded by guides in 2009. Learn about our testing, repairs and sustainability commitments.",
      canonical: `${NW}/about`,
      h1: original || fixed ? "About Northwind Outdoor" : null,
      og: !original,
      links: NW_NAV,
    },
    {
      path: "/contact",
      // REGRESSION in "current": a template change dropped the title on a page that was clean before.
      title: state === "current" ? null : "Contact Northwind Outdoor | Store Hours and Support",
      description: "Store hours, phone and email support, and how to arrange a repair.",
      canonical: `${NW}/contact`,
      links: NW_NAV,
    },
    {
      path: "/clearance",
      title: "Clearance Gear | Northwind Outdoor",
      description: "Last-season tents and packs at reduced prices while stock lasts.",
      canonical: `${NW}/clearance`,
      links: NW_NAV,
    },
    { path: "/sale", status: 404 },
    { path: "/old-catalog", status: 301, redirect: "/tents/" },
  ];
  const sitemapPaths = ["/", "/tents/", "/tents/alpine-2p", "/backpacks/", "/backpacks/daypacks", "/blog/", "/blog/layering-guide", "/about", "/contact", "/clearance", ...(original ? ["/sale", "/old-catalog"] : []), ...(fixed ? ["/tents/ultralight-1p"] : [])];
  return {
    key: "northwind",
    name: "Northwind Outdoor",
    origin: NW,
    robots: `User-agent: *\nDisallow: /checkout\nDisallow: /cart\n\nSitemap: ${NW}/sitemap.xml\n`,
    sitemap: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapPaths.map((p) => `  <url><loc>${NW}${p}</loc></url>`).join("\n")}\n</urlset>`,
    pages,
  };
}

// ---------------- Harbor Family Dental (fictional local business) ----------------

const HD = "https://harbor-dental.example";
const HD_NAV = ["/", "/services/", "/locations/downtown", "/locations/harbor-point", "/book"];
const localLd = (name: string, withAddress: boolean) =>
  `{"@context":"https://schema.org","@type":"Dentist","additionalType":"LocalBusiness","name":"${name}"${withAddress ? ',"address":{"@type":"PostalAddress","streetAddress":"1 Quay Street","addressLocality":"Harbor City"}' : ""}}`;
const localBusinessLd = (name: string, withAddress: boolean) =>
  `{"@context":"https://schema.org","@type":"LocalBusiness","name":"${name}"${withAddress ? ',"address":{"@type":"PostalAddress","streetAddress":"40 Point Road","addressLocality":"Harbor City"}' : ""}}`;

function harbor(state: Exclude<SampleState, "offline">): FixtureSite {
  const original = state === "original";
  const fixed = state === "fixed";
  const sharedDesc = "Harbor Family Dental: gentle family dentistry in Harbor City. Book online today.";
  return {
    key: "harbor",
    name: "Harbor Family Dental",
    origin: HD,
    robots: fixed ? `User-agent: *\nDisallow: /admin/\n\nSitemap: ${HD}/sitemap.xml\n` : `User-agent: *\nDisallow: /admin/\nDisallow: /book\n`,
    sitemap: fixed
      ? `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${["/", "/services/", "/services/emergency-dentist", "/services/teeth-whitening", "/locations/downtown", "/locations/harbor-point", "/book"].map((p) => `  <url><loc>${HD}${p}</loc></url>`).join("\n")}\n</urlset>`
      : original
        ? null
        : // "current": someone added a sitemap by hand and broke it.
          `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${HD}/</loc></url>\n  <url><loc>${HD}/services/?ref=nav&utm=1</loc></url>\n</urlset>`,
    pages: [
      {
        path: "/",
        lang: original ? null : "en",
        title: "Harbor Family Dental | Family Dentist in Harbor City",
        description: "Family and emergency dentistry in Harbor City, with two locations and evening appointments.",
        canonical: `${HD}/`,
        topic: "dental",
        jsonld: [localLd("Harbor Family Dental", true)],
        links: [...HD_NAV, "/services/emergency-dentist"],
      },
      {
        path: "/services/",
        title: "Dental Services | Harbor Family Dental",
        description: "Check-ups, whitening, emergency care and more.",
        canonical: `${HD}/services/`,
        topic: "dental",
        words: 90,
        links: [...HD_NAV, "/services/emergency-dentist", "/services/teeth-whitening"],
      },
      {
        path: "/services/emergency-dentist",
        title: "Emergency Dentist in Harbor City | Same-Day Appointments",
        description: "Toothache or broken tooth? Same-day emergency appointments at both Harbor Family Dental locations.",
        canonical: `${HD}/services/emergency-dentist`,
        topic: "dental",
        links: HD_NAV,
      },
      {
        path: "/services/teeth-whitening",
        title: "Teeth Whitening | Harbor Family Dental",
        description: "In-clinic and take-home whitening, with a free consultation.",
        canonical: `${HD}/services/teeth-whitening`,
        topic: "dental",
        images: [{ src: "/images/whitening.jpg", alt: "", dims: true }],
        links: HD_NAV,
      },
      {
        path: "/locations/downtown",
        title: "Downtown Harbor City Dentist | Harbor Family Dental",
        description: fixed ? "Our downtown clinic at 1 Quay Street, open until 8pm on weekdays, with parking nearby." : sharedDesc,
        canonical: `${HD}/locations/downtown`,
        topic: "dental",
        jsonld: [localLd("Harbor Family Dental Downtown", true)],
        links: HD_NAV,
      },
      {
        path: "/locations/harbor-point",
        title: "Harbor Point Dentist | Harbor Family Dental",
        description: fixed || state === "current" ? "Our Harbor Point clinic at 40 Point Road, with Saturday appointments." : sharedDesc,
        canonical: `${HD}/locations/harbor-point`,
        topic: "dental",
        jsonld: [localBusinessLd("Harbor Family Dental Harbor Point", fixed)],
        links: HD_NAV,
      },
      {
        path: "/book",
        title: "Book an Appointment | Harbor Family Dental",
        description: "Choose a time at either location. Takes under two minutes.",
        canonical: `${HD}/book`,
        topic: "dental",
        words: 45,
        links: HD_NAV,
      },
    ],
  };
}

export function fixtureSites(state: Exclude<SampleState, "offline">): FixtureSite[] {
  return [northwind(state), harbor(state)];
}

export const SAMPLE_SITES = [
  { key: "northwind" as const, name: "Northwind Outdoor", origin: NW },
  { key: "harbor" as const, name: "Harbor Family Dental", origin: HD },
];
