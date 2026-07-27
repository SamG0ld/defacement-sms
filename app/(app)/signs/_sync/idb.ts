// Tiny promise wrapper over IndexedDB for the /signs status-change outbox. A
// focused copy of app/(app)/deploy/_lib/idb.ts with a single object store and a
// distinct database name so it never collides with the deploy tool's queue.
//
// IndexedDB is unavailable during SSR and in private-mode edge cases; every
// caller treats a rejected open as "no durable queue" and degrades gracefully
// (the page still works online — only the durability is lost).

import type { StatusOutboxEntry } from "./types";

const DB_NAME = "defacement-signs";
const DB_VERSION = 1;
const OUTBOX = "outbox";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OUTBOX)) {
        db.createObjectStore(OUTBOX, { keyPath: "clientId" });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // The browser (iOS Safari especially) may close an idle connection out
      // from under us — drop the singleton so the next op re-opens.
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

// One connection per page session instead of an open/close cycle per operation
// (mirrors deploy/_lib/idb.ts). A failed open clears the singleton so the next
// op retries. The connection is only valid for the factory that created it, so
// a changed global re-opens (never happens in a browser; the unit tests swap in
// a fresh fake-indexeddb factory per test).
let dbPromise: Promise<IDBDatabase> | null = null;
let dbFactory: IDBFactory | null = null;

function getDb(): Promise<IDBDatabase> {
  if (!dbPromise || dbFactory !== globalThis.indexedDB) {
    dbFactory = globalThis.indexedDB;
    const opened = openDb();
    opened.catch(() => {
      if (dbPromise === opened) dbPromise = null;
    });
    dbPromise = opened;
  }
  return dbPromise;
}

// Mirrors deploy/_lib/idb.ts — see there for the full rationale. These names mean
// "the CONNECTION is stale", not "this data is bad". (#205)
export function isStaleConnectionError(err: unknown): boolean {
  const name = (err as { name?: string } | null | undefined)?.name;
  return (
    name === "InvalidStateError" ||
    name === "TransactionInactiveError" ||
    name === "AbortError"
  );
}

function runTx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(OUTBOX, mode);
    const req = run(t.objectStore(OUTBOX));
    // Capture the result during the request's success event — `req.result` is
    // only spec-guaranteed valid there, not after the transaction completes.
    let result: T;
    req.onsuccess = () => {
      result = req.result;
    };
    t.oncomplete = () => resolve(result);
    // See deploy/_lib/idb.ts: a torn-down transaction has a null `t.error`, and an
    // unhandled abort left this pending forever. Always reject with something
    // classifiable. (#205)
    const fail = () =>
      reject(t.error ?? new DOMException("transaction aborted", "AbortError"));
    t.onerror = fail;
    t.onabort = fail;
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const retryOnce = (err: unknown): Promise<T> => {
    if (!isStaleConnectionError(err)) throw err;
    dbPromise = null;
    return getDb().then((fresh) => runTx(fresh, mode, run));
  };
  return getDb().then((db) => {
    let running: Promise<T>;
    try {
      // transaction() throws SYNCHRONOUSLY on an already-closed connection…
      running = runTx(db, mode, run);
    } catch (err) {
      return retryOnce(err);
    }
    // …and can also abort ASYNCHRONOUSLY on one the browser is tearing down.
    // Retry both, once. (#205)
    return running.catch(retryOnce);
  });
}

export function putEntry(entry: StatusOutboxEntry): Promise<IDBValidKey> {
  return tx("readwrite", (s) => s.put(entry));
}

export function deleteEntry(clientId: string): Promise<undefined> {
  return tx("readwrite", (s) => s.delete(clientId));
}

export function allEntries(): Promise<StatusOutboxEntry[]> {
  return tx<StatusOutboxEntry[]>(
    "readonly",
    (s) => s.getAll() as IDBRequest<StatusOutboxEntry[]>,
  ).then((rows) => rows.sort((a, b) => a.createdAt - b.createdAt));
}
