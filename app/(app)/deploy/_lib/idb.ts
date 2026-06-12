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
    t.onerror = () => reject(t.error);
  });
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return getDb().then((db) => {
    try {
      return runTx(db, store, mode, run);
    } catch {
      // transaction() throws synchronously on a connection the browser already
      // closed — re-open once and retry.
      dbPromise = null;
      return getDb().then((fresh) => runTx(fresh, store, mode, run));
    }
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
