// Tiny promise wrapper over IndexedDB — no external dependency (the `idb`
// package isn't installed, and the surface we need is small). Two object stores:
//   - "outbox": queued mutations, keyed by clientId (see types.ts).
//   - "photos": deploy photo bytes (Blob), keyed by the deploy's clientId.
// Photos live here (not in the outbox row) because Blobs are large and we never
// want to read them just to enumerate the queue.
//
// IndexedDB is unavailable during SSR and in private-mode edge cases; every
// caller treats a rejected open as "no durable queue" and degrades gracefully.

import type { OutboxEntry } from "./types";

const DB_NAME = "defacement-deploy";
const DB_VERSION = 1;
const OUTBOX = "outbox";
const PHOTOS = "photos";

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
      if (!db.objectStoreNames.contains(PHOTOS)) {
        db.createObjectStore(PHOTOS);
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
// (a drain used to cost ~3N+1 cycles — expensive on iOS Safari). A failed open
// clears the singleton so the next op retries. The connection is only valid for
// the factory that created it, so a changed global re-opens (never happens in a
// browser; the unit tests swap in a fresh fake-indexeddb factory per test).
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

// A connection the browser is tearing down doesn't always fail loudly at
// transaction() time — on iOS Safari it can accept the call and then fire
// onerror/onabort asynchronously. These are the names that mean "the CONNECTION
// is stale", as opposed to a genuine data error worth surfacing. (#205)
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
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = run(t.objectStore(store));
    // Capture the result during the request's success event — `req.result` is
    // only spec-guaranteed valid there, not after the transaction completes.
    let result: T;
    req.onsuccess = () => {
      result = req.result;
    };
    t.oncomplete = () => resolve(result);
    // A transaction the browser tears down reports NO error — `t.error` is null.
    // Rejecting with that raw null gave callers nothing to classify (and the
    // abort event wasn't handled at all, so an abort could leave this promise
    // pending forever). Always reject with a named error so tx() can tell a stale
    // connection from a genuine data fault. (#205)
    const fail = () =>
      reject(t.error ?? new DOMException("transaction aborted", "AbortError"));
    t.onerror = fail;
    t.onabort = fail;
  });
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const retryOnce = (err: unknown): Promise<T> => {
    // Only a connection-state failure is worth retrying; a genuine data error
    // (constraint, quota) would fail identically on a fresh connection and must
    // surface. Bounded to ONE attempt so a real fault can't loop.
    if (!isStaleConnectionError(err)) throw err;
    dbPromise = null;
    return getDb().then((fresh) => runTx(fresh, store, mode, run));
  };
  return getDb().then((db) => {
    let running: Promise<T>;
    try {
      running = runTx(db, store, mode, run);
    } catch (err) {
      // transaction() throws SYNCHRONOUSLY on a connection the browser already
      // closed.
      return retryOnce(err);
    }
    // …but it can also accept the call and abort ASYNCHRONOUSLY (iOS Safari
    // after the app was backgrounded — the exact scenario the singleton-close
    // handling exists for). Callers treat any rejection as "no durable queue",
    // so an unretried stale-connection abort surfaces as "Couldn't save…" and
    // drops an offline claim/deploy the volunteer thinks was queued. (#205)
    return running.catch(retryOnce);
  });
}

// ── Outbox ────────────────────────────────────────────────────────────────────

export function putEntry(entry: OutboxEntry): Promise<IDBValidKey> {
  return tx(OUTBOX, "readwrite", (s) => s.put(entry));
}

export function deleteEntry(clientId: string): Promise<undefined> {
  return tx(OUTBOX, "readwrite", (s) => s.delete(clientId));
}

export function allEntries(): Promise<OutboxEntry[]> {
  return tx<OutboxEntry[]>(OUTBOX, "readonly", (s) =>
    s.getAll() as IDBRequest<OutboxEntry[]>,
  ).then((rows) => rows.sort((a, b) => a.createdAt - b.createdAt));
}

// ── Photos ──────────────────────────────────────────────────────────────────

export function putPhoto(clientId: string, blob: Blob): Promise<IDBValidKey> {
  return tx(PHOTOS, "readwrite", (s) => s.put(blob, clientId));
}

export function getPhoto(clientId: string): Promise<Blob | undefined> {
  return tx<Blob | undefined>(PHOTOS, "readonly", (s) =>
    s.get(clientId) as IDBRequest<Blob | undefined>,
  );
}

export function deletePhoto(clientId: string): Promise<undefined> {
  return tx(PHOTOS, "readwrite", (s) => s.delete(clientId));
}
