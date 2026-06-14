import { describe, it, expect, vi, afterEach } from "vitest";

import { logError } from "@/lib/log";

describe("logError", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits a single JSON line with scope, meta, and normalized error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = Object.assign(new Error("boom"), { code: "ECONNREFUSED" });

    logError("auth.jwt.db-unavailable", err, { phase: "refresh" });

    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({
      level: "error",
      scope: "auth.jwt.db-unavailable",
      phase: "refresh",
      err: { name: "Error", message: "boom", code: "ECONNREFUSED" },
    });
  });

  it("normalizes a non-Error throw to a message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("x", "just a string");
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.err.message).toBe("just a string");
  });

  it("lets fixed fields win over colliding meta keys", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("real-scope", new Error("e"), { scope: "fake", level: "info" });
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.scope).toBe("real-scope");
    expect(parsed.level).toBe("error");
  });

  it("never throws on an unserializable payload", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logError("x", new Error("e"), circular)).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });
});
