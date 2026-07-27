import { describe, expect, it } from "vitest";

import {
  ARCHIVED_REFUSAL_REASON,
  archivedRefusal,
  decideStatusChange,
  forwardSourceStatuses,
  isLeadOnlyStatusTarget,
} from "@/lib/sign-status-authz";
import { SIGN_STATUSES } from "@/app/(app)/signs/_lib";

// Order (rank): pending < generated < printed < delivered < sorted < deployed
// < handed_off < installed.

// The common case: an ordinary easel sign, which is NOT an external-installed
// item. External-only assertions pass `union_installed` explicitly.
const EASEL = "easel_sign" as const;

describe("decideStatusChange — leads/admins unrestricted", () => {
  for (const role of ["lead", "admin"] as const) {
    it(`${role}: backward move allowed`, () => {
      expect(
        decideStatusChange({
          role,
          currentStatus: "deployed",
          targetStatus: "sorted",
          actorHoldsClaim: false,
          category: EASEL,
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
          category: EASEL,
        }),
      ).toEqual({ ok: true });
    });
  }
});

describe("decideStatusChange — archived signs leave ONLY via Restore", () => {
  // `archived` isn't in SIGN_STATUSES (rank -1), so the backward-move guard can't
  // catch it — this explicit rule keeps every role (and the shared offline-sync
  // policy) from un-removing a sign through the generic status path.
  for (const role of ["volunteer", "lead", "admin"] as const) {
    it(`${role}: cannot move a sign out of archived (routed to Restore)`, () => {
      const d = decideStatusChange({
        role,
        currentStatus: "archived",
        targetStatus: "generated",
        actorHoldsClaim: true,
        category: EASEL,
      });
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.reason).toMatch(/restore/i);
    });
  }

  it("the archived rule still wins over the external-category rule", () => {
    // Both rules sit ahead of the privileged bypass; archived is checked first so
    // an archived external item is routed to Restore, not to the lifecycle panel.
    const d = decideStatusChange({
      role: "admin",
      currentStatus: "archived",
      targetStatus: "installed",
      actorHoldsClaim: false,
      category: "union_installed",
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/restore/i);
  });
});

// #232: handed_off / installed are the EXTERNAL-item terminal statuses. They were
// reachable on any sign class via the generic status dropdown, which stamped
// handedOffAt/installedAt while the structured lifecycle fields stayed null and
// LifecyclePanel never rendered (no route back through the dedicated UI).
describe("decideStatusChange — handed_off/installed require an external category", () => {
  for (const role of ["volunteer", "lead", "admin"] as const) {
    for (const target of ["handed_off", "installed"] as const) {
      for (const category of ["easel_sign", "meterboard", "socks", "other"] as const) {
        it(`${role}: denies ${target} on a ${category} sign`, () => {
          const d = decideStatusChange({
            role,
            currentStatus: "delivered",
            targetStatus: target,
            actorHoldsClaim: true,
            category,
          });
          expect(d.ok).toBe(false);
          if (!d.ok) expect(d.reason).toMatch(/external/i);
        });
      }

      for (const category of ["union_installed", "ops_map"] as const) {
        it(`lead: allows ${target} on a ${category} sign`, () => {
          expect(
            decideStatusChange({
              role: "lead",
              currentStatus: "delivered",
              targetStatus: target,
              actorHoldsClaim: false,
              category,
            }),
          ).toEqual({ ok: true });
        });
      }
    }
  }

  it("still allows moving a mis-set non-external sign BACK down (recovery path)", () => {
    // Only the two targets are gated, so a sign already parked in `installed` by
    // the pre-fix behaviour can still be walked back to a sane status.
    expect(
      decideStatusChange({
        role: "lead",
        currentStatus: "installed",
        targetStatus: "deployed",
        actorHoldsClaim: false,
        category: EASEL,
      }),
    ).toEqual({ ok: true });
  });
});

describe("decideStatusChange — volunteers", () => {
  it("allows a forward prep transition on an unclaimed sign (printed → sorted)", () => {
    expect(
      decideStatusChange({
        role: "volunteer",
        currentStatus: "printed",
        targetStatus: "sorted",
        actorHoldsClaim: false,
        category: EASEL,
      }),
    ).toEqual({ ok: true });
  });

  it("denies any backward move (deployed → sorted)", () => {
    const d = decideStatusChange({
      role: "volunteer",
      currentStatus: "deployed",
      targetStatus: "sorted",
      actorHoldsClaim: false,
      category: EASEL,
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
      category: EASEL,
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
        category: EASEL,
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
      category: EASEL,
    });
    expect(d.ok).toBe(false);
  });

  for (const target of ["handed_off", "installed"] as const) {
    it(`denies a volunteer setting ${target} via the generic path (lead/admin only), even forward`, () => {
      // An EXTERNAL item, so the category rule can't be what refuses this — the
      // lead-only-target rule is the one under test.
      const d = decideStatusChange({
        role: "volunteer",
        currentStatus: "sorted",
        targetStatus: target,
        actorHoldsClaim: true, // a claim doesn't help — these are lead-only
        category: "union_installed",
      });
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.reason).toMatch(/lead or admin/i);
    });
  }
});

// #269: the archived clause is shared with the lifecycle actions, which are
// exempt from the REST of decideStatusChange, so it has to hold on its own — and
// the two paths must never drift apart in wording. (applyDeploys is the other
// exempt path and is still unguarded — that's #268, not yet landed.)
describe("archivedRefusal", () => {
  it("refuses `archived` with the shared reason", () => {
    expect(archivedRefusal("archived")).toEqual({
      ok: false,
      reason: ARCHIVED_REFUSAL_REASON,
    });
  });

  it("returns null for every ranked workflow status", () => {
    for (const s of SIGN_STATUSES) expect(archivedRefusal(s)).toBeNull();
  });

  it("is the same refusal decideStatusChange gives, so the paths can't drift", () => {
    const viaPolicy = decideStatusChange({
      role: "admin",
      currentStatus: "archived",
      targetStatus: "generated",
      actorHoldsClaim: true,
      category: EASEL,
    });
    expect(viaPolicy).toEqual(archivedRefusal("archived"));
  });
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

  // #199: this helper is a rank-only DB PREFILTER, never an authorization answer.
  // These pin the contract so a future caller can't mistake one for the other.
  it("never yields `archived` (it is not in the ranked workflow)", () => {
    for (const target of SIGN_STATUSES) {
      expect(forwardSourceStatuses(target)).not.toContain("archived");
    }
  });

  it("is NOT authorization-sufficient: its sources pass the rank gate but decideStatusChange still refuses", () => {
    // A volunteer + a lead-only target: every source status the prefilter offers
    // is rank-legal, yet the policy denies all of them. A bulk path that trusted
    // this helper alone would let a volunteer mass-set handed_off.
    for (const source of forwardSourceStatuses("handed_off")) {
      const d = decideStatusChange({
        role: "volunteer",
        currentStatus: source,
        targetStatus: "handed_off",
        actorHoldsClaim: true,
        category: "union_installed",
      });
      expect(d.ok).toBe(false);
    }

    // Same for the deployed-needs-a-claim rule.
    for (const source of forwardSourceStatuses("deployed")) {
      const d = decideStatusChange({
        role: "volunteer",
        currentStatus: source,
        targetStatus: "deployed",
        actorHoldsClaim: false,
        category: EASEL,
      });
      expect(d.ok).toBe(false);
    }
  });
});
