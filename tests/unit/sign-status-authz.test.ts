import { describe, expect, it } from "vitest";

import {
  decideStatusChange,
  forwardSourceStatuses,
  isLeadOnlyStatusTarget,
} from "@/lib/sign-status-authz";

// Order (rank): pending < generated < printed < delivered < sorted < deployed
// < handed_off < installed.

describe("decideStatusChange — leads/admins unrestricted", () => {
  for (const role of ["lead", "admin"] as const) {
    it(`${role}: backward move allowed`, () => {
      expect(
        decideStatusChange({
          role,
          currentStatus: "deployed",
          targetStatus: "sorted",
          actorHoldsClaim: false,
        }),
      ).toEqual({ ok: true });
    });

    it(`${role}: mark deployed without a claim allowed`, () => {
      expect(
        decideStatusChange({
          role,
          currentStatus: "sorted",
          targetStatus: "deployed",
          actorHoldsClaim: false,
        }),
      ).toEqual({ ok: true });
    });
  }
});

describe("decideStatusChange — volunteers", () => {
  it("allows a forward prep transition on an unclaimed sign (printed → sorted)", () => {
    expect(
      decideStatusChange({
        role: "volunteer",
        currentStatus: "printed",
        targetStatus: "sorted",
        actorHoldsClaim: false,
      }),
    ).toEqual({ ok: true });
  });

  it("denies any backward move (deployed → sorted)", () => {
    const d = decideStatusChange({
      role: "volunteer",
      currentStatus: "deployed",
      targetStatus: "sorted",
      actorHoldsClaim: false,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/backward/i);
  });

  it("denies marking deployed without the crew's claim", () => {
    const d = decideStatusChange({
      role: "volunteer",
      currentStatus: "sorted",
      targetStatus: "deployed",
      actorHoldsClaim: false,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/claim/i);
  });

  it("allows marking deployed when the crew holds the claim", () => {
    expect(
      decideStatusChange({
        role: "volunteer",
        currentStatus: "sorted",
        targetStatus: "deployed",
        actorHoldsClaim: true,
      }),
    ).toEqual({ ok: true });
  });

  it("backward takes precedence over the deployed-claim rule (sorted target from deployed)", () => {
    // A volunteer trying deployed → sorted is a regression regardless of claim.
    const d = decideStatusChange({
      role: "volunteer",
      currentStatus: "deployed",
      targetStatus: "sorted",
      actorHoldsClaim: true,
    });
    expect(d.ok).toBe(false);
  });

  for (const target of ["handed_off", "installed"] as const) {
    it(`denies a volunteer setting ${target} via the generic path (lead/admin only), even forward`, () => {
      const d = decideStatusChange({
        role: "volunteer",
        currentStatus: "sorted",
        targetStatus: target,
        actorHoldsClaim: true, // a claim doesn't help — these are lead-only
      });
      expect(d.ok).toBe(false);
    });
  }
});

describe("isLeadOnlyStatusTarget", () => {
  it("is true only for the external terminal statuses", () => {
    expect(isLeadOnlyStatusTarget("handed_off")).toBe(true);
    expect(isLeadOnlyStatusTarget("installed")).toBe(true);
    expect(isLeadOnlyStatusTarget("deployed")).toBe(false);
    expect(isLeadOnlyStatusTarget("sorted")).toBe(false);
  });
});

describe("forwardSourceStatuses", () => {
  it("returns only strictly-lower-rank statuses for the target", () => {
    expect(forwardSourceStatuses("deployed")).toEqual([
      "pending",
      "generated",
      "printed",
      "delivered",
      "sorted",
    ]);
  });

  it("is empty for the lowest-rank target (pending)", () => {
    expect(forwardSourceStatuses("pending")).toEqual([]);
  });
});
