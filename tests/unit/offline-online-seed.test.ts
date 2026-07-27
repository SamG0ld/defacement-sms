import { afterEach, describe, it, expect, vi } from "vitest";

import { isOnlineNow, subscribeOnline } from "@/lib/offline/online";

afterEach(() => vi.unstubAllGlobals());

describe("isOnlineNow", () => {
  it("assumes online when there is no navigator at all", () => {
    vi.stubGlobal("navigator", undefined);
    expect(isOnlineNow()).toBe(true);
  });

  it("assumes online when navigator exists but has no onLine (Node 22+ SSR)", () => {
    // Regression guard for issue #150. Node 22+ ships a global `navigator` that
    // carries only userAgent, so a bare `typeof navigator === "undefined"` server
    // check falls through and reads `undefined` — which is falsy, so SSR rendered
    // the OFFLINE branch and then mismatched the browser's real "online" during
    // hydration (React #418).
    vi.stubGlobal("navigator", { userAgent: "Node.js" });
    expect(isOnlineNow()).toBe(true);
  });

  it("reports the browser's real value when onLine is present", () => {
    vi.stubGlobal("navigator", { onLine: true });
    expect(isOnlineNow()).toBe(true);
    vi.stubGlobal("navigator", { onLine: false });
    expect(isOnlineNow()).toBe(false);
  });

  it("ignores a non-boolean onLine rather than trusting it", () => {
    vi.stubGlobal("navigator", { onLine: "yes" });
    expect(isOnlineNow()).toBe(true);
  });
});

describe("subscribeOnline", () => {
  function fakeWindow() {
    const listeners: Record<string, Set<() => void>> = {};
    return {
      listeners,
      addEventListener: (type: string, cb: () => void) => {
        (listeners[type] ??= new Set()).add(cb);
      },
      removeEventListener: (type: string, cb: () => void) => {
        listeners[type]?.delete(cb);
      },
    };
  }

  it("listens on both transitions and unsubscribes cleanly", () => {
    const win = fakeWindow();
    vi.stubGlobal("window", win);
    const onChange = () => {};

    const unsubscribe = subscribeOnline(onChange);
    expect(win.listeners.online?.has(onChange)).toBe(true);
    expect(win.listeners.offline?.has(onChange)).toBe(true);

    // A leaked listener would keep re-rendering an unmounted tree.
    unsubscribe();
    expect(win.listeners.online?.size).toBe(0);
    expect(win.listeners.offline?.size).toBe(0);
  });
});
