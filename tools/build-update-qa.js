const { spawnSync } = require('node:child_process');
const pkg = require('../package.json');
const parts = pkg.version.split('.').map(Number); parts[2]++;
const env = { ...process.env, DUBLINE_QA_VERSION: parts.join('.') };
const result = spawnSync(process.execPath, ['tools/build-distributions.js', 'all', 'dist/portable'], { env, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error; process.exitCode = result.status ?? 1;
