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
const extraChecks = ['tools/electron-take-mix-smoke.js', 'take-mix.test.js', 'e2e/take-mix.e2e.js', 'electron-storage.js', 'electron-storage.test.js', 'e2e/storage.e2e.js', 'tools/electron-storage-smoke.js', 'electron-external-links.js', 'test/electron-external-links.test.js', 'tools/electron-editor-smoke.js', 'audit-fixes.test.js', 'e2e/audit-fixes.e2e.js', 'projects.test.js', 'projects-stream.test.js', 'video-proxy.test.js', 'e2e/proxy.e2e.js', 'e2e/projects.e2e.js', 'timeline-workflow.test.js', 'e2e/workflow14.e2e.js', 'e2e/direct-media.e2e.js', 'e2e/solo-feedback.e2e.js', 'tools/electron-project-smoke.js', 'tools/visual-workflow-qa.js', 'tools/visual-solo-feedback.js'];
for (const file of ['server.js', 'electron-main.js', 'electron-network.js', 'electron-update.js', 'electron-preload.js', 'electron-guest-preload.js', 'electron-launcher-preload.js', 'electron-launcher.js', 'tools/build-icons.js', 'tools/download-cloudflared.js', 'tools/electron-smoke.js', 'tools/electron-guest-smoke.js', 'tools/electron-portable-smoke.js', ...serverFiles, ...clientFiles, ...extraChecks]) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    failed++;
    process.stderr.write(result.stderr);
  }
}
if (failed) process.exit(1);
