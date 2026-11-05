import { describe, expect, it } from "vitest";
import { languageMismatch } from "./language";

describe("languageMismatch", () => {
  it("accepts a rewrite in the page's language, brand names in Latin letters included", () => {
    expect(languageMismatch("3D Printing in Sharjah | ARCH GRAPHIC. Custom models for your projects.", "en")).toBeNull();
    expect(languageMismatch("Humvee Scale Model | ARCH GRAPHIC", "en-US")).toBeNull();
    expect(languageMismatch("طباعة ثلاثية الأبعاد في الشارقة | ARCH GRAPHIC. نماذج مطبوعة حسب الطلب.", "ar")).toBeNull();
    expect(languageMismatch("Impression 3D à Sharjah | ARCH GRAPHIC. Maquettes et prototypes pour vos projets.", "fr")).toBeNull();
  });

  it("rejects a rewrite in another script or another Latin-script language", () => {
    expect(languageMismatch("3D Printing in Sharjah | ARCH GRAPHIC. Custom models for your projects.", "ar")).toMatch(/another script/);
    expect(languageMismatch("طباعة ثلاثية الأبعاد في الشارقة", "en")).toMatch(/another script/);
    expect(languageMismatch("Impression 3D à Sharjah. Maquettes et prototypes imprimés en 3D pour vos projets. Demandez un devis.", "en")).toMatch(/reads as fr/);
    expect(languageMismatch("3D printing in Sharjah for the architects and the developers", "fr")).toMatch(/reads as en/);
  });

  it("never calls a mismatch it cannot judge: no language, or too few letters", () => {
    expect(languageMismatch("Anything at all", null)).toBeNull();
    expect(languageMismatch("3D", "ar")).toBeNull();
  });
});
