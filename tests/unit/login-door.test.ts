import { describe, it, expect } from "vitest";

import {
  BOOT_LINES,
  charsShown,
  resolveInitialPhase,
} from "@/app/(public)/login/_components/door-logic";

describe("resolveInitialPhase", () => {
  it("opens on the landing placard for a bare /login (no query)", () => {
    expect(resolveInitialPhase({})).toBe("landing");
  });

  it("skips to sign-in when bounced with a callbackUrl", () => {
    expect(resolveInitialPhase({ callbackUrl: "/signs" })).toBe("signin");
    // even a root callbackUrl counts as a deep-link bounce
    expect(resolveInitialPhase({ callbackUrl: "/" })).toBe("signin");
  });

  it("skips to sign-in after a magic link is sent (?type=email)", () => {
    expect(resolveInitialPhase({ type: "email" })).toBe("signin");
  });

  it("skips to sign-in when an auth error is present", () => {
    expect(resolveInitialPhase({ error: "AccessDenied" })).toBe("signin");
  });

  it("treats an empty callbackUrl as no bounce (landing)", () => {
    expect(resolveInitialPhase({ callbackUrl: "" })).toBe("landing");
  });

  it("ignores an unrelated type value", () => {
    expect(resolveInitialPhase({ type: "oauth" })).toBe("landing");
  });
});

describe("charsShown", () => {
  const LEN = 100;
  const DUR = 1850;

  it("shows nothing at the start", () => {
    expect(charsShown(0, DUR, LEN)).toBe(0);
  });

  it("shows the full string once the duration elapses", () => {
    expect(charsShown(DUR, DUR, LEN)).toBe(LEN);
    expect(charsShown(DUR * 2, DUR, LEN)).toBe(LEN);
  });

  it("is linear at the midpoint", () => {
    expect(charsShown(DUR / 2, DUR, LEN)).toBe(50);
  });

  it("floors fractional progress", () => {
    // 1/3 of 100 chars = 33.33 → 33
    expect(charsShown(DUR / 3, DUR, LEN)).toBe(33);
  });

  it("clamps negative elapsed to 0", () => {
    expect(charsShown(-500, DUR, LEN)).toBe(0);
  });

  it("returns the full length for a non-positive duration", () => {
    expect(charsShown(0, 0, LEN)).toBe(LEN);
    expect(charsShown(10, -1, LEN)).toBe(LEN);
  });
});

describe("BOOT_LINES", () => {
  it("is the 7-line boot sequence, all non-empty", () => {
    expect(BOOT_LINES).toHaveLength(7);
    for (const line of BOOT_LINES) expect(line.trim().length).toBeGreaterThan(0);
  });
});
