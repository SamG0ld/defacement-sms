import { describe, expect, it } from "vitest";

import { SIGN_STATUSES } from "@/app/(app)/signs/_lib";
import {
  setSignStatusSchema,
  signStatuses,
} from "@/lib/deploy/contract";
import { classifySetStatus } from "@/lib/deploy/resolve";

// The contract duplicates the status list (it must stay zod-only + iOS-shareable,
// and lib/ can't import from app/(app)/signs/_lib). This guard locks the two
// together so they can never silently drift.
describe("sign-status contract ↔ SIGN_STATUSES drift guard", () => {
  it("contract.signStatuses equals SIGN_STATUSES exactly (same order)", () => {
    expect([...signStatuses]).toEqual([...SIGN_STATUSES]);
  });

  // A realistic "this already happened" instant — recent, not a future event
  // date (which the changedAt range guard rejects; see the dedicated test below).
  const recentIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  it("the request schema accepts every real status and rejects an unknown one", () => {
    for (const s of SIGN_STATUSES) {
      const parsed = setSignStatusSchema.safeParse({
        clientId: "client-uuid-1234",
        signId: 1,
        status: s,
        changedAt: recentIso,
      });
      expect(parsed.success).toBe(true);
    }
    const bad = setSignStatusSchema.safeParse({
      clientId: "client-uuid-1234",
      signId: 1,
      status: "teleported",
      changedAt: recentIso,
    });
    expect(bad.success).toBe(false);
  });

  it("coerces changedAt from an ISO string and bounds notes at 2000 chars", () => {
    const ok = setSignStatusSchema.safeParse({
      clientId: "client-uuid-1234",
      signId: 1,
      status: "deployed",
      changedAt: recentIso,
      notes: "x".repeat(2000),
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.changedAt).toBeInstanceOf(Date);

    const tooLong = setSignStatusSchema.safeParse({
      clientId: "client-uuid-1234",
      signId: 1,
      status: "deployed",
      changedAt: recentIso,
      notes: "x".repeat(2001),
    });
    expect(tooLong.success).toBe(false);
  });

  it("rejects an absurd changedAt (timeline-poisoning guard) but accepts offline skew", () => {
    const base = {
      clientId: "client-uuid-1234",
      signId: 1,
      status: "deployed" as const,
    };
    // Year 275760 — a hostile/clock-broken client; must be rejected.
    expect(
      setSignStatusSchema.safeParse({ ...base, changedAt: "+275760-09-13" })
        .success,
    ).toBe(false);
    // A pre-project floor value — rejected.
    expect(
      setSignStatusSchema.safeParse({ ...base, changedAt: "2000-01-01T00:00:00.000Z" })
        .success,
    ).toBe(false);
    // A plausibly-skewed recent offline instant — accepted.
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(
      setSignStatusSchema.safeParse({ ...base, changedAt: recent }).success,
    ).toBe(true);
  });

  it("rejects a too-short clientId (the idempotency key)", () => {
    const parsed = setSignStatusSchema.safeParse({
      clientId: "short",
      signId: 1,
      status: "deployed",
      changedAt: "2026-08-07T18:00:00.000Z",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("classifySetStatus — outcome precedence", () => {
  it("an already-processed clientId is a duplicate, whatever the sign state", () => {
    expect(
      classifySetStatus({
        alreadyProcessed: true,
        currentStatus: "sorted",
        targetStatus: "deployed",
      }),
    ).toBe("duplicate");
    // Duplicate wins even if the sign is now gone.
    expect(
      classifySetStatus({
        alreadyProcessed: true,
        currentStatus: undefined,
        targetStatus: "deployed",
      }),
    ).toBe("duplicate");
  });

  it("a missing sign (not already processed) is not_found", () => {
    expect(
      classifySetStatus({
        alreadyProcessed: false,
        currentStatus: undefined,
        targetStatus: "deployed",
      }),
    ).toBe("not_found");
  });

  it("an unchanged status is a noop", () => {
    expect(
      classifySetStatus({
        alreadyProcessed: false,
        currentStatus: "deployed",
        targetStatus: "deployed",
      }),
    ).toBe("noop");
  });

  it("a real change applies", () => {
    expect(
      classifySetStatus({
        alreadyProcessed: false,
        currentStatus: "sorted",
        targetStatus: "deployed",
      }),
    ).toBe("applied");
  });
});
