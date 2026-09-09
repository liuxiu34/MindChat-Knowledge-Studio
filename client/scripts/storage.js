(function () {
  window.MindChatModules = window.MindChatModules || {};

  window.MindChatModules.createStorageModule = function createStorageModule(options = {}) {
    const localStore = options.localStorage || window.localStorage;
    const sessionStore = options.sessionStorage || window.sessionStorage;
    const indexedDbFactory = options.indexedDB || window.indexedDB;
    const apiKeySessionStorageKey = options.apiKeySessionStorageKey || 'mindchat_api_key_session';
    const dbName = options.dbName || 'mindchat_canvas';
    const dbVersion = options.dbVersion || 1;
    const keyValueStoreName = options.keyValueStoreName || 'key_value';
    const currentLang = options.currentLang || (() => 'zh');
    const notify = options.notify || ((message) => window.alert(message));
    let criticalWarningShown = false;
    let dbPromise = null;

    function openIndexedDb() {
      if (!indexedDbFactory) {
        return Promise.reject(new Error('IndexedDB is not available.'));
      }
      if (dbPromise) return dbPromise;

      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDbFactory.open(dbName, dbVersion);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(keyValueStoreName)) {
            db.createObjectStore(keyValueStoreName, { keyPath: 'key' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB.'));
        request.onblocked = () => reject(new Error('IndexedDB open was blocked by another tab.'));
      });

      return dbPromise;
    }

    async function withIndexedDbStore(mode, callback) {
      const db = await openIndexedDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(keyValueStoreName, mode);
        const store = tx.objectStore(keyValueStoreName);
        let callbackResult;
        tx.oncomplete = () => resolve(callbackResult);
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed.'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
        try {
          callbackResult = callback(store);
        } catch (err) {
          tx.abort();
          reject(err);
        }
      });
    }

    function requestToPromise(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
      });
    }

    async function idbSet(key, value) {
      await withIndexedDbStore('readwrite', (store) => {
        store.put({
          key,
          value,
          updatedAt: Date.now()
        });
      });
      return true;
    }

    async function idbGet(key) {
      return withIndexedDbStore('readonly', async (store) => {
        const record = await requestToPromise(store.get(key));
        return record ? record.value : null;
      });
    }

    async function idbRemove(key) {
      await withIndexedDbStore('readwrite', (store) => {
        store.delete(key);
      });
      return true;
    }

    async function idbKeys(prefix = '') {
      return withIndexedDbStore('readonly', async (store) => {
        const records = await requestToPromise(store.getAll());
        return records
          .map(record => record.key)
          .filter(key => !prefix || String(key).startsWith(prefix));
      });
    }

    async function migrateLocalStorageKeysToIndexedDb(prefix, { removeAfter = false } = {}) {
      const migrated = [];
      const keys = typeof localStore.key === 'function'
        ? Array.from({ length: localStore.length }, (_, index) => localStore.key(index))
        : Object.keys(localStore);

      for (const key of keys) {
        if (!key || !key.startsWith(prefix)) continue;
        const value = localStore.getItem(key);
        await idbSet(key, value);
        migrated.push(key);
      }
      if (removeAfter) {
        migrated.forEach(key => localStore.removeItem(key));
      }
      return migrated;
    }

    function safeSet(key, value, setOptions = {}) {
      try {
        localStore.setItem(key, value);
        return true;
      } catch (err) {
        console.error('Failed to save local data:', err);
        if (setOptions.critical && !criticalWarningShown) {
          criticalWarningShown = true;
          notify(currentLang() === 'zh'
            ? '本地保存失败，可能是浏览器存储空间不足。请尽快导出 JSON 备份。'
            : 'Local save failed, likely because browser storage is full. Please export a JSON backup soon.');
        }
        return false;
      }
    }

    function saveConfig(config) {
      const { apiKey, ...safeConfig } = config;
      safeSet('mindchat_config', JSON.stringify(safeConfig));
      try {
        if (apiKey) {
          sessionStore.setItem(apiKeySessionStorageKey, apiKey);
        } else {
          sessionStore.removeItem(apiKeySessionStorageKey);
        }
      } catch (e) {}
    }

    function loadConfig(defaultConfig) {
      const saved = localStore.getItem('mindchat_config');
      let savedConfig = {};
      if (saved) {
        try {
          savedConfig = JSON.parse(saved) || {};
        } catch (err) {
          console.error(err);
        }
      }

      const legacyApiKey = savedConfig.apiKey || '';
      delete savedConfig.apiKey;
      const nextConfig = { ...defaultConfig, ...savedConfig };

      try {
        if (legacyApiKey && !sessionStore.getItem(apiKeySessionStorageKey)) {
          sessionStore.setItem(apiKeySessionStorageKey, legacyApiKey);
        }
        nextConfig.apiKey = sessionStore.getItem(apiKeySessionStorageKey) || '';
      } catch (e) {
        nextConfig.apiKey = legacyApiKey;
      }

      if (legacyApiKey) saveConfig(nextConfig);
      return nextConfig;
    }

    return {
      safeSet,
      saveConfig,
      loadConfig,
      indexedDb: {
        isAvailable: () => !!indexedDbFactory,
        set: idbSet,
        get: idbGet,
        remove: idbRemove,
        keys: idbKeys,
        migrateLocalStorageKeys: migrateLocalStorageKeysToIndexedDb
      }
    };
  };
})();
