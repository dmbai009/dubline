const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http'), zlib = require('node:zlib');
const { negotiate } = require('./server/textCompression');
const { startServer } = require('./e2e/helpers');
function get(port, url, encoding, extra = {}) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: 'localhost', port, path: url, headers: { 'Accept-Encoding': encoding, ...extra } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    }).once('error', reject);
  });
}
test('text encoding negotiation honors q=0 and prefers the highest supported quality', () => {
  assert.equal(negotiate('gzip, br;q=0'), 'gzip'); assert.equal(negotiate('gzip;q=.9, br;q=.5'), 'gzip');
  assert.equal(negotiate('gzip, br'), 'br'); assert.equal(negotiate('br;q=0, gzip;q=0'), null);
  assert.equal(negotiate('br;q=bogus'), null); assert.equal(negotiate('*;q=.5'), 'br');
});
test('HTTP compresses textual scripts without changing decoded bytes; Range remains byte exact', async t => {
  const server = await startServer(); t.after(() => server.cleanup());
  const plain = await get(server.port, '/player.js', 'identity'), br = await get(server.port, '/player.js', 'br'), gzip = await get(server.port, '/player.js', 'gzip');
  assert.equal(br.headers['content-encoding'], 'br'); assert.equal(gzip.headers['content-encoding'], 'gzip');
  assert.match(br.headers.vary, /Accept-Encoding/); assert.equal(br.headers['content-length'], undefined);
  assert.deepEqual(zlib.brotliDecompressSync(br.bytes), plain.bytes); assert.deepEqual(zlib.gunzipSync(gzip.bytes), plain.bytes);
  const ranged = await get(server.port, '/player.js', 'br', { Range: 'bytes=10-99' });
  assert.equal(ranged.status, 206); assert.equal(ranged.headers['content-encoding'], undefined); assert.deepEqual(ranged.bytes, plain.bytes.subarray(10, 100));
});
