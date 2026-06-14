import { describe, expect, it } from "vitest";

import { formatLocation, formatUserAgent } from "@/lib/request-context";

describe("formatUserAgent", () => {
  it("formats desktop Chrome on macOS", () => {
    expect(
      formatUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      ),
    ).toBe("Chrome / macOS");
  });

  it("detects iOS Safari (iPhone beats the 'Mac OS X' token)", () => {
    expect(
      formatUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari / iOS");
  });

  it("detects Android Chrome (Android beats the 'Linux' token)", () => {
    expect(
      formatUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
      ),
    ).toBe("Chrome / Android");
  });

  it("detects Edge ahead of Chrome", () => {
    expect(
      formatUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0",
      ),
    ).toBe("Edge / Windows");
  });

  it("detects Firefox on Windows", () => {
    expect(
      formatUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
      ),
    ).toBe("Firefox / Windows");
  });

  it("returns null for empty input", () => {
    expect(formatUserAgent(null)).toBeNull();
    expect(formatUserAgent(undefined)).toBeNull();
    expect(formatUserAgent("")).toBeNull();
  });

  it("falls back to a truncated raw string for an unrecognized UA", () => {
    const out = formatUserAgent("z".repeat(200));
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(81); // 80 chars + ellipsis
    expect(out!.endsWith("…")).toBe(true);
  });
});

describe("formatLocation", () => {
  it("joins city + country", () => {
    expect(formatLocation("Las Vegas", "US")).toBe("Las Vegas, US");
  });

  it("falls back to country only", () => {
    expect(formatLocation(null, "US")).toBe("US");
    expect(formatLocation("   ", "US")).toBe("US");
  });

  it("falls back to city only", () => {
    expect(formatLocation("Reno", null)).toBe("Reno");
  });

  it("returns null when both are empty", () => {
    expect(formatLocation(null, null)).toBeNull();
    expect(formatLocation("", "   ")).toBeNull();
  });
});
