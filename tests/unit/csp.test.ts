import { describe, it, expect, afterEach } from "vitest";

import {
  buildCsp,
  cspResponseHeaderName,
  generateNonce,
  resolveCspMode,
} from "@/lib/csp";

// Pull the script-src / style-src directive out of a CSP string for assertions.
function directive(csp: string, name: string): string | undefined {
  return csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `));
}

describe("generateNonce", () => {
  it("is URL-safe base64 with no padding", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateNonce()).not.toMatch(/[+/=]/);
    }
  });

  it("is 22 chars (base64url of 16 random bytes)", () => {
    expect(generateNonce()).toHaveLength(22);
  });

  it("is unique per call (128-bit entropy)", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => generateNonce()));
    expect(nonces.size).toBe(50);
  });
});

describe("buildCsp", () => {
  it("puts the per-request nonce in script-src", () => {
    const nonce = generateNonce();
    expect(directive(buildCsp(nonce), "script-src")).toContain(`'nonce-${nonce}'`);
  });

  it("uses 'strict-dynamic' and drops 'unsafe-inline' from script-src", () => {
    const scriptSrc = directive(buildCsp(generateNonce()), "script-src");
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("keeps 'unsafe-inline' in style-src (Tailwind v4 critical CSS)", () => {
    expect(directive(buildCsp(generateNonce()), "style-src")).toContain(
      "'unsafe-inline'",
    );
  });

  it("locks down framing and plugin embeds", () => {
    const csp = buildCsp(generateNonce());
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it("wires CSP violation reporting (report-to + report-uri)", () => {
    const csp = buildCsp(generateNonce());
    expect(csp).toContain("report-to csp-endpoint");
    expect(csp).toContain("report-uri /api/csp-report");
  });
});

describe("resolveCspMode / cspResponseHeaderName", () => {
  const original = process.env.CSP_MODE;
  afterEach(() => {
    if (original === undefined) delete process.env.CSP_MODE;
    else process.env.CSP_MODE = original;
  });

  it("maps each mode to the correct response header name", () => {
    expect(cspResponseHeaderName("enforce")).toBe("Content-Security-Policy");
    expect(cspResponseHeaderName("report")).toBe(
      "Content-Security-Policy-Report-Only",
    );
  });

  it("resolves to a valid mode by default", () => {
    expect(["enforce", "report"]).toContain(resolveCspMode());
  });

  it("CSP_MODE=enforce overrides NODE_ENV", () => {
    process.env.CSP_MODE = "enforce";
    expect(resolveCspMode()).toBe("enforce");
  });

  it("CSP_MODE=report overrides NODE_ENV", () => {
    process.env.CSP_MODE = "report";
    expect(resolveCspMode()).toBe("report");
  });

  it("an unrecognized CSP_MODE falls back to report", () => {
    process.env.CSP_MODE = "bogus";
    expect(resolveCspMode()).toBe("report");
  });
});
