import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  interpretSpendEvent,
  parseProjectIds,
  pauseProject,
  verifyVercelSignature,
} from "@/lib/vercel-spend";

const SECRET = "whsec_test_secret";

function sign(body: string, secret: string = SECRET): string {
  return createHmac("sha1", secret).update(body).digest("hex");
}

// Minimal stand-in for the bits of Response that pauseProject touches.
function fakeResponse(init: {
  ok: boolean;
  status: number;
  text?: () => Promise<string>;
}): Response {
  return {
    ok: init.ok,
    status: init.status,
    text: init.text ?? (async () => ""),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyVercelSignature", () => {
  const body = JSON.stringify({ thresholdPercent: 100, teamId: "team_x" });

  it("accepts a correct HMAC-SHA1 signature", () => {
    expect(verifyVercelSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    const sig = sign(body);
    expect(verifyVercelSignature(body + " ", sig, SECRET)).toBe(false);
  });

  it("rejects a tampered/garbage signature", () => {
    expect(verifyVercelSignature(body, "deadbeef", SECRET)).toBe(false);
  });

  it("fails closed when the signature header is missing", () => {
    expect(verifyVercelSignature(body, null, SECRET)).toBe(false);
  });

  it("fails closed when the secret is unset (route not configured)", () => {
    expect(verifyVercelSignature(body, sign(body), undefined)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    expect(verifyVercelSignature(body, sign(body, "other"), SECRET)).toBe(false);
  });
});

describe("interpretSpendEvent", () => {
  it("pauses at 100% of budget", () => {
    const d = interpretSpendEvent({ thresholdPercent: 100, teamId: "t" });
    expect(d.action).toBe("pause");
    expect(d.thresholdPercent).toBe(100);
  });

  it("notifies (no pause) at 50% and 75%", () => {
    for (const pct of [50, 75]) {
      const d = interpretSpendEvent({ thresholdPercent: pct, teamId: "t" });
      expect(d.action).toBe("notify");
      expect(d.thresholdPercent).toBe(pct);
    }
  });

  it("notifies but does NOT auto-unpause at end of billing cycle", () => {
    const d = interpretSpendEvent({ type: "endOfBillingCycle", teamId: "t" });
    expect(d.action).toBe("notify");
    expect(d.reason).toMatch(/not auto-unpausing/i);
  });

  it("ignores an unrecognized payload", () => {
    expect(interpretSpendEvent({ foo: "bar" }).action).toBe("ignore");
    expect(interpretSpendEvent(null).action).toBe("ignore");
  });

  it("treats any threshold >= 100 as a pause (defensive)", () => {
    expect(interpretSpendEvent({ thresholdPercent: 150 }).action).toBe("pause");
  });
});

describe("pauseProject", () => {
  it("POSTs the pause endpoint with the team id and bearer token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(fakeResponse({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await pauseProject("prj_abc", { token: "tok_123", teamId: "team_x" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.vercel.com/v1/projects/prj_abc/pause?teamId=team_x",
    );
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok_123");
  });

  it("omits the teamId query param when no team is configured", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(fakeResponse({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await pauseProject("prj_abc", { token: "tok_123" });

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api.vercel.com/v1/projects/prj_abc/pause",
    );
  });

  it("throws (surfacing the status) on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        fakeResponse({ ok: false, status: 403, text: async () => "forbidden" }),
      ),
    );
    await expect(pauseProject("prj_abc", { token: "tok" })).rejects.toThrow(
      /403/,
    );
  });
});

describe("parseProjectIds", () => {
  it("splits, trims, and drops empties", () => {
    expect(parseProjectIds(" prj_a , prj_b ,, prj_c ")).toEqual([
      "prj_a",
      "prj_b",
      "prj_c",
    ]);
  });

  it("returns an empty list when unset", () => {
    expect(parseProjectIds(undefined)).toEqual([]);
    expect(parseProjectIds("")).toEqual([]);
  });
});
