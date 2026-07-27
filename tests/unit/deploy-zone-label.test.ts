import { describe, it, expect } from "vitest";

import { zoneLabel } from "@/app/(app)/deploy/_lib/zone-label";

// #190: the floor tool used to render `Zone ${zoneId}` — the raw FK — because the
// wire projection only carried zoneId. Crews navigate by zone CODE ("LVCC-L1"),
// so the label has to show that. One shared implementation because SignList and
// FocusPane both render it and had drifted into two copies.
describe("zoneLabel (#190)", () => {
  it("shows the zone's code, never the internal id", () => {
    expect(zoneLabel({ zoneId: 14, zoneCode: "LVCC-L1" })).toBe("Zone LVCC-L1");
  });

  it("says Unzoned when the sign has no zone", () => {
    expect(zoneLabel({ zoneId: null, zoneCode: null })).toBe("Unzoned");
  });

  it("falls back to the id if a zoned sign somehow arrives without a code", () => {
    // Defensive only: zoneCode is selected through the zone relation, so a
    // non-null zoneId always resolves one. Better a number than a blank label.
    expect(zoneLabel({ zoneId: 14, zoneCode: null })).toBe("Zone 14");
  });

  it("ignores a stray code on an unzoned sign", () => {
    expect(zoneLabel({ zoneId: null, zoneCode: "LVCC-L1" })).toBe("Unzoned");
  });
});
