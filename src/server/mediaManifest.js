const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { diskPathForUrl } = require('./files');
const CHUNK_SIZE = 256 * 1024;
const MAX_CHUNKS = 32768;
const cache = new Map();
let active = 0;
const waiters = [];
async function build(url) {
  const file = diskPathForUrl(url);
  if (!file) throw new Error('Invalid media path');
  const stat = await fs.promises.stat(file);
  if (!stat.isFile() || stat.size <= 0 || Math.ceil(stat.size / CHUNK_SIZE) > MAX_CHUNKS) throw new Error('Invalid media size');
  const key = JSON.stringify([file, stat.size, stat.mtimeMs]);
  if (cache.has(key)) return cache.get(key);
  const job = (async () => {
    if (active >= 2) await new Promise(resolve => waiters.push(resolve));
    active++;
    try {
      const whole = createHash('sha256'), chunks = [];
      let carry = Buffer.alloc(0), size = 0;
      for await (const part of fs.createReadStream(file, { highWaterMark: CHUNK_SIZE })) {
        whole.update(part); size += part.length;
        carry = carry.length ? Buffer.concat([carry, part]) : part;
        while (carry.length >= CHUNK_SIZE) { chunks.push(createHash('sha256').update(carry.subarray(0, CHUNK_SIZE)).digest('hex')); carry = carry.subarray(CHUNK_SIZE); }
      }
      if (carry.length) chunks.push(createHash('sha256').update(carry).digest('hex'));
      const after = await fs.promises.stat(file);
      if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Media changed');
      const sha256 = whole.digest('hex');
      return { layoutVersion: 1, chunkSize: CHUNK_SIZE, size, sha256,
        id: `${sha256}:${size}:${CHUNK_SIZE}:1`, chunks };
    } finally { active--; waiters.shift()?.(); }
  })().catch(error => { cache.delete(key); throw error; });
  cache.set(key, job);
  while (cache.size > 32) cache.delete(cache.keys().next().value);
  return job;
}
module.exports = { build, CHUNK_SIZE, MAX_CHUNKS };
