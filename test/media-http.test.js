const test = require('node:test');
const assert = require('node:assert/strict');
const { readHttpMedia, retryMedia, mediaError } = require('../public/transfer-utils');
const options = overrides => ({ from: 0, to: 65535, size: 131072, onPart: () => {}, ...overrides });
test('valid 206 checks bounds and emits exactly the requested transport frames', async () => {
  const bytes = new Uint8Array(65536).fill(42), parts = [];
  await readHttpMedia(new Response(bytes, { status: 206, headers: { 'Content-Range': 'bytes 65536-131071/131072', 'Content-Length': '65536' } }),
    options({ from: 65536, to: 131071, onPart: (index, data) => parts.push({ index, data: new Uint8Array(data) }) }));
  assert.equal(parts.length, 1); assert.equal(parts[0].index, 1); assert.deepEqual(parts[0].data, bytes);
});
test('a full 200 streams all missing ranges once without calling arrayBuffer or allocating a full response buffer', async () => {
  const size = 3 * 1024 * 1024 + 17; let offset = 0, largest = 0, count = 0, received = 0;
  const response = new Response(new ReadableStream({ pull(controller) {
    if (offset === size) return controller.close();
    const bytes = new Uint8Array(Math.min(12345, size - offset)).fill(offset % 251); offset += bytes.length; controller.enqueue(bytes);
  } }), { status: 200 });
  response.arrayBuffer = () => { throw Error('Full response buffering is forbidden'); };
  const result = await readHttpMedia(response, options({ from: 65536, to: 131071, size,
    onPart: (index, bytes) => { assert.equal(index, count++); largest = Math.max(largest, bytes.byteLength); },
    onBytes: bytes => { received += bytes; } }));
  assert.equal(result.full, true); assert.equal(received, size); assert.equal(count, Math.ceil(size / 65536)); assert.equal(largest, 65536);
});
test('malformed ranges, partial 200s and oversized bodies cannot become successful media', async () => {
  for (const [response, code] of [
    [new Response(new Uint8Array(65536), { status: 206, headers: { 'Content-Range': 'bytes 1-65536/131072' } }), 'range'],
    [new Response(new Uint8Array(65536), { status: 206 }), 'range'],
    [new Response(new Uint8Array(65536), { status: 200, headers: { 'Content-Length': '65536' } }), 'range'],
    [new Response(new Uint8Array(65535), { status: 206, headers: { 'Content-Range': 'bytes 0-65535/131072' } }), 'truncated'],
    [new Response(new Uint8Array(131073), { status: 200 }), 'size']
  ]) await assert.rejects(readHttpMedia(response, options()), error => error.code === code);
});
test('HTTP failures preserve their actual status and cancel unread response bodies', async () => {
  for (const status of [403, 404, 409, 416, 429, 503]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status });
    await assert.rejects(readHttpMedia(response, options()), error => error.status === status && error.code === 'http');
    assert.equal(cancelled, true);
  }
});
test('cancel and an idle timeout release a stalled response instead of waiting for its body forever', async () => {
  let cancelled = 0;
  const make = () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 200 });
  const abort = new AbortController(), pending = readHttpMedia(make(), options({ signal: abort.signal }));
  abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(readHttpMedia(make(), options({ idleMs: 10 })), error => error.code === 'timeout');
  assert.equal(cancelled, 2);
});
test('retry only transient failures, at most three attempts, and never start a cancelled request', async () => {
  let attempts = 0, retries = 0;
  const value = await retryMedia(() => { if (++attempts < 3) throw mediaError('http', 503); return 'received'; }, null, () => retries++);
  assert.equal(value, 'received'); assert.equal(attempts, 3); assert.equal(retries, 2);
  attempts = 0; await assert.rejects(retryMedia(() => { attempts++; throw mediaError('http', 403); })); assert.equal(attempts, 1);
  attempts = 0; await assert.rejects(retryMedia(() => { attempts++; throw mediaError('network'); })); assert.equal(attempts, 3);
  const abort = new AbortController(); abort.abort(); attempts = 0;
  await assert.rejects(retryMedia(() => { attempts++; }, abort.signal), { name: 'AbortError' }); assert.equal(attempts, 0);
});
