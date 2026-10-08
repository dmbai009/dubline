// Syntax check of all server and client scripts (npm run check)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const serverFiles = fs.readdirSync(path.join(root, 'server'), { recursive: true })
  .filter(name => name.endsWith('.js')).map(name => path.join('server', name));
const clientFiles = fs.readdirSync(path.join(root, 'public'))
  .filter(name => name.endsWith('.js')).map(name => path.join('public', name));
clientFiles.push(...fs.readdirSync(path.join(root, 'public', 'locale')).filter(name => name.endsWith('.js')).map(name => path.join('public', 'locale', name)));

let failed = 0;
const extraChecks = ['tools/electron-take-mix-smoke.js', 'take-mix.test.js', 'e2e/take-mix.e2e.js', 'electron-storage.js', 'electron-storage.test.js', 'e2e/storage.e2e.js', 'tools/electron-storage-smoke.js', 'electron-external-links.js', 'test/electron-external-links.test.js', 'tools/electron-editor-smoke.js', 'audit-fixes.test.js', 'e2e/audit-fixes.e2e.js', 'projects.test.js', 'projects-stream.test.js', 'video-proxy.test.js', 'e2e/proxy.e2e.js', 'e2e/projects.e2e.js', 'timeline-workflow.test.js', 'e2e/workflow14.e2e.js', 'e2e/direct-media.e2e.js', 'e2e/solo-feedback.e2e.js', 'tools/electron-project-smoke.js', 'tools/visual-workflow-qa.js', 'tools/visual-solo-feedback.js'];
extraChecks.push('editor-hardening.test.js', 'e2e/editor-hardening.e2e.js');
extraChecks.push('transfer-utils.test.js', 'e2e/media-presence-hardening.e2e.js');
extraChecks.push('electron-project-open.js', 'electron-project-open.test.js', 'tools/electron-shell-smoke.js',
  'electron-distribution.js', 'electron-managed-files.js', 'electron-installed-update.js', 'electron-installed-update.test.js',
  'electron-portable-update.js', 'electron-portable-update.test.js', 'electron-update-http.js', 'electron-project-association.js', 'tools/build-distributions.js');
extraChecks.push('tools/packaged-test-driver.js', 'tools/electron-portable-update-smoke.js', 'tools/electron-setup-update-smoke.js', 'tools/verify-release-artifacts.js', 'tools/build-update-qa.js', 'tools/prepare-previous-release.js', 'tools/electron-portable-helper-smoke.js', 'electron-update-log.js');
extraChecks.push('tools/build-setup-qa.js');
extraChecks.push('electron-media-permissions.js', 'test/electron-media-permissions.test.js', 'e2e/ui-cleanup.e2e.js', 'tools/electron-ui-cleanup-smoke.js', 'tools/visual-ui-cleanup.js');
for (const file of ['server.js', 'electron-main.js', 'electron-network.js', 'electron-update.js', 'electron-preload.js', 'electron-guest-preload.js', 'electron-launcher-preload.js', 'electron-launcher.js', 'tools/build-icons.js', 'tools/download-cloudflared.js', 'tools/electron-smoke.js', 'tools/electron-guest-smoke.js', 'tools/electron-portable-smoke.js', ...serverFiles, ...clientFiles, ...extraChecks]) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    failed++;
    process.stderr.write(result.stderr);
  }
}
if (failed) process.exit(1);
