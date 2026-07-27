import { describe, it, expect } from "vitest";

import {
  classifyHttpStatus,
  isPermanentStatus,
} from "@/lib/offline/http-classification";

describe("classifyHttpStatus", () => {
  it.each([
    [401, "auth-expired"],
    [403, "forbidden"],
    [429, "rate-limited"],
    [400, "permanent"],
    [404, "permanent"],
    [422, "permanent"],
    [500, "transient"],
    [502, "transient"],
    [503, "transient"],
  ] as const)("classifies %i as %s", (status, category) => {
    expect(classifyHttpStatus(status)).toBe(category);
  });
});

describe("isPermanentStatus", () => {
  it("treats 4xx (except 401 and 429) as permanent — including 403", () => {
    expect(isPermanentStatus(400)).toBe(true);
    // A deactivated account (#79) must dead-letter, not retry forever.
    expect(isPermanentStatus(403)).toBe(true);
    expect(isPermanentStatus(404)).toBe(true);
    expect(isPermanentStatus(422)).toBe(true);
  });

  it("treats 401 (auth-expiry) and 429 (backpressure) as NOT permanent", () => {
    expect(isPermanentStatus(401)).toBe(false);
    expect(isPermanentStatus(429)).toBe(false);
  });

  it("treats 5xx as NOT permanent (retryable)", () => {
    expect(isPermanentStatus(500)).toBe(false);
    expect(isPermanentStatus(503)).toBe(false);
  });
});
