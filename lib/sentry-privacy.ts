// Shared PII posture for all three Sentry SDK inits (server, edge, browser).
//
// `sendDefaultPii: false` is NOT sufficient, and the gap is a live session token.
// Measured against the installed @sentry/core 10.68, not assumed:
//
//   sendDefaultPii:false  →  cookies:      { deny: ["forwarded","-ip","remote-","via","-user"] }
//                            httpHeaders:  { request: { deny: [...same...] }, ... }
//                            userInfo:     false
//
// i.e. cookies/headers resolve to DENY-LISTS, not to `false`. requestDataIntegration
// then computes `include.cookies = dataCollection.cookies !== false`, so both are
// still attached to the EVENT — the deny-list is only consulted on the span path,
// and neither `cookie` nor `authorization` appears on it. Only `ip` actually
// flips off. Meanwhile instrumentation.ts wires
// `onRequestError = Sentry.captureRequestError`, which forwards ALL request
// headers verbatim (headersToDict). Net effect: an uncaught 500 on an
// authenticated page would ship that user's `__Secure-authjs.session-token` — a
// bearer JWE, replayable as that user — to Sentry. So switch the data off
// structurally rather than trusting the flag.
//
// CAUTION: `userInfo: false` below is load-bearing. Supplying a partial
// `dataCollection` object REPLACES the block derived from sendDefaultPii, so
// omitting userInfo flips IP collection back ON (verified against 10.68).
// `resolveDataCollectionOptions` switches its base to the permissive DEFAULTS the
// moment ANY `dataCollection` object is supplied, so every key omitted here
// resolves permissive — which is why the block enumerates them all.
//
// AND `dataCollection` cannot reach everything. Three fields carry the same
// secrets and are NOT gated by it, which is what makes the `beforeSend` scrub
// below load-bearing rather than merely belt-and-braces:
//
//   • `event.request.url` — `integrations/requestdata.js` hardcodes
//     `include.url = true` ("No dataCollection equivalent — URL is always
//     included"). `utils/request.js` builds it from `request.url`, so it keeps
//     the QUERY STRING even under `urlQueryParams: false`; the `query_string`
//     field that option does gate is a separate field.
//   • `event.request.data` — `include.data` is likewise hardcoded `true`
//     ("dataCollection.httpBodies gates write-time, not read-time"), and the
//     node SDK's httpServerIntegration defaults `maxRequestBodySize` to
//     "medium" (10KB) with no reference to sendDefaultPii/dataCollection at all.
//     sentry.server.config.ts turns the buffering off at the source; this is the
//     second line, and the only one on the edge/browser paths.
//   • `event.contexts.nextjs.request_path` — @sentry/nextjs's
//     captureRequestError does `scope.setContext("nextjs", { request_path:
//     request.path, ... })`, and Next's base-server passes `req.url` there,
//     query string included. It lands OUTSIDE `event.request`, so no
//     request-data option touches it.
//
// Magic-link tokens and `callbackUrl` ride in the query string, so those are the
// same leak arriving through three different fields.

// Declared outside the `as const` block below on purpose: the SDK types
// `httpBodies` as a MUTABLE `HttpBodyCollectionTarget[]`, and a const assertion
// would freeze an inline `[]` to `readonly []`, which does not satisfy it.
const NO_HTTP_BODIES: [] = [];

export const SENTRY_DATA_COLLECTION = {
  // No IP addresses. The app is deliberately PII-light (the audit log stores
  // coarse geo, never a raw IP) — keep that posture in Sentry too.
  userInfo: false,
  // The session cookie lives here. This is the one that matters.
  cookies: false,
  httpHeaders: { request: false, response: false },
  // Magic-link tokens and callbackUrl ride in the query string.
  urlQueryParams: false,
  // Request/response BODIES. An empty array disables body collection entirely;
  // omitting the key would resolve to all four targets (the DEFAULTS), which
  // includes the POST payload of every login / import / deploy action.
  httpBodies: NO_HTTP_BODIES,
  // Query parameters, inline literals and returned rows from DB statements —
  // Prisma queries here carry emails, names and sign content.
  databaseQueryData: false,
  // No AI integrations are wired today; pinned so adding one can't start
  // shipping prompt/completion text by default.
  genAI: { inputs: false, outputs: false },
} as const;

const SENSITIVE_HEADERS = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "x-api-key",
  // The browser SDK's httpContextIntegration sets `Referer` from
  // document.referrer onto every event's request unconditionally — it is not
  // gated by `httpHeaders: false`, and on this app the referrer is a magic-link
  // or callbackUrl-bearing URL often enough to matter.
  "referer",
]);

// Structural + all-optional on purpose: the browser, edge and server event
// shapes must all satisfy it, and @sentry/core types `contexts` as
// `Record<string, Record<string, unknown> | undefined>`.
type ScrubbableEvent = {
  request?: {
    cookies?: unknown;
    data?: unknown;
    query_string?: unknown;
    url?: unknown;
    headers?: Record<string, string>;
  };
  contexts?: Record<string, Record<string, unknown> | undefined>;
};

/**
 * Drop the query string from a URL-ish value. Total by construction: a
 * non-string comes back unchanged, and a value `new URL()` rejects (a relative
 * path like `/login?callbackUrl=…`, which is exactly what request_path holds)
 * degrades to a plain split. A throw here would run inside `beforeSend` and
 * could drop the event, so this must not be able to fail.
 */
function stripQuery(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const url = new URL(value);
    url.search = "";
    return url.toString();
  } catch {
    return value.split("?")[0];
  }
}

/**
 * `beforeSend` scrub. Partly belt-and-braces over SENTRY_DATA_COLLECTION (so an
 * SDK upgrade that changes the meaning of those options can't silently re-open
 * the leak) and partly the ONLY control over `request.url`, `request.data` and
 * `contexts.nextjs.request_path`, which no dataCollection key gates — see the
 * header. Returns a new event rather than mutating the one Sentry handed us.
 */
export function scrubSentryEvent<T extends ScrubbableEvent>(event: T): T {
  let scrubbed = event;

  if (event.request) {
    // Copy first, then strip — the caller's event is never touched.
    const request: Record<string, unknown> = { ...event.request };
    delete request.cookies;
    delete request.query_string;
    // Request bodies: `include.data` is hardcoded true, so a login/import POST
    // would otherwise ship its payload verbatim.
    delete request.data;
    // `include.url` is hardcoded true and the URL retains its query string.
    if (request.url !== undefined) request.url = stripQuery(request.url);
    const { headers } = event.request;
    if (headers) {
      request.headers = Object.fromEntries(
        Object.entries(headers).filter(
          ([key]) => !SENSITIVE_HEADERS.has(key.toLowerCase()),
        ),
      );
    }
    scrubbed = { ...scrubbed, request };
  }

  // Deliberately NOT inside the `event.request` branch: captureRequestError
  // writes this context, and an event can carry it with no `request` section at
  // all. Copy every level being changed, same discipline as `request` above.
  const nextjs = event.contexts?.nextjs;
  if (nextjs?.request_path !== undefined) {
    scrubbed = {
      ...scrubbed,
      contexts: {
        ...event.contexts,
        nextjs: { ...nextjs, request_path: stripQuery(nextjs.request_path) },
      },
    };
  }

  return scrubbed;
}
