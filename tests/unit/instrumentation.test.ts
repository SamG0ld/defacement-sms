import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// lib/env.ts's assertProdEnv() is thoroughly unit-tested, but nothing tested
// instrumentation.ts's register() — the thing that's supposed to turn a failed
// check into "this deploy does not serve traffic". These lock the half we own:
// register() must AWAIT assertProdEnv() and let its throw propagate, never
// swallow or merely log it. Whether Next.js then refuses to serve is the
// runtime's own contract, which these tests deliberately do not assert.
//
// vi.doMock (not vi.mock) + resetModules per test: the mocked sentry configs
// record load ORDER, and a hoisted factory would only ever run once for the
// whole file.

const ORIGINAL_RUNTIME = process.env.NEXT_RUNTIME;

type Harness = {
  register: () => Promise<void>;
  order: string[];
  assertProdEnv: ReturnType<typeof vi.fn>;
};

// Build a fresh instrumentation.ts with stubbed Sentry configs and a stubbed
// assertProdEnv, recording the order in which register() reaches each one.
async function loadHarness(
  assertImpl: () => void = () => {},
): Promise<Harness> {
  vi.resetModules();
  const order: string[] = [];
  const assertProdEnv = vi.fn(() => {
    order.push("assert");
    assertImpl();
  });

  vi.doMock("../../sentry.server.config", () => {
    order.push("sentry:node");
    return {};
  });
  vi.doMock("../../sentry.edge.config", () => {
    order.push("sentry:edge");
    return {};
  });
  vi.doMock("../../lib/env", () => ({ assertProdEnv }));

  const mod = await import("../../instrumentation");
  return { register: mod.register, order, assertProdEnv };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("../../sentry.server.config");
  vi.doUnmock("../../sentry.edge.config");
  vi.doUnmock("../../lib/env");
  vi.resetModules();
  if (ORIGINAL_RUNTIME === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = ORIGINAL_RUNTIME;
});

describe("instrumentation register() — fail-fast propagation", () => {
  it("resolves when the production env check passes", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const { register, assertProdEnv } = await loadHarness();
    await expect(register()).resolves.toBeUndefined();
    expect(assertProdEnv).toHaveBeenCalledOnce();
  });

  // The load-bearing assertion. If register() ever caught this — or forgot to
  // await it — a deploy with a weak AUTH_SECRET or missing Upstash would boot
  // and serve traffic with exactly the protections assertProdEnv exists to
  // guarantee silently absent.
  it("REJECTS when assertProdEnv throws (never swallows it)", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const { register } = await loadHarness(() => {
      throw new Error(
        "Missing required production environment variables: AUTH_SECRET",
      );
    });
    await expect(register()).rejects.toThrow(/AUTH_SECRET/);
  });

  it("surfaces the original error, not a generic wrapper", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const boom = new Error("AUTH_SECRET is too weak for production");
    const { register } = await loadHarness(() => {
      throw boom;
    });
    await expect(register()).rejects.toBe(boom);
  });

  it("runs the env check on the edge runtime too", async () => {
    process.env.NEXT_RUNTIME = "edge";
    const { register, order } = await loadHarness(() => {
      throw new Error("edge boom");
    });
    await expect(register()).rejects.toThrow(/edge boom/);
    expect(order).toEqual(["sentry:edge", "assert"]);
  });

  // instrumentation.ts states the intent explicitly: "Sentry is initialized
  // first so a fail-fast startup throw is captured." Reversing that order would
  // make the very failure this mechanism exists to surface invisible.
  it("initializes Sentry BEFORE the env check, so the startup throw is captured", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const { register, order } = await loadHarness(() => {
      throw new Error("boom");
    });
    await expect(register()).rejects.toThrow();
    expect(order).toEqual(["sentry:node", "assert"]);
  });

  it("still runs the env check when NEXT_RUNTIME is unset (no Sentry init path)", async () => {
    delete process.env.NEXT_RUNTIME;
    const { register, order } = await loadHarness(() => {
      throw new Error("boom");
    });
    await expect(register()).rejects.toThrow(/boom/);
    expect(order).toEqual(["assert"]);
  });
});
