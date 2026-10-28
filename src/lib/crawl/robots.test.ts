import { describe, expect, it } from "vitest";
import { crawlDelayFor, isAllowed, parseRobots } from "./robots";

describe("robots.txt Crawl-delay", () => {
  it("applies the delay of the group that names the crawler, else the * group", () => {
    const r = parseRobots("User-agent: *\nCrawl-delay: 2\nDisallow: /x\n\nUser-agent: SiteSentryBot\nCrawl-delay: 0.5\nDisallow: /y\n");
    expect(crawlDelayFor(r, "SiteSentryBot")).toBe(0.5);
    expect(crawlDelayFor(r, "OtherBot")).toBe(2);
  });

  it("is null when the applicable group has none, even if another group does", () => {
    const r = parseRobots("User-agent: GPTBot\nCrawl-delay: 30\nDisallow: /\n\nUser-agent: *\nDisallow: /private/\n");
    expect(crawlDelayFor(r, "SiteSentryBot")).toBeNull();
    expect(crawlDelayFor(r, "GPTBot")).toBe(30);
    expect(crawlDelayFor(parseRobots(""), "SiteSentryBot")).toBeNull();
  });

  it("takes the longest delay when several groups name the crawler", () => {
    const r = parseRobots("User-agent: SiteSentryBot\nCrawl-delay: 1\n\nUser-agent: sitesentrybot\nCrawl-delay: 4\n");
    expect(crawlDelayFor(r, "SiteSentryBot")).toBe(4);
  });

  it("keeps invalid values out and records them as evidence; does not end the group", () => {
    const r = parseRobots("User-agent: *\nCrawl-delay: soon\nCrawl-delay: -3\nDisallow: /private/\n");
    expect(crawlDelayFor(r, "SiteSentryBot")).toBeNull();
    expect(r.invalidLines).toEqual(["Crawl-delay: soon", "Crawl-delay: -3"]);
    expect(isAllowed(r, "SiteSentryBot", "https://a.test/private/1").allowed).toBe(false);
  });

  it("ignores a Crawl-delay before any User-agent line", () => {
    expect(crawlDelayFor(parseRobots("Crawl-delay: 9\nUser-agent: *\nDisallow:\n"), "SiteSentryBot")).toBeNull();
  });
});
