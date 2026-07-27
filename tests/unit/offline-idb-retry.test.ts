import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";

import {
  isStaleConnectionError,
  putEntry as putDeployEntry,
  allEntries as allDeployEntries,
} from "@/app/(app)/deploy/_lib/idb";
import {
  isStaleConnectionError as isStaleSigns,
  putEntry as putStatusEntry,
  allEntries as allStatusEntries,
} from "@/app/(app)/signs/_sync/idb";
import type { OutboxEntry } from "@/app/(app)/deploy/_lib/types";
import type { StatusOutboxEntry } from "@/app/(app)/signs/_sync/types";

// iOS Safari can close an idle IndexedDB connection out from under the app — the
// documented reason the singleton-close handling exists at all. It doesn't always
// fail loudly at transaction() time: a connection being torn down can ACCEPT the
// call and then abort asynchronously. tx() only ever caught the synchronous
// throw, so the async abort surfaced to the user as "Couldn't save…" and dropped
// an offline claim/deploy/status the volunteer believed was queued — on exactly
// the device and moment the whole engine exists for. (#205)
//
// This wraps a real fake-indexeddb factory so the FIRST transaction on a fresh
// connection fails the chosen way and everything after it behaves normally.
type FailMode = "sync-throw" | "async-abort";

function staleOnce(mode: FailMode): IDBFactory {
  const real = new IDBFactory();
  let tripped = false;

  const wrapDb = (db: IDBDatabase): IDBDatabase =>
    new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction" && !tripped) {
          return (...args: unknown[]) => {
            tripped = true;
            if (mode === "sync-throw") {
              throw new DOMException("connection closed", "InvalidStateError");
            }
            const t = (
              target.transaction as unknown as (
                ...a: unknown[]
              ) => IDBTransaction
            ).apply(target, args);
            // Abort after the caller has wired its handlers — the async path.
            queueMicrotask(() => {
              try {
                t.abort();
              } catch {
                /* already settled */
              }
            });
            return t;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "open") {
        return (...args: unknown[]) => {
          const req = (
            target.open as unknown as (...a: unknown[]) => IDBOpenDBRequest
          ).apply(target, args);
          return new Proxy(req, {
            get(r, p, rec) {
              if (p === "result") return wrapDb(r.result);
              const v = Reflect.get(r, p, rec);
              return typeof v === "function" ? v.bind(r) : v;
            },
            set(r, p, v) {
              // Handlers are assigned by the module; forward them through.
              Reflect.set(r, p, v);
              return true;
            },
          });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as IDBFactory;
}

const deployEntry: OutboxEntry = {
  clientId: "c1",
  kind: "claim",
  payload: { crewId: 1, signIds: [1] },
  status: "pending",
  attempts: 0,
  createdAt: 100,
};

const statusEntry: StatusOutboxEntry = {
  clientId: "s1",
  signId: 1,
  status: "deployed",
  changedAt: "2026-08-07T18:00:00.000Z",
  queueStatus: "pending",
  attempts: 0,
  createdAt: 100,
};

beforeEach(() => {
  // A changed factory forces both modules to drop their cached connection.
  globalThis.indexedDB = new IDBFactory();
});

describe("isStaleConnectionError — connection state vs. real data errors (#205)", () => {
  it.each(["InvalidStateError", "TransactionInactiveError", "AbortError"])(
    "treats %s as a stale connection worth one retry",
    (name) => {
      expect(isStaleConnectionError(new DOMException("x", name))).toBe(true);
      expect(isStaleSigns(new DOMException("x", name))).toBe(true);
    },
  );

  it.each(["QuotaExceededError", "ConstraintError", "DataError", "UnknownError"])(
    "does NOT retry %s — a genuine fault must surface, not be masked",
    (name) => {
      expect(isStaleConnectionError(new DOMException("x", name))).toBe(false);
      expect(isStaleSigns(new DOMException("x", name))).toBe(false);
    },
  );

  it("is safe on non-Error throwables", () => {
    for (const v of [null, undefined, "boom", 42, {}]) {
      expect(isStaleConnectionError(v)).toBe(false);
    }
  });
});

describe("tx() re-opens and retries once on a stale connection (#205)", () => {
  it("deploy outbox: recovers from a SYNCHRONOUS transaction() throw", async () => {
    globalThis.indexedDB = staleOnce("sync-throw");
    await expect(putDeployEntry(deployEntry)).resolves.toBeDefined();
    expect(await allDeployEntries()).toHaveLength(1);
  });

  it("deploy outbox: recovers from an ASYNCHRONOUS abort — the iOS case", async () => {
    globalThis.indexedDB = staleOnce("async-abort");
    // Before the fix this rejected, and the store turned it into
    // "Couldn't save the claim on this device — try again."
    await expect(putDeployEntry(deployEntry)).resolves.toBeDefined();
    expect(await allDeployEntries()).toHaveLength(1);
  });

  it("status outbox: recovers from a SYNCHRONOUS transaction() throw", async () => {
    globalThis.indexedDB = staleOnce("sync-throw");
    await expect(putStatusEntry(statusEntry)).resolves.toBeDefined();
    expect(await allStatusEntries()).toHaveLength(1);
  });

  it("status outbox: recovers from an ASYNCHRONOUS abort", async () => {
    globalThis.indexedDB = staleOnce("async-abort");
    await expect(putStatusEntry(statusEntry)).resolves.toBeDefined();
    expect(await allStatusEntries()).toHaveLength(1);
  });
});
