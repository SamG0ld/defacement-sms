import { describe, it, expect, afterEach } from "vitest";

import { clientIpFromHeaders, resolveTrustProxyDepth } from "@/lib/client-ip";

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

const originalDepth = process.env.TRUST_PROXY_DEPTH;
afterEach(() => {
  if (originalDepth === undefined) delete process.env.TRUST_PROXY_DEPTH;
  else process.env.TRUST_PROXY_DEPTH = originalDepth;
});

describe("resolveTrustProxyDepth", () => {
  it("defaults to 1 (rightmost entry) when unset", () => {
    delete process.env.TRUST_PROXY_DEPTH;
    expect(resolveTrustProxyDepth()).toBe(1);
  });

  it("reads a positive integer", () => {
    process.env.TRUST_PROXY_DEPTH = "3";
    expect(resolveTrustProxyDepth()).toBe(3);
  });

  it.each(["0", "-1", "1.5", "two", "", "  ", "2 hops"])(
    "falls back to the safe default for a malformed value (%j)",
    (value) => {
      process.env.TRUST_PROXY_DEPTH = value;
      expect(resolveTrustProxyDepth()).toBe(1);
    },
  );
});

describe("clientIpFromHeaders — x-forwarded-for", () => {
  it("takes the rightmost entry, not the client-supplied leftmost one", () => {
    // The attacker prepends a forged address; the proxy appends the peer address
    // it actually observed. Reading from the right defeats the spoof.
    const ip = clientIpFromHeaders(
      headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }),
    );
    expect(ip).toBe("203.0.113.9");
  });

  it("keys the same real client regardless of the forged prefix (no bypass by rotation)", () => {
    const a = clientIpFromHeaders(
      headers({ "x-forwarded-for": "10.0.0.1, 203.0.113.9" }),
    );
    const b = clientIpFromHeaders(
      headers({ "x-forwarded-for": "10.0.0.2, 203.0.113.9" }),
    );
    expect(a).toBe(b);
  });

  it("returns the only entry when the edge overwrites the header (Vercel)", () => {
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "203.0.113.9" }))).toBe(
      "203.0.113.9",
    );
  });

  it("trims whitespace around entries", () => {
    expect(
      clientIpFromHeaders(headers({ "x-forwarded-for": " 1.2.3.4 ,  203.0.113.9  " })),
    ).toBe("203.0.113.9");
  });

  it("ignores empty entries from a doubled comma", () => {
    expect(
      clientIpFromHeaders(headers({ "x-forwarded-for": "1.2.3.4,,203.0.113.9,," })),
    ).toBe("203.0.113.9");
  });

  it("handles IPv6", () => {
    expect(
      clientIpFromHeaders(headers({ "x-forwarded-for": "2001:db8::1, 2001:db8::2" })),
    ).toBe("2001:db8::2");
  });

  it("TRUST_PROXY_DEPTH=2 skips one appending proxy hop", () => {
    process.env.TRUST_PROXY_DEPTH = "2";
    expect(
      clientIpFromHeaders(
        headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.7" }),
      ),
    ).toBe("203.0.113.9");
  });

  it("clamps to the RIGHTMOST entry when the depth exceeds the chain length", () => {
    // A misconfigured depth must never land on the client-supplied leftmost
    // entry — that would let an attacker pad the chain and key on their own
    // value, silently voiding the limiter. Over-throttling is the safe failure.
    process.env.TRUST_PROXY_DEPTH = "9";
    expect(
      clientIpFromHeaders(
        headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9", "x-real-ip": "9.9.9.9" }),
      ),
    ).toBe("203.0.113.9");
  });

  it("a padded chain can't buy a fresh budget when the depth is misconfigured", () => {
    process.env.TRUST_PROXY_DEPTH = "4";
    const a = clientIpFromHeaders(
      headers({ "x-forwarded-for": "a, b, 203.0.113.9" }),
    );
    const b = clientIpFromHeaders(
      headers({ "x-forwarded-for": "c, d, 203.0.113.9" }),
    );
    expect(a).toBe("203.0.113.9");
    expect(b).toBe("203.0.113.9");
  });

  it("still honors a correctly configured depth", () => {
    // Two appending proxies, client sent no header: "client, p1".
    process.env.TRUST_PROXY_DEPTH = "2";
    expect(
      clientIpFromHeaders(headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.7" })),
    ).toBe("203.0.113.9");
  });

  it("bounds the returned value so a crafted header can't make an unbounded key", () => {
    const huge = "a".repeat(5000);
    const ip = clientIpFromHeaders(headers({ "x-forwarded-for": huge }));
    expect(ip.length).toBeLessThanOrEqual(64);
  });
});

describe("clientIpFromHeaders — fallbacks", () => {
  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    expect(clientIpFromHeaders(headers({ "x-real-ip": "203.0.113.9" }))).toBe(
      "203.0.113.9",
    );
  });

  it("falls back to x-real-ip when x-forwarded-for is present but empty", () => {
    expect(
      clientIpFromHeaders(
        headers({ "x-forwarded-for": " , ", "x-real-ip": "203.0.113.9" }),
      ),
    ).toBe("203.0.113.9");
  });

  it("returns 'unknown' when neither header is present", () => {
    expect(clientIpFromHeaders(headers({}))).toBe("unknown");
  });

  it("returns 'unknown' rather than an empty key when x-real-ip is blank", () => {
    expect(clientIpFromHeaders(headers({ "x-real-ip": "   " }))).toBe("unknown");
  });

  it("bounds an over-long x-real-ip too", () => {
    const ip = clientIpFromHeaders(headers({ "x-real-ip": "b".repeat(5000) }));
    expect(ip.length).toBeLessThanOrEqual(64);
  });
});
