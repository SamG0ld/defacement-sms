// Request-shape guards for the /api/native/* route handlers. Pure with respect
// to auth (no session/DB imports) so they unit-test without the NextAuth chain;
// lib/deploy/api-session re-exports them for the routes.

import { ApiError } from "@/lib/deploy/api-types";
import { BodyTooLargeError, readBoundedBytes } from "@/lib/http-body";
import { logWarn } from "@/lib/log";

// Hard ceiling on a /api/native/* JSON body, sized from the contract rather than
// guessed. The largest request the schemas permit is a 200-event deploy batch —
// 200 x (128-char clientId + 2000-char notes + ids/date) — or a 200-entry status
// batch (lib/deploy/contract.ts). That's ~460KB of ASCII, BUT the schema bounds
// are on CHARACTERS (z.string().max(2000) counts UTF-16 code units) while this
// cap is on BYTES: 200 events x 2000 chars of 3-byte CJK is ~1.2MB and still
// schema-legal. 2MB clears that with room to spare, and still cuts what a caller
// can make us buffer to well under half Vercel's ~4.5MB platform ceiling (#239).
export const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

// CSRF guard for the cookie-authenticated mutation routes. The session rides on
// a sameSite=lax cookie, which still accompanies a top-level cross-site form
// POST — so reject any mutation whose browser-set metadata says it came from
// another origin. Requests with NEITHER header (curl, the future iOS
// bearer-token client) pass: a browser always sends Origin on a cross-site
// POST, so absent-both cannot be a CSRF.
export function assertSameOrigin(req: Request): void {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") {
    throw new ApiError(403, "cross-origin request rejected");
  }

  const origin = req.headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new ApiError(403, "cross-origin request rejected");
    }
    // x-forwarded-host first: behind a TLS-terminating proxy the Host header is
    // rewritten, and Vercel sets/strips x-forwarded-host platform-side.
    const expected =
      req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    if (!expected || originHost.toLowerCase() !== expected.toLowerCase()) {
      throw new ApiError(403, "cross-origin request rejected");
    }
  }
}

// Parse a JSON request body, requiring the JSON content type. A cross-site HTML
// form can only send urlencoded / multipart / text-plain, so requiring
// application/json (which the PWA client already sends) closes the
// enctype="text/plain" smuggle as a second CSRF belt.
//
// Bounded and typed on failure, rather than `return req.json()`:
//   413 — the body exceeds MAX_JSON_BODY_BYTES. Enforced by a streaming read
//         that aborts mid-body, so an oversized payload is never fully buffered
//         (#239). The Content-Length pre-check below is only a cheap fast path;
//         it's sender-supplied and absent under chunked encoding.
//   400 — the body isn't valid JSON. req.json()'s raw SyntaxError used to fall
//         through runApi's ApiError/ZodError cases into the generic branch,
//         logging api.native.unhandled and returning a 500 — so a truncated
//         outbox replay from a flaky floor connection read as a server bug, and
//         the client retried a request that could never succeed (#201/#213).
export async function readJsonBody(req: Request): Promise<unknown> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "expected application/json");
  }

  const declaredLen = Number(req.headers.get("content-length") ?? 0);
  if (declaredLen > MAX_JSON_BODY_BYTES) {
    throw new ApiError(413, "request body too large");
  }

  let raw: string;
  try {
    // Per the Fetch spec `body` is null only when there IS no body, so a null
    // body correctly decodes to "" and fails the JSON parse below as a 400 —
    // no buffered fallback path, which would reintroduce the very
    // read-then-check pattern this function exists to remove.
    const bytes = await readBoundedBytes(req.body, MAX_JSON_BODY_BYTES);
    raw = new TextDecoder().decode(bytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      throw new ApiError(413, "request body too large");
    }
    // Anything else here is a mid-stream read failure (dropped floor
    // connection) or an outright bug in the reader. 400 is the right answer to
    // the caller either way, but runApi returns ApiError WITHOUT logging, so
    // without this line a genuine server-side fault would vanish silently.
    // Metadata only — never the body itself.
    logWarn("api.native.body-read-failed", "could not read request body", {
      err: err instanceof Error ? err.message : String(err),
    });
    throw new ApiError(400, "could not read request body");
  }

  try {
    return JSON.parse(raw);
  } catch {
    // Before this, a raw SyntaxError reached runApi's generic branch and was
    // logged as api.native.unhandled — misleading, but it WAS a signal. ApiError
    // returns without logging, so keep a warn-level line (out of error alerting,
    // still filterable) or a client bug becomes completely invisible. Byte count
    // only: the body is caller-controlled and must never be logged.
    logWarn("api.native.invalid-json", "malformed JSON body rejected", {
      bytes: raw.length,
    });
    // Deliberately not echoing the parser message — it quotes the offending
    // input back at the caller and adds nothing actionable.
    throw new ApiError(400, "invalid JSON body");
  }
}
