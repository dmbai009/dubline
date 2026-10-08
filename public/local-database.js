// One additive schema for local recovery. Media clearing never touches intent.
(function(root) {
  const SCHEMA_VERSION = 2;
  const STORES = { pendingTakes: 'uploadId', pendingEditorOperations: 'id', mediaCacheMetadata: 'id', mediaCacheChunks: 'id' };
  let connection = null, opening = null;
  function open() {
    if (connection) return Promise.resolve(connection);
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (!root.indexedDB) return reject(new Error('IndexedDB unavailable'));
      const request = root.indexedDB.open('dubline', SCHEMA_VERSION);
      request.onupgradeneeded = () => {
        for (const [name, keyPath] of Object.entries(STORES)) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath });
        }
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Close other DubLine tabs to upgrade local storage'));
      request.onsuccess = () => {
        connection = request.result;
        connection.onversionchange = () => { connection.close(); connection = null; opening = null; };
        resolve(connection);
      };
    }).catch(error => { opening = null; throw error; });
    return opening;
  }
  async function run(name, mode, action) {
    const database = await open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(name, mode);
      const request = action(transaction.objectStore(name));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('Local storage transaction aborted'));
    });
  }
  function store(name) {
    if (!Object.hasOwn(STORES, name)) throw new Error('Unknown local store');
    return { put: value => run(name, 'readwrite', table => table.put(value)),
      replace: (id, value) => run(name, 'readwrite', table => { table.delete(id); return table.put(value); }),
      remove: id => run(name, 'readwrite', table => table.delete(id)),
      all: () => run(name, 'readonly', table => table.getAll()),
      get: id => run(name, 'readonly', table => table.get(id)) };
  }
  async function clearMedia() {
    const database = await open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['mediaCacheMetadata', 'mediaCacheChunks'], 'readwrite');
      transaction.objectStore('mediaCacheMetadata').clear();
      transaction.objectStore('mediaCacheChunks').clear();
      transaction.oncomplete = resolve;
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  }
  root.DublineLocalDatabase = { open, store, clearMedia, SCHEMA_VERSION, STORES };
})(window);
