const fs = require('node:fs'), path = require('node:path');
function projectPathsFromArgs(args, cwd = process.cwd(), invalid = () => {}) {
  const found = [];
  for (const raw of Array.isArray(args) ? args.slice(0, 128) : []) {
    if (typeof raw !== 'string' || !raw || raw.startsWith('-') || raw.length > 32760) continue;
    const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    if (path.extname(value).toLowerCase() !== '.dubline') continue;
    const file = path.resolve(cwd, value);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw Error('Choose an existing regular .dubline project file.');
      if (!found.includes(file)) found.push(file);
    } catch (error) { invalid(error); }
    if (found.length >= 8) break;
  }
  return found;
}
class ProjectOpenCoordinator {
  constructor({ busy, open, error = () => {}, waiting = () => {} }) { this.busy = busy; this.open = open; this.error = error; this.waiting = waiting; this.queue = []; this.active = false; this.closed = false; this.timer = null; }
  enqueue(file) {
    if (this.closed || this.queue.length >= 8) return false;
    if (!this.queue.includes(file)) this.queue.push(file);
    void this.pump(); return true;
  }
  async pump() {
    if (this.closed || this.active || !this.queue.length) return;
    this.active = true;
    try {
      if (await this.busy()) { this.waiting(); clearTimeout(this.timer); this.timer = setTimeout(() => { this.timer = null; void this.pump(); }, 250); this.timer.unref?.(); return; }
      const file = this.queue.shift();
      try { await this.open(file); } catch (error) { this.error(error); }
    } finally { this.active = false; if (this.queue.length && !this.timer) queueMicrotask(() => this.pump()); }
  }
  dispose() { this.closed = true; clearTimeout(this.timer); this.timer = null; this.queue.length = 0; }
}
function projectMessages(language) {
  const copies = {
    en: { title: 'Open Dubline Project', cancel: 'Cancel', open: 'Open project', local: 'Open locally', guest: 'Leave the remote room and open this project locally in Single Player?', single: 'Open this project as a new scene? The previous scene remains in session history.', multi: 'This switches the active scene for everyone in the multiplayer room. The previous scene remains in session history. Continue?', invalid: 'Choose an existing regular .dubline project file.', busy: 'A critical operation started. Open the project again when it finishes.', failed: 'Project could not be opened', startup: 'Dubline could not start', transitionBusy: 'Finish the current operation before hosting multiplayer.' },
    ru: { title: 'Открыть проект Dubline', cancel: 'Отмена', open: 'Открыть проект', local: 'Открыть локально', guest: 'Выйти из удалённой комнаты и открыть проект локально в Single Player?', single: 'Открыть проект как новую сцену? Предыдущая сцена останется в истории сессий.', multi: 'Активная сцена изменится у всех участников комнаты. Предыдущая сцена останется в истории сессий. Продолжить?', invalid: 'Выберите существующий обычный файл проекта .dubline.', busy: 'Началась другая операция. Откройте проект после её завершения.', failed: 'Не удалось открыть проект', startup: 'Не удалось запустить Dubline', transitionBusy: 'Завершите текущую операцию перед запуском Multiplayer.' },
    uk: { title: 'Відкрити проєкт Dubline', cancel: 'Скасувати', open: 'Відкрити проєкт', local: 'Відкрити локально', guest: 'Вийти з віддаленої кімнати та відкрити проєкт локально в Single Player?', single: 'Відкрити проєкт як нову сцену? Попередня сцена залишиться в історії сесій.', multi: 'Активна сцена зміниться для всіх учасників кімнати. Попередня сцена залишиться в історії сесій. Продовжити?', invalid: 'Виберіть наявний звичайний файл проєкту .dubline.', busy: 'Почалася інша операція. Відкрийте проєкт після її завершення.', failed: 'Не вдалося відкрити проєкт', startup: 'Не вдалося запустити Dubline', transitionBusy: 'Завершіть поточну операцію перед запуском Multiplayer.' }
  };
  return copies[language] || copies.en;
}
module.exports = { projectPathsFromArgs, ProjectOpenCoordinator, projectMessages };
