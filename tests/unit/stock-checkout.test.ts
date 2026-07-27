import { describe, expect, it } from "vitest";

import {
  MAX_STOCK_N,
  nextGroupTaken,
  serializeGroupKey,
  stockInputSchema,
  type SignIdentity,
} from "@/lib/stock";

describe("nextGroupTaken — QM group clamp", () => {
  it("takes from the pile when there's enough remaining", () => {
    // group of 10, 0 out, take 4 → 4 out, 6 left.
    expect(nextGroupTaken(10, 0, 4)).toEqual({
      ok: true,
      taken: 4,
      remaining: 6,
    });
  });

  it("returns to the pile, never below zero taken", () => {
    // group of 10, 4 out, return 2 → 2 out, 8 left.
    expect(nextGroupTaken(10, 4, -2)).toEqual({
      ok: true,
      taken: 2,
      remaining: 8,
    });
  });

  it("allows taking exactly the remaining amount (boundary)", () => {
    expect(nextGroupTaken(10, 6, 4)).toEqual({
      ok: true,
      taken: 10,
      remaining: 0,
    });
  });

  it("allows returning exactly what's out (boundary)", () => {
    expect(nextGroupTaken(10, 4, -4)).toEqual({
      ok: true,
      taken: 0,
      remaining: 10,
    });
  });

  it("refuses to oversell — can't take more than remaining", () => {
    // group of 10, 7 out (3 left), try to take 4.
    const r = nextGroupTaken(10, 7, 4);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Only 3 left at QM/);
  });

  it("refuses to return more than is checked out", () => {
    const r = nextGroupTaken(10, 2, -5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Can't return more than is checked out/);
  });

  it("handles a singleton group (the N=1 detail-page case)", () => {
    // group of 1, 0 out, take 1 → fully taken.
    expect(nextGroupTaken(1, 0, 1)).toEqual({
      ok: true,
      taken: 1,
      remaining: 0,
    });
    // taking a second from a 1-member pool is rejected.
    expect(nextGroupTaken(1, 1, 1).ok).toBe(false);
  });
});

describe("serializeGroupKey — group identity", () => {
  const base: SignIdentity = {
    signText: "Code of Conduct",
    signType: "24\"x36\"",
    size: "24\"x36\"",
    category: "easel_sign",
    doubleSided: false,
    needsEasel: true,
    printable: true,
    zoneId: null,
    deploymentSlot: null,
  };

  it("is stable for identical identities", () => {
    expect(serializeGroupKey(base)).toBe(serializeGroupKey({ ...base }));
  });

  it("differs when any identity field differs", () => {
    expect(serializeGroupKey({ ...base, size: "18\"x24\"" })).not.toBe(
      serializeGroupKey(base),
    );
    expect(serializeGroupKey({ ...base, zoneId: 3 })).not.toBe(
      serializeGroupKey(base),
    );
    expect(serializeGroupKey({ ...base, deploymentSlot: "fri" })).not.toBe(
      serializeGroupKey(base),
    );
    expect(serializeGroupKey({ ...base, doubleSided: true })).not.toBe(
      serializeGroupKey(base),
    );
  });

  it("does not collide across free-text field boundaries", () => {
    // A naive `a|b` join could collide; the JSON-array key must not.
    const a = serializeGroupKey({ ...base, signText: "A", signType: "B|C" });
    const b = serializeGroupKey({ ...base, signText: "A|B", signType: "C" });
    expect(a).not.toBe(b);
  });
});

describe("stockInputSchema", () => {
  const base = { signId: 1, n: 2, clientId: "abc-123" };

  it("accepts a well-formed take/return request", () => {
    expect(stockInputSchema.safeParse(base).success).toBe(true);
    expect(
      stockInputSchema.safeParse({ ...base, note: "taken by reg lead" }).success,
    ).toBe(true);
  });

  it("rejects n of zero or negative", () => {
    expect(stockInputSchema.safeParse({ ...base, n: 0 }).success).toBe(false);
    expect(stockInputSchema.safeParse({ ...base, n: -3 }).success).toBe(false);
  });

  it("rejects a non-integer n", () => {
    expect(stockInputSchema.safeParse({ ...base, n: 2.5 }).success).toBe(false);
  });

  it("rejects an absurdly large n (fat-finger / forged)", () => {
    expect(
      stockInputSchema.safeParse({ ...base, n: MAX_STOCK_N + 1 }).success,
    ).toBe(false);
  });

  it("requires a non-empty clientId (the idempotency key)", () => {
    expect(stockInputSchema.safeParse({ ...base, clientId: "" }).success).toBe(
      false,
    );
  });

  it("rejects an over-long note", () => {
    expect(
      stockInputSchema.safeParse({ ...base, note: "x".repeat(501) }).success,
    ).toBe(false);
  });
});
