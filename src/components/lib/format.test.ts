import { describe, expect, it } from "vitest";
import { cleanHost, siteOptionLabel } from "./format";

describe("cleanHost", () => {
  it("drops protocol, path and duplicated www", () => {
    expect(cleanHost("https://www.www.Example.com/a?b")).toBe("example.com");
    expect(cleanHost("www.omegadoorsandwindows.com")).toBe("omegadoorsandwindows.com");
    expect(cleanHost(null)).toBe("");
  });
});

describe("siteOptionLabel", () => {
  it("shows name and host when both add information", () => {
    expect(siteOptionLabel({ name: "Omega Doors and Windows", origin: "https://www.omegadoorsandwindows.com" })).toBe("Omega Doors and Windows (omegadoorsandwindows.com)");
  });
  it("shows the domain once when the name is the domain", () => {
    expect(siteOptionLabel({ name: "www.omegadoorsandwindows.com", origin: "https://www.omegadoorsandwindows.com" })).toBe("omegadoorsandwindows.com");
    expect(siteOptionLabel({ name: "omegadoorsandwindows.com", origin: "https://www.omegadoorsandwindows.com" })).toBe("omegadoorsandwindows.com");
  });
  it("handles missing name or origin", () => {
    expect(siteOptionLabel({ name: "", origin: "https://a.com" })).toBe("a.com");
    expect(siteOptionLabel({ name: "Acme", origin: "" })).toBe("Acme");
    expect(siteOptionLabel({})).toBe("Unnamed site");
  });
});
