import { describe, it, expect } from "vitest";

import { countUnzonedSigns } from "@/app/(app)/deploy/_overview";

describe("countUnzonedSigns", () => {
  it("sums the _count of rows whose zoneId is null, across statuses", () => {
    const rows = [
      { zoneId: 1, _count: { _all: 5 } },
      { zoneId: null, _count: { _all: 3 } }, // e.g. status=pending
      { zoneId: null, _count: { _all: 2 } }, // e.g. status=deployed
      { zoneId: 2, _count: { _all: 4 } },
    ];
    expect(countUnzonedSigns(rows)).toBe(5);
  });

  it("returns 0 when every sign is zoned", () => {
    const rows = [
      { zoneId: 1, _count: { _all: 10 } },
      { zoneId: 2, _count: { _all: 7 } },
    ];
    expect(countUnzonedSigns(rows)).toBe(0);
  });

  it("returns 0 for no rows", () => {
    expect(countUnzonedSigns([])).toBe(0);
  });
});
