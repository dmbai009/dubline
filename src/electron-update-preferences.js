const fs = require('node:fs');
const path = require('node:path');
const { isBeta } = require('./update-version');
class UpdatePreferences {
  constructor(folder, version = '') {
    this.file = path.join(folder, 'update-preferences.json'); this.experimental = isBeta(version);
    try {
      if (fs.statSync(this.file).size > 1024) return;
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (value?.schemaVersion === 1 && typeof value.experimental === 'boolean') this.experimental = value.experimental;
    } catch { /* Missing/corrupt preferences use the distribution's default. */ }
  }
  set(experimental) {
    if (typeof experimental !== 'boolean') throw Error('Invalid update preference.');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.new';
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, experimental }) + '\n');
    fs.renameSync(temporary, this.file); this.experimental = experimental;
  }
}
module.exports = { UpdatePreferences };
