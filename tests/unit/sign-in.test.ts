import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The login Server Actions call signIn() in-process (next-auth builds a synthetic
// Request and calls Auth() directly), so nothing here should reach the network.
// Mock the four boundaries the actions touch; the rate-limit decision is driven
// per test. redirect() throws NEXT_REDIRECT carrying the url — same harness shape
// as tests/integration/user-actions.test.ts.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    const e = new Error("NEXT_REDIRECT");
    (e as unknown as { redirectUrl: string }).redirectUrl = url;
    throw e;
  }),
}));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));
vi.mock("@/lib/ratelimit", () => ({ checkAuthRateLimit: vi.fn() }));
// Real delay is 150-350ms of wall clock and nothing here asserts on it; its own
// bounds are covered in tests/unit/email.test.ts. lib/client-ip stays REAL so the
// x-forwarded-for keying assertions exercise the actual wiring.
vi.mock("@/lib/email", () => ({ equalizeMagicLinkLatency: vi.fn() }));
vi.mock("@/lib/log", () => ({ logWarn: vi.fn(), logError: vi.fn() }));

import { headers } from "next/headers";

import { signIn } from "@/lib/auth";
import { logWarn } from "@/lib/log";
import { checkAuthRateLimit } from "@/lib/ratelimit";
import { startGoogleSignIn, startMagicLinkSignIn } from "@/lib/sign-in";

const ALLOWED = { success: true, remaining: 9, reset: 0 };
const THROTTLED = { success: false, remaining: 0, reset: 0 };

// Written out rather than imported from the module under test, so the assertion
// is a real contract and not a tautology. This is the URL @auth/core redirects a
// SUCCESSFUL send to; every non-sending path has to land here too, or the
// difference in final URL is itself an "is this address on the team" oracle.
const SENT_SCREEN = "/api/auth/verify-request?provider=resend&type=email";

// Capture the url a thrown redirect() was aiming at.
async function captureRedirect(run: () => Promise<void>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const url = (err as { redirectUrl?: string }).redirectUrl;
    if (url) return url;
    throw err;
  }
  throw new Error("expected a redirect, but the action returned normally");
}

beforeEach(() => {
  vi.mocked(headers).mockResolvedValue(
    new Headers({ "x-forwarded-for": "203.0.113.9" }) as never,
  );
  vi.mocked(checkAuthRateLimit).mockResolvedValue(ALLOWED);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("startMagicLinkSignIn — rate limiting (#173)", () => {
  it("does NOT call signIn once the per-IP limit is exhausted", async () => {
    vi.mocked(checkAuthRateLimit).mockResolvedValue(THROTTLED);
    const url = await captureRedirect(() =>
      startMagicLinkSignIn("/", "goon@example.com"),
    );
    expect(signIn).not.toHaveBeenCalled();
    expect(url).toBe("/login?error=RateLimited");
  });

  it("stops triggering sends after the budget runs out (mail-bomb backstop)", async () => {
    // 10 allowed, then throttled: signIn must be called exactly 10 times.
    let calls = 0;
    vi.mocked(checkAuthRateLimit).mockImplementation(async () =>
      ++calls <= 10 ? ALLOWED : THROTTLED,
    );
    for (let i = 0; i < 25; i++) {
      await startMagicLinkSignIn("/", "goon@example.com").catch(() => {});
    }
    expect(signIn).toHaveBeenCalledTimes(10);
  });

  it("keys the limiter on the client IP", async () => {
    await startMagicLinkSignIn("/", "goon@example.com");
    expect(checkAuthRateLimit).toHaveBeenCalledWith("203.0.113.9");
  });

  it("keys off the rightmost x-forwarded-for entry, so a forged prefix can't rotate the budget", async () => {
    vi.mocked(headers).mockResolvedValue(
      new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }) as never,
    );
    await startMagicLinkSignIn("/", "goon@example.com");
    expect(checkAuthRateLimit).toHaveBeenCalledWith("203.0.113.9");
  });

  it("passes the address through to signIn when under the limit", async () => {
    await startMagicLinkSignIn("/signs", "goon@example.com");
    expect(signIn).toHaveBeenCalledWith("resend", {
      email: "goon@example.com",
      redirectTo: "/signs",
    });
  });

  it("trims the submitted address", async () => {
    await startMagicLinkSignIn("/", "  goon@example.com  ");
    expect(signIn).toHaveBeenCalledWith("resend", {
      email: "goon@example.com",
      redirectTo: "/",
    });
  });
});

describe("startMagicLinkSignIn — malformed address", () => {
  it("short-circuits to the sent screen without calling signIn", async () => {
    const url = await captureRedirect(() => startMagicLinkSignIn("/", "not-an-email"));
    expect(signIn).not.toHaveBeenCalled();
    expect(url).toBe(SENT_SCREEN);
  });

  it("spends rate-limit budget before the shape check, so garbage isn't a free probe", async () => {
    await captureRedirect(() => startMagicLinkSignIn("/", "not-an-email"));
    expect(checkAuthRateLimit).toHaveBeenCalledTimes(1);
  });

  it("a throttled malformed address reports the throttle, not a fake send", async () => {
    vi.mocked(checkAuthRateLimit).mockResolvedValue(THROTTLED);
    const url = await captureRedirect(() => startMagicLinkSignIn("/", "not-an-email"));
    expect(url).toBe("/login?error=RateLimited");
  });

  it.each(["", "   ", "@example.com", "goon@", "goon@example", "a b@c.com"])(
    "rejects %j without reaching signIn",
    async (value) => {
      await captureRedirect(() => startMagicLinkSignIn("/", value));
      expect(signIn).not.toHaveBeenCalled();
    },
  );
});

describe("startMagicLinkSignIn — enumeration guard (#227)", () => {
  // @auth/core runs the closed-registration signIn callback BEFORE
  // sendVerificationRequest and throws AccessDenied for a non-team address. On
  // the Server Action path that throw escapes (Auth is called with `raw`), so an
  // unknown address would 500 while a real teammate gets the sent screen —
  // a one-request "is this address on the team?" oracle.
  // Fixtures mirror what @auth/core actually constructs, including the
  // "Read more at <url>" suffix its AuthError constructor appends to every
  // message — the shapes, not a simplification of them.
  const DOCS = "Read more at https://errors.authjs.dev#accessdenied";

  // A deliberate `return false` from the closed-registration callback: @auth/core
  // throws `new AccessDenied("AccessDenied")` — a string message, so no cause.
  function accessDenied(): Error {
    const e = new Error(`AccessDenied. ${DOCS}`);
    (e as unknown as { type: string }).type = "AccessDenied";
    return e;
  }

  // An exception thrown INSIDE that callback (e.g. its Prisma lookup dying on a
  // database cold start): @auth/core rethrows it as `new AccessDenied(err)`. Given an
  // Error, the constructor leaves the message empty and records the original
  // under cause.err.
  function wrappedInfraFailure(): Error {
    const e = new Error(DOCS);
    (e as unknown as { type: string }).type = "AccessDenied";
    (e as unknown as { cause: unknown }).cause = {
      err: new Error("Can't reach database server"),
    };
    return e;
  }

  it("shows an unknown address the same 'link dispatched' screen as a teammate", async () => {
    vi.mocked(signIn).mockRejectedValueOnce(accessDenied());
    const url = await captureRedirect(() =>
      startMagicLinkSignIn("/", "stranger@example.com"),
    );
    expect(url).toBe(SENT_SCREEN);
  });

  it("is indistinguishable from the malformed-address response", async () => {
    vi.mocked(signIn).mockRejectedValueOnce(accessDenied());
    const unknown = await captureRedirect(() =>
      startMagicLinkSignIn("/", "stranger@example.com"),
    );
    vi.mocked(signIn).mockReset();
    const malformed = await captureRedirect(() =>
      startMagicLinkSignIn("/", "not-an-email"),
    );
    expect(unknown).toBe(malformed);
  });

  it("does NOT swallow a genuine send failure — that still surfaces", async () => {
    // Only AccessDenied is absorbed; a real delivery error must not be reported
    // to a teammate as a link that was sent.
    const boom = new Error("Resend send failed (500)");
    vi.mocked(signIn).mockRejectedValueOnce(boom);
    await expect(startMagicLinkSignIn("/", "goon@example.com")).rejects.toThrow(
      "Resend send failed (500)",
    );
  });

  it("does NOT absorb an infra failure that @auth/core wrapped as AccessDenied", async () => {
    // Otherwise a DB blip during sign-in would show a teammate "your link is on
    // its way", send nothing, and leave no trace anywhere.
    vi.mocked(signIn).mockRejectedValueOnce(wrappedInfraFailure());
    await expect(startMagicLinkSignIn("/", "goon@example.com")).rejects.toThrow();
  });

  it("does not mistake a NEXT_REDIRECT for a rejection", async () => {
    // signIn() redirects on success by throwing NEXT_REDIRECT — that carries
    // `digest`, not `type`, and must pass straight through.
    const nextRedirect = new Error("NEXT_REDIRECT");
    (nextRedirect as unknown as { digest: string }).digest =
      "NEXT_REDIRECT;replace;/;307;";
    vi.mocked(signIn).mockRejectedValueOnce(nextRedirect);
    await expect(startMagicLinkSignIn("/", "goon@example.com")).rejects.toThrow(
      "NEXT_REDIRECT",
    );
  });
});

describe("startGoogleSignIn — rate limiting (#173)", () => {
  it("does NOT call signIn once the per-IP limit is exhausted", async () => {
    vi.mocked(checkAuthRateLimit).mockResolvedValue(THROTTLED);
    const url = await captureRedirect(() => startGoogleSignIn("/"));
    expect(signIn).not.toHaveBeenCalled();
    expect(url).toBe("/login?error=RateLimited");
  });

  it("passes the callback destination through when under the limit", async () => {
    await startGoogleSignIn("/signs");
    expect(signIn).toHaveBeenCalledWith("google", { redirectTo: "/signs" });
  });

  it("keys the limiter on the client IP", async () => {
    await startGoogleSignIn("/");
    expect(checkAuthRateLimit).toHaveBeenCalledWith("203.0.113.9");
  });
});

describe("sign-in actions — throttle observability", () => {
  // A throttle redirects rather than throwing, so nothing else would surface it.
  it("emits one filterable warn line when a sign-in is throttled", async () => {
    vi.mocked(checkAuthRateLimit).mockResolvedValue(THROTTLED);
    await captureRedirect(() => startMagicLinkSignIn("/", "goon@example.com"));
    expect(logWarn).toHaveBeenCalledWith(
      "auth.ratelimit.blocked",
      expect.any(String),
      { flow: "magic-link" },
    );
  });

  it("distinguishes the OAuth flow from the mail-sending one", async () => {
    vi.mocked(checkAuthRateLimit).mockResolvedValue(THROTTLED);
    await captureRedirect(() => startGoogleSignIn("/"));
    expect(logWarn).toHaveBeenCalledWith(
      "auth.ratelimit.blocked",
      expect.any(String),
      { flow: "google" },
    );
  });

  it("stays quiet when the request is allowed", async () => {
    await startGoogleSignIn("/");
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("logs neither the email address nor the client IP", async () => {
    // lib/request-context.ts keeps this app's audit trail deliberately IP-less;
    // an observability line must not quietly reintroduce either.
    vi.mocked(checkAuthRateLimit).mockResolvedValue(THROTTLED);
    await captureRedirect(() =>
      startMagicLinkSignIn("/", "secret.goon@example.com"),
    );
    const logged = JSON.stringify(vi.mocked(logWarn).mock.calls);
    expect(logged).not.toContain("secret.goon@example.com");
    expect(logged).not.toContain("203.0.113.9");
  });
});

describe("sign-in actions — limiter unavailable", () => {
  it("fails open so an Upstash outage can't lock the team out of login", async () => {
    // lib/ratelimit.ts already fails open internally; assert the caller honours
    // that contract rather than treating a permissive result as a block.
    vi.mocked(checkAuthRateLimit).mockResolvedValue({
      success: true,
      remaining: Number.POSITIVE_INFINITY,
      reset: 0,
    });
    await startGoogleSignIn("/");
    expect(signIn).toHaveBeenCalledWith("google", { redirectTo: "/" });
  });
});
