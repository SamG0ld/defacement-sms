// Validate a pasted Figma file URL before storing it / rendering it as a link.
// Accept only https figma.com (incl. subdomains like www.) URLs — reject
// javascript:/data: schemes, other hosts, and non-https, so a stored URL can't
// become a stored-XSS link sink or point somewhere unexpected.

export function isValidFigmaUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "figma.com" || host.endsWith(".figma.com");
}

// Extract the file key from a Figma file URL so we can call the REST API for it.
// Figma URLs look like https://www.figma.com/design/<KEY>/<title>?… (also the
// older /file/<KEY>/… form, and /board/… for FigJam). The key is the path
// segment right after design|file|board. Returns null for anything that isn't a
// valid https figma.com URL with a key segment — the caller treats null as
// "couldn't read the file key".
export function figmaFileKey(raw: string): string | null {
  if (!isValidFigmaUrl(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const kindIdx = segments.findIndex((s) =>
    s === "design" || s === "file" || s === "board",
  );
  if (kindIdx === -1) return null;
  const key = segments[kindIdx + 1];
  if (!key) return null;
  // Figma keys are URL-safe alphanumerics; reject anything else defensively so a
  // weird segment never flows into an API path.
  return /^[A-Za-z0-9]+$/.test(key) ? key : null;
}

// Host allowlist for fetching a rendered image. The /v1/images endpoint returns
// temporary CDN URLs (Figma's own host or its S3 bucket); pin the download to
// https + a Figma/AWS host so a Figma-response-driven SSRF can't point the fetch at
// an internal address. Pure (no network) so it's unit-testable. Used by
// lib/figma-api.ts → fetchRenderedImage.
export function isAllowedImageHost(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return (
    host === "figma.com" ||
    host.endsWith(".figma.com") ||
    host.endsWith(".amazonaws.com")
  );
}
