// Check every owned script, including tests and build tools, without scanning
// downloaded libraries or user media beneath public/.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
const directories = ['server', 'public', 'test', 'e2e', 'tools'];
function scriptsIn(directory) {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    if (directory === 'public' && ['uploads', 'packs', 'vendor'].includes(entry.name)) continue;
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...scriptsIn(name));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(name);
  }
  return files;
}
const files = [
  ...fs.readdirSync(root).filter(name => name.endsWith('.js')),
  ...directories.flatMap(scriptsIn)
].sort();
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    failed++;
    process.stderr.write(result.stderr || result.error?.message || ('Could not check ' + file + '\n'));
  }
}
if (failed) process.exit(1);
