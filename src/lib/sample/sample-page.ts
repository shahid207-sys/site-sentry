// SAMPLE DATA — a hand-written fixture, not a real website.
// It deliberately contains title problems so the sample audit has something to show.
// Findings for it are computed by the same rules as live audits, never hardcoded.

export const SAMPLE_URL = "https://sample.site-sentry.invalid/products/trail-shoes";

export const SAMPLE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Trail Running Shoes for Men and Women | Free Shipping on All Orders | Example Outdoor Store</title>
  <meta name="description" content="Sample fixture page used by Site Sentry.">
  <title>Example Outdoor Store</title>
</head>
<body>
  <h1>Trail running shoes</h1>
  <svg role="img" aria-labelledby="logo-t"><title id="logo-t">Logo</title></svg>
  <p>This page is a sample fixture bundled with Site Sentry.</p>
</body>
</html>`;
