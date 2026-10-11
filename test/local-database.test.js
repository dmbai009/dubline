const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const requests = [], transactions = [];
  const window = { indexedDB: { open() { const request = {}; requests.push(request); return request; } } };
  vm.runInNewContext(fs.readFileSync('public/local-database.js', 'utf8'), { window });
  const database = () => ({ closed: false, close() { this.closed = true; }, transaction(name, mode) {
    const request = {}, transaction = { name, mode, request, objectStore() { return {
      put(value) { request.result = value.uploadId; return request; },
      delete() { return request; }, getAll() { request.result = ['retained']; return request; }
    }; } }; transactions.push(transaction); return transaction;
  } });
  return { window, requests, transactions, database, api: window.DublineLocalDatabase };
}
test('a blocked IndexedDB open closes a late connection without replacing the successful retry', async () => {
  const f = fixture(), blocked = f.api.open();
  f.requests[0].onblocked(); await assert.rejects(blocked, /Close other DubLine tabs/);
  const retry = f.api.open(), current = f.database();
  f.requests[1].result = current; f.requests[1].onsuccess(); assert.equal(await retry, current);
  const late = f.database(); f.requests[0].result = late; f.requests[0].onsuccess();
  assert.equal(late.closed, true); assert.equal(current.closed, false); assert.equal(await f.api.open(), current);
  current.onversionchange(); assert.equal(current.closed, true);
  const next = f.api.open(), nextDatabase = f.database();
  f.requests[2].result = nextDatabase; f.requests[2].onsuccess(); await next;
  current.onversionchange(); assert.equal(nextDatabase.closed, false); assert.equal(await f.api.open(), nextDatabase);
});
test('pending take transactions preserve successful results and settle aborts into the existing memory fallback', async () => {
  const f = fixture(), context = { window: f.window };
  const source = fs.readFileSync('public/recording.js', 'utf8');
  vm.runInNewContext(source.slice(source.indexOf('const takeStore ='), source.indexOf('function refreshPendingUi')) + '\nthis.takeStoreApi = takeStore;', context);
  const saved = context.takeStoreApi.put({ uploadId: 'take' }), database = f.database();
  f.requests[0].result = database; f.requests[0].onsuccess(); await tick();
  f.transactions[0].oncomplete(); assert.equal(await saved, 'take');
  const aborted = context.takeStoreApi.remove('take'); await tick();
  f.transactions[1].onabort();
  assert.equal(await Promise.race([aborted, new Promise(resolve => setTimeout(() => resolve('hung'), 100))]), null);
  const recovered = context.takeStoreApi.all(); await tick(); f.transactions[2].oncomplete();
  assert.deepEqual(await recovered, ['retained']);
});
