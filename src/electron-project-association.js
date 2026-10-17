const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
function portableProgId(executable) {
  const root = path.dirname(path.resolve(executable)).toLowerCase();
  return `io.github.dmbai009.Dubline.Portable.${crypto.createHash('sha256').update(root).digest('hex').slice(0, 24)}.Project`;
}
function associationOperation(operation, executable, script) {
  if (!['status', 'register', 'unregister'].includes(operation)) return Promise.reject(Error('Unknown association action.'));
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Operation', operation, '-ExePath', executable, '-ProgID', portableProgId(executable)],
  { windowsHide: true, timeout: 15000, encoding: 'utf8', maxBuffer: 128 * 1024 }, (error, stdout) => {
    if (error) { reject(Error('Windows project association could not be updated.')); return; }
    try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, ''))); } catch (_) { reject(Error('Invalid Windows association result.')); }
  }));
}
module.exports = { portableProgId, associationOperation };
