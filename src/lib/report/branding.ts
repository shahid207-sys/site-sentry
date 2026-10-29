// Report white-label settings (Site.branding): checked on write, and the renderer checks them again on read.
import type { Branding } from "../model";

export const BRAND_COLOR = /^#[0-9a-f]{6}$/i;
export const LOGO_DATA_URL = /^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;
/** Base64 characters (about 110 KB of image): the logo lives in the site row and in every report. */
export const MAX_LOGO_CHARS = 150_000;
export const MAX_AGENCY_NAME = 120;

export type BrandingPatch = { agencyName?: string | null; brandColor?: string | null; logoDataUrl?: string | null };

/** Applies a patch (null clears a field) to the current branding, or explains what is wrong with it. */
export function applyBranding(current: Branding | undefined, patch: BrandingPatch): { branding: Branding } | { error: string } {
  const out: Branding = { ...current };
  if (patch.agencyName !== undefined) {
    const name = patch.agencyName?.trim().slice(0, MAX_AGENCY_NAME);
    if (name) out.agencyName = name;
    else delete out.agencyName;
  }
  if (patch.brandColor !== undefined) {
    if (patch.brandColor === null || patch.brandColor === "") delete out.brandColor;
    else if (!BRAND_COLOR.test(patch.brandColor)) return { error: "Brand colour must be a hex colour like #1f4b99." };
    else out.brandColor = patch.brandColor.toLowerCase();
  }
  if (patch.logoDataUrl !== undefined) {
    if (patch.logoDataUrl === null || patch.logoDataUrl === "") delete out.logoDataUrl;
    else if (patch.logoDataUrl.length > MAX_LOGO_CHARS) return { error: "The logo is too large: use an image under 100 KB." };
    else if (!LOGO_DATA_URL.test(patch.logoDataUrl)) return { error: "The logo must be a PNG, JPEG or SVG image (a base64 data: URL), not a link." };
    else out.logoDataUrl = patch.logoDataUrl;
  }
  return { branding: out };
}
