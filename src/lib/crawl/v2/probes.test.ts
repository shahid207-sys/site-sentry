import { describe, expect, it } from "vitest";
import { hostVariants } from "./probes";

describe("hostVariants", () => {
  it("gives the other scheme and the www / non-www host of the start page", () => {
    expect(hostVariants("https://example.com")).toEqual({ scheme: "http://example.com/", www: "https://www.example.com/" });
    expect(hostVariants("https://www.example.com")).toEqual({ scheme: "http://www.example.com/", www: "https://example.com/" });
    expect(hostVariants("http://fixture.test:8080")).toEqual({ scheme: "https://fixture.test:8080/", www: "http://www.fixture.test:8080/" });
  });

  it("has no www variant for IP or single-label hosts", () => {
    expect(hostVariants("http://127.0.0.1:3000").www).toBeNull();
    expect(hostVariants("http://[::1]:3000").www).toBeNull();
    expect(hostVariants("http://localhost:3000").www).toBeNull();
  });
});
