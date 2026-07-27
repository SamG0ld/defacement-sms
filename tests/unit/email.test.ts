import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import {
  canReceiveMagicLink,
  equalizeMagicLinkLatency,
  escapeHtml,
  magicLinkDecoyDelayMs,
  sendMagicLinkEmail,
  sendWelcomeEmail,
} from "@/lib/email";

describe("canReceiveMagicLink (closed-registration gate)", () => {
  it("sends to an existing active user", () => {
    expect(canReceiveMagicLink({ isActive: true })).toBe(true);
  });

  it("refuses a deactivated user", () => {
    expect(canReceiveMagicLink({ isActive: false })).toBe(false);
  });

  it("refuses a non-user (no row)", () => {
    expect(canReceiveMagicLink(null)).toBe(false);
    expect(canReceiveMagicLink(undefined)).toBe(false);
  });
});

describe("magic-link timing equalization (#227)", () => {
  it("stays within the advertised jitter window", () => {
    for (let i = 0; i < 200; i++) {
      const ms = magicLinkDecoyDelayMs();
      expect(ms).toBeGreaterThanOrEqual(150);
      expect(ms).toBeLessThanOrEqual(350);
    }
  });

  it("varies per call, so the decoy path has no constant signature", () => {
    const samples = new Set(
      Array.from({ length: 100 }, () => magicLinkDecoyDelayMs()),
    );
    // A fixed delay would collapse to one value and be trivially subtractable.
    expect(samples.size).toBeGreaterThan(50);
  });

  it("spreads across the window rather than clustering at one end", () => {
    const samples = Array.from({ length: 300 }, () => magicLinkDecoyDelayMs());
    expect(Math.min(...samples)).toBeLessThan(200);
    expect(Math.max(...samples)).toBeGreaterThan(300);
  });

  it("actually waits before resolving", async () => {
    const started = Date.now();
    await equalizeMagicLinkLatency();
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });
});

describe("escapeHtml (email XSS guard)", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("neutralizes a script-injection attempt in a URL", () => {
    const out = escapeHtml('https://x/"><script>alert(1)</script>');
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("leaves a normal URL untouched apart from the ampersand", () => {
    expect(escapeHtml("https://app/api/auth/callback/resend?token=abc&email=a")).toBe(
      "https://app/api/auth/callback/resend?token=abc&amp;email=a",
    );
  });
});

describe("sendMagicLinkEmail (config guard)", () => {
  const saved = {
    key: process.env.AUTH_RESEND_KEY,
    from: process.env.EMAIL_FROM,
  };

  beforeEach(() => {
    delete process.env.AUTH_RESEND_KEY;
    delete process.env.EMAIL_FROM;
  });
  afterEach(() => {
    process.env.AUTH_RESEND_KEY = saved.key;
    process.env.EMAIL_FROM = saved.from;
  });

  it("throws (does not silently fetch) when Resend env is unset", async () => {
    await expect(
      sendMagicLinkEmail("a@b.com", "https://app/link"),
    ).rejects.toThrow(/not configured/i);
  });

  it("sendWelcomeEmail shares the same config guard", async () => {
    await expect(
      sendWelcomeEmail("a@b.com", "https://app/login"),
    ).rejects.toThrow(/not configured/i);
  });

  it("config error names no env vars (no log recon — #58)", async () => {
    let message = "";
    try {
      await sendMagicLinkEmail("a@b.com", "https://app/link");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBeTruthy(); // it did throw
    expect(message).not.toMatch(/AUTH_RESEND_KEY|EMAIL_FROM/);
  });
});

// #73: nothing asserted the JSON shape actually POSTed to Resend, so a field rename
// (e.g. text → plainText) would silently break every magic-link email without
// failing a test. Stub fetch and pin the wire contract.
describe("sendViaResend wire contract (#73)", () => {
  const saved = {
    key: process.env.AUTH_RESEND_KEY,
    from: process.env.EMAIL_FROM,
  };

  beforeEach(() => {
    process.env.AUTH_RESEND_KEY = "test-key";
    process.env.EMAIL_FROM = "noreply@example.com";
  });
  afterEach(() => {
    process.env.AUTH_RESEND_KEY = saved.key;
    process.env.EMAIL_FROM = saved.from;
    vi.unstubAllGlobals();
  });

  it("POSTs the documented JSON shape + auth header to Resend", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendMagicLinkEmail("user@test.com", "https://app/magic?token=abc");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(opts.method).toBe("POST");
    const headers = opts.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(opts.body as string);
    expect(body).toMatchObject({
      from: "noreply@example.com",
      to: "user@test.com",
      subject: expect.any(String),
      text: expect.any(String),
      html: expect.any(String),
    });
  });

  it("throws on a non-2xx Resend response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 422 })),
    );
    await expect(
      sendMagicLinkEmail("user@test.com", "https://app/x"),
    ).rejects.toThrow(/Resend send failed \(422\)/);
  });
});
