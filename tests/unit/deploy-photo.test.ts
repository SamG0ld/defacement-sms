import { describe, it, expect } from "vitest";

import { signDeployPhotoSrc } from "@/lib/deploy/photo";

describe("signDeployPhotoSrc", () => {
  it("builds the auth-gated serving path for a sign id", () => {
    expect(signDeployPhotoSrc(123)).toBe("/api/native/photos/sign/123");
  });

  it("is a relative path (never a raw Blob URL)", () => {
    const src = signDeployPhotoSrc(1);
    expect(src.startsWith("/api/native/photos/sign/")).toBe(true);
    expect(src).not.toMatch(/^https?:/);
  });
});
