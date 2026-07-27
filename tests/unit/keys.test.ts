import { describe, it, expect } from "vitest";

import { isActivationKey } from "@/app/_components/keys";

// The a11y contract behind #180: an element carrying role="button" must activate
// on Enter AND Space, not just a pointer click.

describe("isActivationKey", () => {
  it("activates on Enter", () => {
    expect(isActivationKey("Enter")).toBe(true);
  });

  it("activates on Space", () => {
    expect(isActivationKey(" ")).toBe(true);
  });

  it("ignores keys that must keep their normal meaning", () => {
    for (const key of ["Tab", "Escape", "ArrowDown", "a", "Spacebar", ""]) {
      expect(isActivationKey(key)).toBe(false);
    }
  });
});
