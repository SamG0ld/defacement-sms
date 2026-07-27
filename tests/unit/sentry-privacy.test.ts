import { describe, it, expect } from "vitest";

import {
  SENTRY_DATA_COLLECTION,
  scrubSentryEvent,
} from "@/lib/sentry-privacy";

// A real NextAuth session cookie is a bearer JWE: whoever holds it IS that user.
const SESSION_COOKIE =
  "__Secure-authjs.session-token=eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..SECRET";

describe("SENTRY_DATA_COLLECTION", () => {
  // requestDataIntegration derives `include.X = dataCollection.X !== false`, so
  // ONLY an explicit `false` turns a category off. `sendDefaultPii: false` sets
  // these to deny-list OBJECTS, which are `!== false` — that is the whole bug.
  it("switches off every request-data category explicitly", () => {
    expect(SENTRY_DATA_COLLECTION.cookies).toBe(false);
    expect(SENTRY_DATA_COLLECTION.httpHeaders.request).toBe(false);
    expect(SENTRY_DATA_COLLECTION.httpHeaders.response).toBe(false);
    expect(SENTRY_DATA_COLLECTION.urlQueryParams).toBe(false);
  });

  // Load-bearing: supplying a partial dataCollection REPLACES the block derived
  // from sendDefaultPii, so omitting userInfo flips IP collection back ON.
  it("keeps userInfo false — omitting it silently re-enables IP capture", () => {
    expect(SENTRY_DATA_COLLECTION.userInfo).toBe(false);
  });

  // Same replacement rule: resolveDataCollectionOptions switches its base to the
  // permissive DEFAULTS as soon as ANY dataCollection object is supplied, so a
  // key left out of this block resolves to the permissive default, not to the
  // sendDefaultPii-derived one.
  it("pins the keys that would otherwise resolve to permissive defaults", () => {
    expect(SENTRY_DATA_COLLECTION.httpBodies).toEqual([]);
    expect(SENTRY_DATA_COLLECTION.databaseQueryData).toBe(false);
    expect(SENTRY_DATA_COLLECTION.genAI.inputs).toBe(false);
    expect(SENTRY_DATA_COLLECTION.genAI.outputs).toBe(false);
  });
});

describe("scrubSentryEvent", () => {
  it("drops the cookie header (the session token)", () => {
    const scrubbed = scrubSentryEvent({
      request: { headers: { cookie: SESSION_COOKIE, "user-agent": "x" } },
    });
    expect(scrubbed.request?.headers).not.toHaveProperty("cookie");
    expect(JSON.stringify(scrubbed)).not.toContain("SECRET");
  });

  it("drops cookies and query_string wholesale", () => {
    const scrubbed = scrubSentryEvent({
      request: {
        cookies: { "authjs.session-token": "SECRET" },
        query_string: "token=SECRET",
        headers: {},
      },
    });
    expect(scrubbed.request).not.toHaveProperty("cookies");
    expect(scrubbed.request).not.toHaveProperty("query_string");
    expect(JSON.stringify(scrubbed)).not.toContain("SECRET");
  });

  // `include.data` is hardcoded true in requestdata.js and the node SDK buffers
  // up to 10KB of body by default — so the POST payload of a login or import
  // action reaches the event whatever dataCollection says.
  it("drops the request body (request.data)", () => {
    const scrubbed = scrubSentryEvent({
      request: { data: { email: "someone@example.com", token: "SECRET" } },
    });
    expect(scrubbed.request).not.toHaveProperty("data");
    expect(JSON.stringify(scrubbed)).not.toContain("SECRET");
  });

  // `include.url` is hardcoded true and utils/request.js builds it from
  // `request.url`, query string intact — `urlQueryParams: false` only gates the
  // separate `query_string` field.
  it("keeps request.url's path but strips its query string", () => {
    const scrubbed = scrubSentryEvent({
      request: { url: "https://app.example.com/login?callbackUrl=%2Fsigns&token=SECRET" },
    });
    expect(scrubbed.request?.url).toBe("https://app.example.com/login");
    expect(JSON.stringify(scrubbed)).not.toContain("SECRET");
  });

  // captureRequestError writes Next's raw `req.url` here, OUTSIDE event.request,
  // so no dataCollection option can reach it.
  it("strips the query string from contexts.nextjs.request_path", () => {
    const scrubbed = scrubSentryEvent({
      request: { headers: {} },
      contexts: { nextjs: { request_path: "/login?token=SECRET", router_kind: "App" } },
    });
    expect(scrubbed.contexts.nextjs.request_path).toBe("/login");
    // The rest of the nextjs context is diagnostic and must survive.
    expect(scrubbed.contexts.nextjs.router_kind).toBe("App");
    expect(JSON.stringify(scrubbed)).not.toContain("SECRET");
  });

  // The scrub used to early-return on `!event.request`, which skipped contexts
  // entirely — and a browser/edge event can carry request_path with no request.
  it("still scrubs contexts on an event with NO request section", () => {
    const scrubbed = scrubSentryEvent({
      contexts: { nextjs: { request_path: "/api/auth/callback/resend?token=SECRET" } },
    });
    expect(scrubbed.contexts.nextjs.request_path).toBe("/api/auth/callback/resend");
    expect(JSON.stringify(scrubbed)).not.toContain("SECRET");
  });

  // httpContextIntegration (browser) sets Referer from document.referrer
  // unconditionally; `httpHeaders: false` does not stop it.
  it("drops the referer header the browser SDK attaches unconditionally", () => {
    const scrubbed = scrubSentryEvent({
      request: {
        headers: { Referer: "https://app.example.com/login?token=SECRET", "user-agent": "x" },
      },
    });
    expect(scrubbed.request?.headers).not.toHaveProperty("Referer");
    expect(JSON.stringify(scrubbed)).not.toContain("SECRET");
  });

  it("drops authorization and api-key headers, case-insensitively", () => {
    const scrubbed = scrubSentryEvent({
      request: {
        headers: {
          Authorization: "Bearer SECRET",
          "X-Api-Key": "SECRET",
          "Proxy-Authorization": "Basic SECRET",
        },
      },
    });
    expect(JSON.stringify(scrubbed)).not.toContain("SECRET");
  });

  it("keeps the harmless context that makes an event useful", () => {
    const scrubbed = scrubSentryEvent({
      request: { headers: { "user-agent": "Firefox", "content-type": "json" } },
    });
    expect(scrubbed.request?.headers).toEqual({
      "user-agent": "Firefox",
      "content-type": "json",
    });
  });

  it("passes through an event with no request section", () => {
    const event = { request: undefined, message: "boom" };
    expect(scrubSentryEvent(event)).toEqual(event);
  });

  // House style: don't mutate what the caller handed us.
  it("does not mutate the input event", () => {
    const event = { request: { headers: { cookie: SESSION_COOKIE } } };
    scrubSentryEvent(event);
    expect(event.request.headers.cookie).toBe(SESSION_COOKIE);
  });

  // Same discipline for the contexts branch: every level touched is copied.
  it("does not mutate the input event's request or contexts", () => {
    const event = {
      request: { url: "https://app.example.com/x?token=SECRET", data: { a: 1 } },
      contexts: { nextjs: { request_path: "/x?token=SECRET" } },
    };
    const scrubbed = scrubSentryEvent(event);

    expect(event.request.url).toBe("https://app.example.com/x?token=SECRET");
    expect(event.request.data).toEqual({ a: 1 });
    expect(event.contexts.nextjs.request_path).toBe("/x?token=SECRET");
    expect(scrubbed.request).not.toBe(event.request);
    expect(scrubbed.contexts).not.toBe(event.contexts);
    expect(scrubbed.contexts.nextjs).not.toBe(event.contexts.nextjs);
  });
});
