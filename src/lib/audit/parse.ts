import * as cheerio from "cheerio";

export type Doc = cheerio.CheerioAPI;

export function parseHtml(html: string): Doc {
  return cheerio.load(html);
}

/** Truncate an HTML excerpt so evidence stays readable. */
export function excerpt(html: string, max = 300): string {
  const oneLine = html.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
