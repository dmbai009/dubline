// Exercise overlapping launches of the exact portable EXE, using isolated test profiles.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.join(__dirname, '..');

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ args, code, signal }));
  });
}

async function main() {
  // Wait for both cleanup paths even if one fails; neither test touches real user data.
  const results = await Promise.allSettled([
    run(['tools/electron-smoke.js', 'porthole', '--portable']),
    run(['tools/electron-guest-smoke.js', '--portable'])
  ]);
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
    assert.equal(result.value.code, 0, JSON.stringify(result.value));
  }
  console.log('Concurrent portable host / guest smokes passed: closing guests cannot remove host resources.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
