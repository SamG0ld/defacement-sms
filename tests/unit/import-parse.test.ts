import { describe, it, expect } from "vitest";

import {
  deployHeaderDate,
  findHeaderRow,
  hallZoneCode,
  levelToZoneCode,
  northHallZoneCode,
  parseDeployMatrix,
  parseEventWindow,
  slotFromDeployHeader,
} from "@/app/(app)/signs/import/_parse";

describe("slotFromDeployHeader", () => {
  it("parses the DC33 deploy-by header variants", () => {
    expect(slotFromDeployHeader("DEPLOY BY TUES AM (8/5)")).toBe("TUES_AM");
    expect(slotFromDeployHeader("DEPLOY BY WEDS AM (8/6)")).toBe("WED_AM");
    expect(slotFromDeployHeader("DEPLOY BY THURSD PM (8/7)")).toBe("THU_PM");
    expect(slotFromDeployHeader("DEPLOY FRI (8/8) 6pm")).toBe("FRI_PM");
    expect(slotFromDeployHeader("DEPLOY SAT (8/9) AM")).toBe("SAT_AM");
    expect(slotFromDeployHeader("DEPLOY SUN (8/10) 6pm")).toBe("SUN_PM");
  });

  it("returns null for non-slot headers", () => {
    expect(slotFromDeployHeader("Sign Text")).toBeNull();
    expect(slotFromDeployHeader("DEPLOY BY MON")).toBeNull(); // no AM/PM
  });
});

describe("parseDeployMatrix", () => {
  it("maps deploy columns to {index, slot}", () => {
    const header = [
      "Map#",
      "Sign Text",
      "DEPLOY BY TUES AM (8/5)",
      "DEPLOY FRI (8/8) 6pm",
      "Notes",
    ];
    expect(parseDeployMatrix(header)).toEqual([
      { index: 2, slot: "TUES_AM" },
      { index: 3, slot: "FRI_PM" },
    ]);
  });
});

describe("deployHeaderDate", () => {
  it("extracts the (M/D) date from a deploy-by header as a UTC-midnight date", () => {
    expect(deployHeaderDate("DEPLOY BY WEDS AM (8/6)", 2025)?.toISOString()).toBe(
      "2025-08-06T00:00:00.000Z",
    );
    expect(deployHeaderDate("DEPLOY FRI (8/8) 6pm", 2025)?.toISOString()).toBe(
      "2025-08-08T00:00:00.000Z",
    );
  });

  it("returns null when no date is present", () => {
    expect(deployHeaderDate("Sign Text", 2025)).toBeNull();
  });
});

describe("parseEventWindow", () => {
  it("parses a full window into Vegas-local instants (PDT, UTC-7)", () => {
    const { eventStart, eventEnd } = parseEventWindow(
      "Friday (8/8) 19:00:00 - Friday (8/8) 21:00:00",
      2025,
    );
    expect(eventStart?.toISOString()).toBe("2025-08-09T02:00:00.000Z");
    expect(eventEnd?.toISOString()).toBe("2025-08-09T04:00:00.000Z");
  });

  it("uses one date with two times", () => {
    const { eventStart, eventEnd } = parseEventWindow(
      "Friday (8/8) 19:00 - 21:00",
      2025,
    );
    expect(eventStart?.toISOString()).toBe("2025-08-09T02:00:00.000Z");
    expect(eventEnd?.toISOString()).toBe("2025-08-09T04:00:00.000Z");
  });

  it("uses only the first window (before a ';')", () => {
    const { eventStart } = parseEventWindow(
      "Friday (8/8) 19:00 - 21:00; Saturday (8/9) 10:00 - 12:00",
      2025,
    );
    expect(eventStart?.toISOString()).toBe("2025-08-09T02:00:00.000Z");
  });

  it("guards out-of-range and missing values", () => {
    expect(parseEventWindow("(13/40) 25:99", 2025)).toEqual({
      eventStart: null,
      eventEnd: null,
    });
    expect(parseEventWindow("just a note", 2025)).toEqual({
      eventStart: null,
      eventEnd: null,
    });
    expect(parseEventWindow(null, 2025)).toEqual({
      eventStart: null,
      eventEnd: null,
    });
  });
});

describe("findHeaderRow", () => {
  it("finds the row containing all required cells", () => {
    const rows = [
      ["meta", "stuff"],
      ["Map#", "Sign Text", "Notes"],
      ["1", "A", ""],
    ];
    expect(findHeaderRow(rows, ["sign text", "map#"])).toBe(1);
    expect(findHeaderRow(rows, ["name", "department"])).toBe(-1);
  });
});

describe("hallZoneCode", () => {
  it("maps Hall and HW references to hall zones", () => {
    expect(hallZoneCode("Hall 1")).toBe("LVCC-H1");
    expect(hallZoneCode("L1 - HW4 - C107")).toBe("LVCC-H4");
  });

  it("ignores room codes and out-of-range halls", () => {
    expect(hallZoneCode("W104")).toBeNull();
    expect(hallZoneCode("Hall 5")).toBeNull();
  });
});

describe("levelToZoneCode", () => {
  it("maps level/floor text to level zones", () => {
    expect(levelToZoneCode("Level 2")).toBe("LVCC-L2");
    expect(levelToZoneCode("L1 - HW4")).toBe("LVCC-L1");
    expect(levelToZoneCode("First Floor")).toBe("LVCC-L1");
  });

  it("returns null for a bare hall reference", () => {
    expect(levelToZoneCode("Hall 1")).toBeNull();
  });
});

describe("northHallZoneCode", () => {
  it("detects North Hall / Diamond / N2xx rooms", () => {
    expect(northHallZoneCode("LVCC North Hall, DIAMOND")).toBe("LVCC-NH");
    expect(northHallZoneCode("Diamond 3 & 4")).toBe("LVCC-NH");
    expect(northHallZoneCode("L2 - N260")).toBe("LVCC-NH");
  });

  it("does not over-match", () => {
    expect(northHallZoneCode("W104")).toBeNull();
    expect(northHallZoneCode("N150")).toBeNull(); // not in N2xx range
    expect(northHallZoneCode("N360")).toBeNull();
    expect(northHallZoneCode("diamondback village")).toBeNull(); // \bdiamond\b
    expect(northHallZoneCode("Level 2")).toBeNull();
  });
});
