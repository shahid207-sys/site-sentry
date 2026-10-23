// SAMPLE DATA — hand-written fixtures, not a real website.
// They let the whole detect → fix → verify loop be demonstrated without a site you control.
// Findings for them are computed by the same rules as live audits, never hardcoded.

export const SAMPLE_URL = "https://sample.site-sentry.invalid/products/trail-shoes";

/**
 * The simulated state of the sample site:
 * - broken:  the original page with planted problems
 * - fixed:   the page after a developer deployed the fixes
 * - offline: the site cannot be reached (verification must be inconclusive)
 */
export type SampleState = "broken" | "fixed" | "offline";
export const SAMPLE_STATES: SampleState[] = ["broken", "fixed", "offline"];

export const SAMPLE_HTML_BROKEN = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Trail Running Shoes for Men and Women | Free Shipping on All Orders | Example Outdoor Store</title>
  <meta name="description" content="Sample fixture page used by Site Sentry.">
  <meta name="robots" content="noindex, follow">
  <link rel="canonical" href="https://sample.site-sentry.invalid/products/trail-shoes?utm_source=newsletter">
  <title>Example Outdoor Store</title>
</head>
<body>
  <h1>Trail running shoes</h1>
  <svg role="img" aria-labelledby="logo-t"><title id="logo-t">Logo</title></svg>
  <p>This page is a sample fixture bundled with Site Sentry.</p>
</body>
</html>`;

export const SAMPLE_HTML_FIXED = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Trail Running Shoes for Men &amp; Women | Example Outdoor</title>
  <meta name="description" content="Sample fixture page used by Site Sentry.">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://sample.site-sentry.invalid/products/trail-shoes">
</head>
<body>
  <h1>Trail running shoes</h1>
  <svg role="img" aria-labelledby="logo-t"><title id="logo-t">Logo</title></svg>
  <p>This page is a sample fixture bundled with Site Sentry.</p>
</body>
</html>`;

/** Kept for existing imports: the original (broken) sample page. */
export const SAMPLE_HTML = SAMPLE_HTML_BROKEN;
