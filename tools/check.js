// Syntax check of all server and client scripts (npm run check)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const serverFiles = fs.readdirSync(path.join(root, 'server'), { recursive: true })
  .filter(name => name.endsWith('.js')).map(name => path.join('server', name));
const clientFiles = fs.readdirSync(path.join(root, 'public'))
  .filter(name => name.endsWith('.js')).map(name => path.join('public', name));

let failed = 0;
for (const file of ['server.js', 'electron-main.js', 'electron-network.js', 'electron-update.js', 'electron-preload.js', 'electron-launcher-preload.js', 'electron-launcher.js', 'tools/build-icons.js', 'tools/download-cloudflared.js', 'tools/electron-smoke.js', ...serverFiles, ...clientFiles]) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    failed++;
    process.stderr.write(result.stderr);
  }
}
if (failed) process.exit(1);
