// Google-supported structured data types with their required and recommended properties (SD-003, SD-004, SD-009),
// and the types Google no longer shows a rich result for (SD-010).
//
// Source: Google Search Central structured data documentation, one page per feature (URL on each entry), read
// 2026-10-29 (pages last updated 2026-09-08 to 2026-09-24); deprecations from https://developers.google.com/search/updates
// read the same day. Transcribed by hand: Google publishes these as prose tables, not a machine-readable file.
// Re-check when a page's "Last updated" date changes.
//
// Meeting these lists is necessary for a rich result, never sufficient: rules must not claim eligibility.

export interface GoogleType {
  /** Google feature documentation page. */
  source: string;
  /**
   * Required properties. A dotted path names a nested property; "a|b" means either one satisfies it (Google's "or").
   * A path whose parent is absent is reported as the parent missing, not the child.
   */
  required: string[];
  recommended: string[];
  /** When the type is checked only as a nested value (e.g. Offer under Product.offers), not at the top level. */
  nestedOnly?: boolean;
}

const DOCS = "https://developers.google.com/search/docs/appearance/structured-data";

export const GOOGLE_TYPES: Record<string, GoogleType> = {
  Product: {
    source: `${DOCS}/product-snippet`,
    // name, plus one of review, aggregateRating or offers.
    required: ["name", "review|aggregateRating|offers"],
    recommended: ["aggregateRating", "offers", "review"],
  },
  Offer: { source: `${DOCS}/product-snippet`, required: ["price|priceSpecification.price"], recommended: ["availability", "priceCurrency|priceSpecification.priceCurrency", "priceValidUntil"], nestedOnly: true },
  AggregateOffer: { source: `${DOCS}/product-snippet`, required: ["lowPrice", "priceCurrency"], recommended: ["highPrice", "offerCount"], nestedOnly: true },
  Article: { source: `${DOCS}/article`, required: [], recommended: ["author", "dateModified", "datePublished", "headline", "image"] },
  NewsArticle: { source: `${DOCS}/article`, required: [], recommended: ["author", "dateModified", "datePublished", "headline", "image"] },
  BlogPosting: { source: `${DOCS}/article`, required: [], recommended: ["author", "dateModified", "datePublished", "headline", "image"] },
  LocalBusiness: {
    source: `${DOCS}/local-business`,
    required: ["address", "name"],
    recommended: ["aggregateRating", "geo", "openingHoursSpecification", "priceRange", "telephone", "url"],
  },
  Organization: {
    source: `${DOCS}/organization`,
    required: [],
    recommended: ["address", "contactPoint", "description", "email", "legalName", "logo", "name", "sameAs", "telephone", "url"],
  },
  BreadcrumbList: { source: `${DOCS}/breadcrumb`, required: ["itemListElement"], recommended: [] },
  ListItem: { source: `${DOCS}/breadcrumb`, required: ["item"], recommended: [], nestedOnly: true },
  Review: {
    source: `${DOCS}/review-snippet`,
    // itemReviewed is required unless the review is nested in the item it reviews (handled by the rule).
    required: ["author", "itemReviewed", "reviewRating", "reviewRating.ratingValue"],
    recommended: ["datePublished", "reviewRating.bestRating", "reviewRating.worstRating"],
  },
  AggregateRating: {
    source: `${DOCS}/review-snippet`,
    // itemReviewed is required unless nested; at least one of ratingCount or reviewCount.
    required: ["itemReviewed", "ratingCount|reviewCount", "ratingValue"],
    recommended: ["bestRating", "worstRating"],
  },
  VideoObject: {
    source: `${DOCS}/video`,
    required: ["name", "thumbnailUrl", "uploadDate"],
    recommended: ["contentUrl", "description", "duration", "embedUrl"],
  },
  Event: {
    source: `${DOCS}/event`,
    required: ["location", "location.address", "name", "startDate"],
    recommended: ["description", "endDate", "eventStatus", "image", "offers", "organizer", "performer"],
  },
};

/** Schema.org types that are LocalBusiness subtypes Google documents under LocalBusiness (the common ones). */
export const LOCAL_BUSINESS_SUBTYPES = [
  "LocalBusiness",
  "Restaurant",
  "Store",
  "Dentist",
  "MedicalBusiness",
  "ProfessionalService",
  "LegalService",
  "AutoRepair",
  "HomeAndConstructionBusiness",
  "FoodEstablishment",
  "HealthAndBeautyBusiness",
  "LodgingBusiness",
  "Hotel",
  "RealEstateAgent",
  "FinancialService",
  "SportsActivityLocation",
  "EntertainmentBusiness",
];

/** Types whose Google rich result is no longer shown, with Google's wording and date (SD-010). */
export const DEPRECATED_TYPES: Record<string, { since: string; note: string }> = {
  HowTo: { since: "2023-09-14", note: "How-to rich results are no longer shown in search results, on desktop or mobile." },
  FAQPage: { since: "2026-05-07", note: "The FAQ rich result is no longer shown in Google Search results (shown only for government and health sites from 2023-09-14)." },
  SpecialAnnouncement: { since: "2025-07-31", note: "Special announcement structured data is no longer shown in Google Search results." },
  Course: { since: "2025-09-09", note: "Course info structured data is no longer shown in Google Search results." },
  Dataset: { since: "2025-11-05", note: "Google is phasing the dataset structured data type out of Search results." },
  Quiz: { since: "2026-01-06", note: "Practice problem structured data is no longer shown in Google Search results." },
};
