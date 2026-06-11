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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(OUTBOX, mode);
        const req = run(t.objectStore(OUTBOX));
        // Capture the result during the request's success event — `req.result` is
        // only spec-guaranteed valid there, not after the transaction completes.
        let result: T;
        req.onsuccess = () => {
          result = req.result;
        };
        t.oncomplete = () => {
          db.close();
          resolve(result);
        };
        t.onerror = () => {
          db.close();
          reject(t.error);
        };
      }),
  );
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
