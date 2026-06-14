import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { isTransientDbError, withDbRetry } from "@/lib/db-retry";

describe("isTransientDbError", () => {
  it("flags the pg connection-exception family (08xxx)", () => {
    expect(isTransientDbError({ code: "08006" })).toBe(true); // connection_failure
    expect(isTransientDbError({ code: "08001" })).toBe(true); // unable_to_connect
  });

  it("flags admin shutdown (57P01)", () => {
    expect(isTransientDbError({ code: "57P01" })).toBe(true);
  });

  it("flags socket errnos", () => {
    expect(isTransientDbError({ code: "ECONNREFUSED" })).toBe(true);
    expect(isTransientDbError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isTransientDbError({ code: "ECONNRESET" })).toBe(true);
  });

  it("flags PrismaClientInitializationError via .errorCode (P1001/P1008/P1017)", () => {
    expect(isTransientDbError({ errorCode: "P1001" })).toBe(true); // unreachable
    expect(isTransientDbError({ errorCode: "P1008" })).toBe(true); // timed out
    expect(isTransientDbError({ errorCode: "P1017" })).toBe(true); // server closed
  });

  it("flags a Prisma P-code carried on .code", () => {
    expect(isTransientDbError({ code: "P1001" })).toBe(true);
  });

  it("flags the node-postgres pool connect-timeout message (no code)", () => {
    expect(
      isTransientDbError(new Error("timeout exceeded when trying to connect")),
    ).toBe(true);
    expect(
      isTransientDbError(new Error("Can't reach database server at host:5432")),
    ).toBe(true);
  });

  it("does NOT flag an authoritative query/constraint error", () => {
    expect(isTransientDbError({ code: "23505" })).toBe(false); // unique_violation
    expect(isTransientDbError(new Error("Unknown argument `foo`"))).toBe(false);
  });

  it("does NOT flag P1000 (auth failure — authoritative, not transient)", () => {
    expect(
      isTransientDbError(
        Object.assign(new Error("Authentication failed"), { errorCode: "P1000" }),
      ),
    ).toBe(false);
  });

  it("ignores a matching message when a non-transient code IS present", () => {
    // A real constraint error whose message happens to contain a connection
    // phrase must NOT be retried/soft-passed.
    expect(
      isTransientDbError(
        Object.assign(new Error("Can't reach database server"), { code: "23505" }),
      ),
    ).toBe(false);
  });

  it("does NOT flag null / non-objects", () => {
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
    expect(isTransientDbError("ECONNREFUSED")).toBe(false);
  });
});

describe("withDbRetry", () => {
  beforeEach(() => {
    // withDbRetry logs each retry; keep test output clean.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns the value when the op succeeds on the first try", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withDbRetry(fn, { backoffMs: 0 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries once on a transient error, then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ code: "ECONNREFUSED" })
      .mockResolvedValue("recovered");
    await expect(withDbRetry(fn, { backoffMs: 0 })).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("rethrows immediately on a non-transient error (no retry)", async () => {
    const fn = vi.fn().mockRejectedValue({ code: "23505" });
    await expect(withDbRetry(fn, { backoffMs: 0 })).rejects.toMatchObject({
      code: "23505",
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget on a sustained transient outage", async () => {
    const fn = vi.fn().mockRejectedValue({ code: "ETIMEDOUT" });
    await expect(
      withDbRetry(fn, { retries: 1, backoffMs: 0 }),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(fn).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
  });

  it("honors a custom retry count", async () => {
    const fn = vi.fn().mockRejectedValue({ code: "ECONNRESET" });
    await expect(
      withDbRetry(fn, { retries: 3, backoffMs: 0 }),
    ).rejects.toBeTruthy();
    expect(fn).toHaveBeenCalledTimes(4); // 1 + 3
  });
});
