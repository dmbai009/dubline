// Checks that dependencies are installed and match package.json / package-lock.json.
// If not (first run after download, or an update via git pull), installs them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const nodeModules = path.join(root, 'node_modules');
const marker = path.join(nodeModules, '.dubline-deps');

function depsFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const file of ['package.json', 'package-lock.json']) {
    const full = path.join(root, file);
    if (fs.existsSync(full)) hash.update(fs.readFileSync(full));
  }
  return hash.digest('hex');
}

const wanted = depsFingerprint();
const installed = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
if (wanted === installed && fs.existsSync(path.join(nodeModules, 'express'))) process.exit(0);

console.log('[Dubline] Installing dependencies (npm install).');
console.log('[Dubline] This is needed once after a download or update and takes a minute or two...');

// On Windows npm is npm.cmd, which can only be run through a shell (as one command line)
const command = 'npm install --no-audit --no-fund';
const result = process.platform === 'win32'
  ? spawnSync(command, { cwd: root, stdio: 'inherit', shell: true })
  : spawnSync('npm', command.split(' ').slice(1), { cwd: root, stdio: 'inherit' });

if (result.status !== 0) {
  console.error('[Dubline] npm install failed. Check your internet connection and run start.bat again.');
  process.exit(1);
}

fs.writeFileSync(marker, wanted);
console.log('[Dubline] Dependencies installed.');
