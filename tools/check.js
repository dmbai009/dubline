// Check every owned script, including tests and build tools, without scanning
// downloaded libraries or user media beneath public/.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
const directories = ['server', 'public', 'test', 'e2e', 'tools'];
const files = [
  ...fs.readdirSync(root).filter(name => name.endsWith('.js')),
  ...directories.flatMap(directory => fs.readdirSync(path.join(root, directory), { recursive: true })
    .map(name => path.join(directory, name).split(path.sep).join('/')))
].filter(name => name.endsWith('.js') && !/^public\/(?:uploads|packs|vendor)\//.test(name)).sort();
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    failed++;
    process.stderr.write(result.stderr || result.error?.message || ('Could not check ' + file + '\n'));
  }
}
if (failed) process.exit(1);
