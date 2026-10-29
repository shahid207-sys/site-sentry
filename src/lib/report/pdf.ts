// The report as PDF: Chromium (Playwright) prints the same HTML the live report serves (html.ts). The page may make
// no request at all: the report is self-contained, and anything it tried to load is aborted.
import { chromium } from "playwright";

export interface RenderedPdf {
  pdf: Buffer;
  pages: number;
}

/** Page objects in a PDF (`/Type /Page`, not the `/Pages` tree nodes). */
export function pdfPageCount(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

export async function renderPdf(html: string, footer = ""): Promise<RenderedPdf> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("**/*", (r) => (r.request().url().startsWith("data:") ? r.continue() : r.abort()));
    await page.setContent(html, { waitUntil: "load" });
    await page.emulateMedia({ media: "print" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: `<div style="font-size:8px;color:#5c6370;width:100%;padding:0 14mm;display:flex;justify-content:space-between"><span>${footer.replace(/[&<>"']/g, "")}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
      margin: { top: "16mm", bottom: "18mm", left: "14mm", right: "14mm" },
    });
    return { pdf, pages: pdfPageCount(pdf) };
  } finally {
    await browser.close();
  }
}
