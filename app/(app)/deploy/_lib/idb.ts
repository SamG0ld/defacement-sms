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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        t.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        t.onerror = () => {
          db.close();
          reject(t.error);
        };
      }),
  );
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
