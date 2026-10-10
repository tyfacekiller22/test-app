// Tiny wrapper around IndexedDB: the browser's built-in database.
// Everything is stored only on this device.

const DB_NAME = 'companion-chat';
const STORE = 'kv';
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

export const get = (key) => run('readonly', (s) => s.get(key));
export const set = (key, value) => run('readwrite', (s) => s.put(value, key));
export const del = (key) => run('readwrite', (s) => s.delete(key));
export const keys = () => run('readonly', (s) => s.getAllKeys());

// Ask the browser not to clear this app's data when storage is low.
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch (_) { /* not supported: fine */ }
}
