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

// Parse the file-identifying parts out of a Figma file URL. Figma URLs look like
// https://www.figma.com/design/<KEY>/<title>?… (also the older /file/<KEY>/… form,
// /board/… for FigJam, and a /design/<KEY>/branch/<BRANCHKEY>/… branch form). The key
// is the segment right after design|file|board. Returns null for anything that isn't a
// valid https figma.com URL with an alphanumeric key. Shared by figmaFileKey and
// canonicalizeFigmaUrl so the two can never drift on what counts as a valid key/branch.
type FigmaPath = { kind: string; key: string; branchKey?: string };
function parseFigmaPath(raw: string): FigmaPath | null {
  if (!isValidFigmaUrl(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const kindIdx = segments.findIndex(
    (s) => s === "design" || s === "file" || s === "board",
  );
  if (kindIdx === -1) return null;
  const kind = segments[kindIdx];
  const key = segments[kindIdx + 1];
  // Figma keys are URL-safe alphanumerics; reject anything else defensively so a weird
  // segment never flows into an API path or a canonical URL.
  if (!key || !/^[A-Za-z0-9]+$/.test(key)) return null;
  const maybeBranch =
    segments[kindIdx + 2] === "branch" ? segments[kindIdx + 3] : undefined;
  const branchKey =
    maybeBranch && /^[A-Za-z0-9]+$/.test(maybeBranch) ? maybeBranch : undefined;
  return { kind, key, branchKey };
}

// Extract the file key from a Figma file URL so we can call the REST API for it.
// Returns null for anything that isn't a valid https figma.com URL with a key segment
// — the caller treats null as "couldn't read the file key". (A branch URL yields the
// parent file key, which is what the REST API is keyed on.)
export function figmaFileKey(raw: string): string | null {
  return parseFigmaPath(raw)?.key ?? null;
}

// Reduce a Figma file URL to a stable, dedup-safe canonical form so the same file
// linked with different share tokens (`?t=…`), title slugs, node-ids, or host casing
// compares equal by string. Canonical form is
//   https://www.figma.com/<kind>/<key>            (kind = design | file | board)
// plus `/branch/<branchKey>` when the URL is a branch link, so two *branches* of one
// file stay distinct. Drops the title slug, query string, and fragment and normalizes
// the host to www.figma.com. Returns the trimmed input unchanged when it isn't a
// parseable Figma file URL (callers validate with isValidFigmaUrl first), so a URL we
// don't recognize is never lost — nor rewritten onto a figma.com host.
export function canonicalizeFigmaUrl(raw: string): string {
  const parsed = parseFigmaPath(raw);
  if (!parsed) return raw.trim();
  const branch = parsed.branchKey ? `/branch/${parsed.branchKey}` : "";
  return `https://www.figma.com/${parsed.kind}/${parsed.key}${branch}`;
}

// Host allowlist for fetching a rendered image. The /v1/images endpoint returns
// temporary CDN URLs (Figma's own host or its S3 bucket); pin the download to
// https + a Figma host so a Figma-response-driven SSRF can't point the fetch at
// an internal address. The AWS branch is pinned to Figma's render bucket
// (figma-alpha-api.s3.<region>.amazonaws.com, dot or dash region separator) —
// a bare *.amazonaws.com suffix would allowlist any attacker-named S3 bucket.
// Pure (no network) so it's unit-testable. Used by lib/figma-api.ts →
// fetchRenderedImage.
const FIGMA_S3_HOST = /^figma-alpha-api\.s3[.-][a-z0-9-]+\.amazonaws\.com$/;

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
    FIGMA_S3_HOST.test(host)
  );
}
