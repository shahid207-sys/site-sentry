import { describe, expect, it } from "vitest";
import { parseHtml } from "../audit/parse";
import { cardTexts } from "./cards";
import { mainText } from "./main-text";

const PROSE = "Our workshop prints architectural models for developers and students across the region every week.";
const page = (main: string) => parseHtml(`<!doctype html><html><body><header><a href="/">Logo</a></header><main>${main}</main><footer>Footer text</footer></body></html>`);
const links = (n: number, prefix = "Item") => Array.from({ length: n }, (_, i) => `<li><a href="/c/${i}">${prefix} ${i}</a></li>`).join("");

describe("mainText", () => {
  it("drops a block named as a menu inside <main>", () => {
    const t = mainText(page(`<div class="mega-menu"><ul>${links(3)}</ul></div><p>${PROSE}</p>`));
    expect(t).toBe(PROSE);
  });
  it("drops an unnamed sidebar that is mostly links, including anchors without href", () => {
    const sidebar = `<div class="iksm-22628"><div><a>Parent</a><div>${links(8, "Category")}</div></div></div>`;
    expect(mainText(page(`${sidebar}<p>${PROSE}</p>`))).toBe(PROSE);
  });
  it("keeps prose with a few links, a block holding the h1, and a product listing", () => {
    const prose = `<p>${PROSE} See <a href="/a">our models</a>.</p>`;
    expect(mainText(page(prose))).toContain("See our models");
    expect(mainText(page(`<div><h1>Models</h1>${links(8)}</div>`))).toContain("Models Item 0");
    const grid = `<ul class="products">${[1, 2].map((n) => `<li><a href="/p/${n}"><img src="/${n}.jpg"><h2>Model ${n}</h2></a><a href="/p/${n}">Select options</a></li>`).join("")}</ul>`;
    expect(mainText(page(grid))).toContain("Model 1");
  });
  it("reads header, nav and footer as furniture, and block boundaries as spaces", () => {
    const t = mainText(page(`<nav>${links(2)}</nav><h2>Upload</h2><button>Send</button><p>${PROSE}</p>`));
    expect(t).toBe(`Upload Send ${PROSE}`);
  });
});

describe("cardTexts", () => {
  it("finds a button repeated on 3 or more cards, by visible text", () => {
    const card = (n: number) => `<article class="card post-${n} cat-${n}"><h3>Model ${n}</h3><a href="/p/${n}">View project<span class="screen-reader-text">Model ${n}</span></a></article>`;
    const $ = parseHtml(`<main><div class="grid">${[1, 2, 3].map(card).join("")}</div></main>`);
    expect(cardTexts($, $("body").first())).toEqual([{ text: "view project", n: 3 }]);
  });
  it("needs 3 cards", () => {
    const $ = parseHtml(`<main><div>${[1, 2].map((n) => `<div class="card"><a href="/${n}">Request a quote</a></div>`).join("")}</div></main>`);
    expect(cardTexts($, $("body").first())).toEqual([]);
  });
});
