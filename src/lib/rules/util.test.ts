import { describe, expect, it } from "vitest";
import { isMachineEndpoint } from "./util";

describe("isMachineEndpoint", () => {
  it.each([
    "https://a.test/wp-json/wp/v2/posts/27017",
    "https://a.test/wp-json/",
    "https://a.test/wp-json/oembed/1.0/embed?url=https%3A%2F%2Fa.test%2F",
    "https://a.test/xmlrpc.php",
    "https://a.test/wp-admin/admin-ajax.php",
    "https://a.test/feed/",
    "https://a.test/3d-printed-model/feed/",
    "https://a.test/comments/feed/atom/",
    "https://a.test/news.rss",
    "https://a.test/?rest_route=/wp/v2/pages",
    "https://a.test/?feed=rss2",
  ])("%s is an API or feed endpoint", (u) => {
    expect(isMachineEndpoint(u)).toBe(true);
  });
  it.each([
    "https://a.test/",
    "https://a.test/feedback/",
    "https://a.test/blog/feeding-your-dog/",
    "https://a.test/json-formatter/",
    "https://a.test/products/?feed=summer",
    "not a url",
  ])("%s is a page for readers", (u) => {
    expect(isMachineEndpoint(u)).toBe(false);
  });
});
