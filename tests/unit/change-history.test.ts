import { describe, it, expect } from "vitest";

import { changeSummary } from "@/lib/change-history";

// changeSummary is the single discriminator both change-history renderers branch
// on (global Activity feed + per-sign timeline). Locking it here guarantees a
// format row never falls through to the status-badge renderer, which would echo a
// format label as a bogus status with no crash.
describe("changeSummary", () => {
  it("marks a format row and surfaces its from/to labels", () => {
    const c = changeSummary({
      changeType: "format",
      oldStatus: "Foamcore 22×28",
      newStatus: "Meterboard 4'×8' Double",
    });
    expect(c.isFormat).toBe(true);
    expect(c.from).toBe("Foamcore 22×28");
    expect(c.to).toBe("Meterboard 4'×8' Double");
  });

  it("treats an explicit status row (and the default/legacy null) as NOT a format", () => {
    expect(
      changeSummary({ changeType: "status", oldStatus: "pending", newStatus: "printed" })
        .isFormat,
    ).toBe(false);
    // Legacy rows written before the column existed read back null → status.
    expect(
      changeSummary({ changeType: null, oldStatus: null, newStatus: "printed" }).isFormat,
    ).toBe(false);
    expect(
      changeSummary({ oldStatus: "pending", newStatus: "deployed" }).isFormat,
    ).toBe(false);
  });
});
