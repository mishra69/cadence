// A very small IndexedDB wrapper. Two stores:
//
//   outbox — events written while offline, flushed on reconnect. This is the
//            reason event ids are client-generated: a flush that half-succeeds
//            has to be safe to repeat, and the server's ON CONFLICT DO NOTHING
//            makes it so.
//   cache  — the last successful stats and today's events, so the home screen
//            renders something honest with no network instead of a spinner.
//
// localStorage would have been simpler, but the outbox has to survive an
// iOS storage sweep better than localStorage does, and it may hold notes.

const IDB = (() => {
  const DB_NAME = 'cadence';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  return {
    // ── outbox ──
    queue: ev => tx('outbox', 'readwrite', s => s.put(ev)),
    dequeue: id => tx('outbox', 'readwrite', s => s.delete(id)),
    pending: () => tx('outbox', 'readonly', s => s.getAll()),
    pendingCount: () => tx('outbox', 'readonly', s => s.count()),

    // ── cache ──
    put: (key, value) => tx('cache', 'readwrite', s => s.put(value, key)),
    get: key => tx('cache', 'readonly', s => s.get(key)),

    clear: () => open().then(db => Promise.all(['outbox', 'cache'].map(name =>
      new Promise((resolve, reject) => {
        const t = db.transaction(name, 'readwrite');
        t.objectStore(name).clear();
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      })
    ))),
  };
})();
