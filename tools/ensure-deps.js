// Проверяет, что зависимости установлены и соответствуют package.json / package-lock.json.
// Если нет (первый запуск после скачивания или обновление через git pull) — ставит их сам.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const nodeModules = path.join(root, 'node_modules');
const marker = path.join(nodeModules, '.dubline-deps');

function depsFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const file of ['package.json', 'package-lock.json']) {
    const full = path.join(root, file);
    if (fs.existsSync(full)) hash.update(fs.readFileSync(full));
  }
  return hash.digest('hex');
}

const wanted = depsFingerprint();
const installed = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
if (wanted === installed && fs.existsSync(path.join(nodeModules, 'express'))) process.exit(0);

console.log('[Dubline] Устанавливаю зависимости (npm install).');
console.log('[Dubline] Это нужно один раз после скачивания или обновления и займет минуту-другую...');

// На Windows npm — это npm.cmd, его можно запустить только через оболочку (одной строкой)
const command = 'npm install --no-audit --no-fund';
const result = process.platform === 'win32'
  ? spawnSync(command, { cwd: root, stdio: 'inherit', shell: true })
  : spawnSync('npm', command.split(' ').slice(1), { cwd: root, stdio: 'inherit' });

if (result.status !== 0) {
  console.error('[Dubline] npm install завершился с ошибкой. Проверьте интернет и запустите start.bat еще раз.');
  process.exit(1);
}

fs.writeFileSync(marker, wanted);
console.log('[Dubline] Зависимости установлены.');
