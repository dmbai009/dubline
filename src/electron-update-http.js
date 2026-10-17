const https = require('node:https');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
function officialUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(url.hostname === 'github.com' || url.hostname === 'api.github.com' || url.hostname.endsWith('.githubusercontent.com'))) {
    throw new Error('Untrusted update origin.');
  }
  return url;
}
function responseFor(value, redirects = 0) {
  const url = officialUrl(value);
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'Dubline-updater', Accept: 'application/vnd.github+json' } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= 5 || !response.headers.location) { reject(Error('Invalid update redirect.')); return; }
        try { resolve(responseFor(new URL(response.headers.location, url).href, redirects + 1)); } catch (error) { reject(error); }
        return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(Error(`Update server returned ${response.statusCode}.`)); return; }
      resolve(response);
    });
    request.setTimeout(60000, () => request.destroy(Error('Update request timed out.')));
    request.once('error', reject);
  });
}
async function jsonFrom(value, maxBytes = 8 * 1024 ** 2) {
  const response = await responseFor(value), chunks = []; let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > maxBytes) { response.destroy(); throw Error('Update metadata is too large.'); }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function download(value, destination, expected, progress = () => {}) {
  const response = await responseFor(value), hash = crypto.createHash('sha256'); let size = 0, last = 0;
  const start = Date.now();
  if (response.headers['content-length'] && Number(response.headers['content-length']) !== expected.size) {
    response.destroy(); throw Error('Update size mismatch.');
  }
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > expected.size) { callback(Error('Update exceeds expected size.')); return; }
    hash.update(chunk);
    if (Date.now() - last >= 250 || size === expected.size) {
      last = Date.now(); progress({ percent: size / expected.size * 100, transferred: size, total: expected.size,
        bytesPerSecond: size * 1000 / Math.max(1, Date.now() - start) });
    }
    callback(null, chunk);
  } });
  try {
    await pipeline(response, meter, fs.createWriteStream(destination, { flags: 'wx' }));
    if (size !== expected.size || hash.digest('hex') !== expected.sha256) throw Error('Update integrity mismatch.');
  } catch (error) { await fs.promises.rm(destination, { force: true }).catch(() => {}); throw error; }
}
module.exports = { officialUrl, jsonFrom, download };
