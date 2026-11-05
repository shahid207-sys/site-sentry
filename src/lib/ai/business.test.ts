import { describe, expect, it } from "vitest";
import { businessFacts } from "./business";

const block = (parsed: unknown) => ({ parsed, error: null });

describe("businessFacts", () => {
  it("reads name and address from a LocalBusiness in a @graph", () => {
    const home = block({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "Site" },
        { "@type": ["LocalBusiness", "Organization"], name: "ARCH GRAPHIC", address: { "@type": "PostalAddress", streetAddress: "Al-Khan Road,", addressRegion: "Sharjah", addressCountry: "AE" }, areaServed: ["Dubai", { "@type": "City", name: "Ajman" }] },
      ],
    });
    expect(businessFacts([{ url: "https://a.test/", jsonLd: [home] }])).toEqual({
      name: "ARCH GRAPHIC",
      types: ["LocalBusiness", "Organization"],
      street: "Al-Khan Road",
      locality: null,
      region: "Sharjah",
      postalCode: null,
      country: "AE",
      areaServed: ["Dubai", "Ajman"],
      sourceUrl: "https://a.test/",
    });
  });

  it("prefers a business with an address, and returns null when no page states one", () => {
    const org = block({ "@context": "https://schema.org", "@type": "Organization", name: "Acme" });
    const shop = block({ "@context": "https://schema.org", "@type": "Store", name: "Acme Shop", address: "1 High St, Leeds" });
    expect(businessFacts([{ url: "https://a.test/", jsonLd: [org] }, { url: "https://a.test/contact", jsonLd: [shop] }])).toMatchObject({ name: "Acme Shop", street: "1 High St, Leeds", sourceUrl: "https://a.test/contact" });
    expect(businessFacts([{ url: "https://a.test/", jsonLd: [block({ "@context": "https://schema.org", "@type": "Article", headline: "x" })] }])).toBeNull();
    expect(businessFacts([{ url: "https://a.test/", jsonLd: null }])).toBeNull();
  });
});
