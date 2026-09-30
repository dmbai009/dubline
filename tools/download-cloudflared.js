// Downloads the official pinned Windows binary used by `npm run dist` and verifies its checksum.
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const VERSION = '2026.9.3';
const SHA256 = 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2';
const DOWNLOAD_URL = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-windows-amd64.exe`;
const destination = path.join(__dirname, '..', 'resources', 'cloudflared.exe');
const temporary = destination + '.download';

function checksum(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function download(url, file, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Dubline-build' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 5) return reject(new Error('Too many redirects while downloading cloudflared.'));
        return resolve(download(new URL(response.headers.location, url), file, redirects + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`cloudflared download failed: HTTP ${response.statusCode}`));
      }
      const output = fs.createWriteStream(file);
      response.pipe(output);
      output.on('finish', () => output.close(resolve));
      output.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination) && checksum(destination) === SHA256) {
    console.log(`[Dubline] cloudflared ${VERSION} is ready.`);
    return;
  }
  fs.rmSync(temporary, { force: true });
  console.log(`[Dubline] Downloading cloudflared ${VERSION}...`);
  await download(DOWNLOAD_URL, temporary);
  const actual = checksum(temporary);
  if (actual !== SHA256) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`cloudflared checksum mismatch: expected ${SHA256}, got ${actual}`);
  }
  fs.renameSync(temporary, destination);
  console.log('[Dubline] cloudflared verified and ready.');
}

main().catch(err => {
  console.error(`[Dubline] ${err.message}`);
  process.exit(1);
});
