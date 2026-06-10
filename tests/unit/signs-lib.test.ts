import { describe, it, expect } from "vitest";

import {
  buildSignWhere,
  deploymentSlotLabel,
  formatDate,
  formatDateOnly,
  formatDateTime,
  hardwareKind,
  needsHardware,
  pacificTodayUtc,
  safeColor,
  shortZoneLabel,
  stampsForStatus,
  statusBadgeClass,
} from "@/app/(app)/signs/_lib";

describe("shortZoneLabel", () => {
  it("renders home-building levels and halls short", () => {
    expect(shortZoneLabel({ zoneCode: "LVCC-L1", building: "LVCC West" })).toBe(
      "Level 1",
    );
    expect(shortZoneLabel({ zoneCode: "LVCC-H2", building: "LVCC West" })).toBe(
      "Hall 2",
    );
  });

  it("keeps the building prefix for off-site buildings", () => {
    expect(
      shortZoneLabel({ zoneCode: "CAESARS-L1", building: "Caesars" }),
    ).toBe("Caesars — Level 1");
  });

  it("falls back to the zone name for non-level/hall codes", () => {
    expect(
      shortZoneLabel({
        zoneCode: "LVCC-NH",
        zoneName: "North Hall",
        building: "LVCC North",
      }),
    ).toBe("North Hall");
  });

  it("handles null/undefined", () => {
    expect(shortZoneLabel(null)).toBe("—");
    expect(shortZoneLabel(undefined)).toBe("—");
  });
});

describe("safeColor", () => {
  it("passes a valid 6-digit hex", () => {
    expect(safeColor("#3366ff")).toBe("#3366ff");
    expect(safeColor("#ABCDEF")).toBe("#ABCDEF");
  });

  it("rejects anything else (CSS-injection guard)", () => {
    expect(safeColor("#abc")).toBe("#3f3f46");
    expect(safeColor("red; background:url(x)")).toBe("#3f3f46");
    expect(safeColor(null)).toBe("#3f3f46");
    expect(safeColor(undefined)).toBe("#3f3f46");
  });
});

describe("deploymentSlotLabel", () => {
  it("formats known slots", () => {
    expect(deploymentSlotLabel("TUES_AM")).toBe("Tue AM");
    expect(deploymentSlotLabel("FRI_PM")).toBe("Fri PM");
  });

  it("dashes empty, echoes unknown", () => {
    expect(deploymentSlotLabel(null)).toBe("—");
    expect(deploymentSlotLabel("")).toBe("—");
    expect(deploymentSlotLabel("WHENEVER")).toBe("WHENEVER");
  });
});

describe("buildSignWhere", () => {
  it("maps recognized filters", () => {
    const where = buildSignWhere({
      status: "pending",
      zone: "5",
      tag: "village",
      slot: "FRI_PM",
      type: "Banner",
    });
    expect(where.status).toBe("pending");
    expect(where.zoneId).toBe(5);
    expect(where.deploymentSlot).toBe("FRI_PM");
    expect(where.signType).toBe("Banner");
    expect(where.tagAssignments).toEqual({ some: { tag: { slug: "village" } } });
  });

  it("ignores invalid status and non-numeric zone", () => {
    const where = buildSignWhere({ status: "bogus", zone: "abc" });
    expect(where.status).toBeUndefined();
    expect(where.zoneId).toBeUndefined();
  });

  it("trims and caps the search term", () => {
    const trimmed = buildSignWhere({ q: "  foo  " });
    expect(trimmed.OR?.[0]).toMatchObject({
      signText: { contains: "foo", mode: "insensitive" },
    });

    const long = buildSignWhere({ q: "a".repeat(300) });
    const term = (long.OR?.[0] as { signText: { contains: string } }).signText
      .contains;
    expect(term).toHaveLength(200);
  });
});

describe("Vegas-time formatting", () => {
  // 2025-08-09T02:00:00Z == Aug 8 2025 19:00 PDT (UTC-7).
  const d = new Date("2025-08-09T02:00:00.000Z");

  it("formats a date in Pacific time", () => {
    expect(formatDate(d)).toBe("Aug 08, 2025");
    expect(formatDate(null)).toBe("—");
  });

  it("formatDateOnly renders a UTC-midnight @db.Date without an off-by-one", () => {
    expect(formatDateOnly(new Date("2025-08-06T00:00:00.000Z"))).toBe("Aug 06, 2025");
    expect(formatDateOnly(null)).toBe("—");
  });

  it("formats a datetime in Pacific time with a PT suffix", () => {
    expect(formatDateTime(d)).toMatch(/Aug 08, 2025.*19:00 PT/);
    expect(formatDateTime(null)).toBe("—");
  });
});

describe("stampsForStatus", () => {
  const now = new Date("2025-08-09T02:00:00.000Z");

  it("clears both stamps when moving to a pre-delivery status", () => {
    for (const s of ["pending", "generated", "printed"] as const) {
      expect(stampsForStatus(s, "me", now)).toEqual({
        deliveredAt: null,
        deliveredBy: null,
        deployedAt: null,
        deployedBy: null,
      });
    }
  });

  it("stamps delivered and clears the deploy stamp", () => {
    expect(stampsForStatus("delivered", "me", now)).toEqual({
      deliveredAt: now,
      deliveredBy: "me",
      deployedAt: null,
      deployedBy: null,
    });
  });

  it("stamps deployed and leaves the delivery stamp untouched (not in the patch)", () => {
    const patch = stampsForStatus("deployed", "me", now);
    expect(patch).toEqual({ deployedAt: now, deployedBy: "me" });
    // deliveredAt/By are absent so each row keeps its own value under updateMany.
    expect("deliveredAt" in patch).toBe(false);
    expect("deliveredBy" in patch).toBe(false);
  });

  it("moving to sorted preserves delivered (absent) and clears the deploy stamp", () => {
    const patch = stampsForStatus("sorted", "me", now);
    expect(patch).toEqual({ deployedAt: null, deployedBy: null });
    expect("deliveredAt" in patch).toBe(false); // a sorted sign was delivered
  });
});

describe("hardware derivation", () => {
  it("needsHardware: easel signs and meterboard-size signs", () => {
    expect(needsHardware({ needsEasel: true, size: "22x28" })).toBe(true);
    expect(needsHardware({ needsEasel: false, size: "Meterboard (4x8)" })).toBe(
      true,
    );
    expect(needsHardware({ needsEasel: false, size: "4x8" })).toBe(true);
  });

  it("needsHardware: false for non-easel, non-meterboard (incl. a 4x8 banner)", () => {
    expect(needsHardware({ needsEasel: false, size: "22x28" })).toBe(false);
    // "4x8 banner" classifies as banner, not meterboard (bucket priority).
    expect(needsHardware({ needsEasel: false, size: "4x8 banner" })).toBe(false);
  });

  it("hardwareKind: easel wins, else meterboard stand, else null", () => {
    expect(hardwareKind({ needsEasel: true, size: "4x8" })).toBe("easel");
    expect(hardwareKind({ needsEasel: false, size: "meterboard" })).toBe(
      "meterboard stand",
    );
    expect(hardwareKind({ needsEasel: false, size: "22x28" })).toBeNull();
  });
});

describe("buildSignWhere due filter", () => {
  it("sets due=today to an exact date and status != deployed (flat where)", () => {
    const where = buildSignWhere({ due: "today" });
    expect(where.status).toEqual({ not: "deployed" });
    expect(where.deployByDate).toBeInstanceOf(Date);
    expect(where.deployByDate).toEqual(pacificTodayUtc());
    expect(where.AND).toBeUndefined(); // no nested AND fragility
  });

  it("uses a less-than range for due=overdue", () => {
    const where = buildSignWhere({ due: "overdue" });
    const dbd = where.deployByDate as { lt: Date };
    expect(dbd.lt).toBeInstanceOf(Date);
    expect(dbd.lt).toEqual(pacificTodayUtc());
    expect(where.status).toEqual({ not: "deployed" });
  });

  it("due deliberately overrides an explicit status (dashboard never sets both)", () => {
    const where = buildSignWhere({ status: "deployed", due: "today" });
    expect(where.status).toEqual({ not: "deployed" });
  });

  it("leaves status untouched and unset deployByDate when due is absent", () => {
    const where = buildSignWhere({ status: "pending" });
    expect(where.status).toBe("pending");
    expect(where.deployByDate).toBeUndefined();
  });
});

describe("pacificTodayUtc", () => {
  it("returns a UTC-midnight instant", () => {
    const d = pacificTodayUtc();
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
    expect(d.getUTCMilliseconds()).toBe(0);
  });
});

describe("statusBadgeClass", () => {
  it("returns a distinct themed badge class per workflow stage", () => {
    expect(statusBadgeClass("pending")).toBe("badge-pending");
    expect(statusBadgeClass("generated")).toBe("badge-generated");
    expect(statusBadgeClass("printed")).toBe("badge-printed");
    expect(statusBadgeClass("delivered")).toBe("badge-delivered");
    expect(statusBadgeClass("sorted")).toBe("badge-sorted");
    expect(statusBadgeClass("deployed")).toBe("badge-deployed");
  });
});
