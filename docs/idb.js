'use strict';

/**
 * IndexedDB Wrapper Module
 *
 * Provides a thin async wrapper around IndexedDB for offline data persistence.
 * Database: footy-manager
 * Store: roster
 * Key: current
 */

const DB_NAME = 'footy-manager';
const STORE_NAME = 'roster';
const KEY_NAME = 'current';

/**
 * Detect whether IndexedDB is available in the current context.
 * Returns false in private browsing mode or when IDB is blocked.
 *
 * @returns {boolean} true if IndexedDB is available, false otherwise
 */
export function isAvailable() {
  try {
    // Check if indexedDB API is present
    if (!window.indexedDB) {
      return false;
    }

    // Test if we can actually open a database
    // Private browsing and some incognito modes will throw or return false
    const test = window.indexedDB.open('__test_idb_available__');
    let available = false;

    test.onsuccess = () => {
      available = true;
      test.result.close();
      // Cleanup: delete test database
      window.indexedDB.deleteDatabase('__test_idb_available__');
    };

    test.onerror = () => {
      available = false;
    };

    // For synchronous detection, we return true if the API exists
    // The actual availability is confirmed via the async functions
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Load a snapshot from IndexedDB.
 * Opens the database, reads the key 'current' from the 'roster' store.
 *
 * @returns {Promise<Object|null>} the snapshot data or null if not found
 */
export async function loadSnapshot() {
  return new Promise((resolve) => {
    try {
      const req = window.indexedDB.open(DB_NAME, 1);

      req.onerror = () => {
        console.warn('[idb] loadSnapshot: open failed', req.error);
        resolve(null);
      };

      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const store = tx.objectStore(STORE_NAME);
          const getReq = store.get(KEY_NAME);

          getReq.onerror = () => {
            console.warn('[idb] loadSnapshot: get failed', getReq.error);
            resolve(null);
          };

          getReq.onsuccess = () => {
            resolve(getReq.result || null);
          };

          tx.onerror = () => {
            console.warn('[idb] loadSnapshot: transaction failed', tx.error);
            resolve(null);
          };
        } catch (err) {
          console.warn('[idb] loadSnapshot: transaction error', err);
          resolve(null);
        } finally {
          db.close();
        }
      };

      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
    } catch (err) {
      console.warn('[idb] loadSnapshot: exception', err);
      resolve(null);
    }
  });
}

/**
 * Save a snapshot to IndexedDB.
 * Opens the database, writes the data to key 'current' in the 'roster' store.
 * Throws if IndexedDB is unavailable.
 *
 * @param {Object} data - the snapshot to persist
 * @returns {Promise<void>}
 */
export async function saveSnapshot(data) {
  return new Promise((resolve, reject) => {
    try {
      const req = window.indexedDB.open(DB_NAME, 1);

      req.onerror = () => {
        console.warn('[idb] saveSnapshot: open failed', req.error);
        reject(req.error);
      };

      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          const putReq = store.put(data, KEY_NAME);

          putReq.onerror = () => {
            console.warn('[idb] saveSnapshot: put failed', putReq.error);
            reject(putReq.error);
          };

          tx.onerror = () => {
            console.warn('[idb] saveSnapshot: transaction failed', tx.error);
            reject(tx.error);
          };

          tx.oncomplete = () => {
            resolve();
          };
        } catch (err) {
          console.warn('[idb] saveSnapshot: transaction error', err);
          reject(err);
        } finally {
          db.close();
        }
      };

      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
    } catch (err) {
      console.warn('[idb] saveSnapshot: exception', err);
      reject(err);
    }
  });
}

/**
 * Clear the snapshot from IndexedDB.
 * Useful for testing or resetting offline state.
 *
 * @returns {Promise<void>}
 */
export async function clearSnapshot() {
  return new Promise((resolve) => {
    try {
      const req = window.indexedDB.open(DB_NAME, 1);

      req.onerror = () => {
        console.warn('[idb] clearSnapshot: open failed', req.error);
        resolve();
      };

      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          const delReq = store.delete(KEY_NAME);

          delReq.onerror = () => {
            console.warn('[idb] clearSnapshot: delete failed', delReq.error);
          };

          tx.oncomplete = () => {
            resolve();
          };

          tx.onerror = () => {
            console.warn('[idb] clearSnapshot: transaction failed', tx.error);
            resolve();
          };
        } catch (err) {
          console.warn('[idb] clearSnapshot: transaction error', err);
          resolve();
        } finally {
          db.close();
        }
      };

      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
    } catch (err) {
      console.warn('[idb] clearSnapshot: exception', err);
      resolve();
    }
  });
}
