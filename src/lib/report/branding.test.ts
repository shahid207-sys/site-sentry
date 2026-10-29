import { describe, expect, it } from "vitest";
import { applyBranding, MAX_LOGO_CHARS } from "./branding";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("report branding", () => {
  it("accepts a name, a hex colour and a data: logo, and null clears each", () => {
    const set = applyBranding(undefined, { agencyName: "  Northwind SEO ", brandColor: "#0A7D52", logoDataUrl: PNG });
    expect(set).toEqual({ branding: { agencyName: "Northwind SEO", brandColor: "#0a7d52", logoDataUrl: PNG } });
    const cleared = applyBranding((set as { branding: object }).branding, { agencyName: null, brandColor: null, logoDataUrl: null });
    expect(cleared).toEqual({ branding: {} });
    // Fields not in the patch are kept.
    expect(applyBranding({ agencyName: "A", brandColor: "#000000" }, { brandColor: "#ffffff" })).toEqual({ branding: { agencyName: "A", brandColor: "#ffffff" } });
  });

  it("refuses colours that are not #rrggbb and logos that are links, other types or too large", () => {
    for (const brandColor of ["red", "#fff", "#12345g", "#123456;}</style>"]) expect(applyBranding(undefined, { brandColor })).toHaveProperty("error");
    for (const logoDataUrl of ["https://evil.test/logo.png", "data:image/gif;base64,R0lGOD", "data:text/html;base64,PHNjcmlwdD4=", `${PNG}"><script>`])
      expect(applyBranding(undefined, { logoDataUrl })).toHaveProperty("error");
    expect(applyBranding(undefined, { logoDataUrl: `data:image/png;base64,${"A".repeat(MAX_LOGO_CHARS)}` })).toMatchObject({ error: expect.stringMatching(/too large/) });
  });
});
