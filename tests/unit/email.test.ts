import { afterEach, beforeEach, describe, it, expect } from "vitest";

import {
  canReceiveMagicLink,
  escapeHtml,
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
});
