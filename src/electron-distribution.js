const fs = require('node:fs');
const path = require('node:path');
const CHANNELS = new Set(['github-setup', 'github-portable', 'steam']);
function readDistribution(resourcesPath, packaged) {
  if (!packaged) return { schemaVersion: 1, channel: 'development', platform: process.platform, arch: process.arch };
  const value = JSON.parse(fs.readFileSync(path.join(resourcesPath, 'dubline-distribution.json'), 'utf8'));
  if (value.schemaVersion !== 1 || !CHANNELS.has(value.channel) || value.platform !== process.platform ||
      value.arch !== process.arch || !/^\d+\.\d+\.\d+$/.test(value.version) ||
      !/^[a-f0-9]{40}$/.test(value.commit) || !/^\d+\.\d+\.\d+$/.test(value.electronVersion)) {
    throw new Error('Invalid Dubline distribution marker.');
  }
  return value;
}
module.exports = { CHANNELS, readDistribution };
