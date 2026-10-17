(function(root) {
  const labels = {
    en: { title: 'Dubline update', available: 'Version {version} is available.', downloading: 'Downloading {version}: {percent}%', downloaded: 'Version {version} is ready.', error: 'Update failed. Retry or download manually.', install: 'Restart to update', retry: 'Retry', manual: 'View on GitHub', wait: 'Downloading…', busy: 'Finish recording, uploads and other active operations before restarting.', details: 'Download manually' },
    ru: { title: 'Обновление Dubline', available: 'Доступна версия {version}.', downloading: 'Загрузка {version}: {percent}%', downloaded: 'Версия {version} готова.', error: 'Обновление не удалось. Повторите или скачайте вручную.', install: 'Перезапустить и обновить', retry: 'Повторить', manual: 'Открыть на GitHub', wait: 'Загрузка…', busy: 'Завершите запись, загрузки и другие активные операции перед перезапуском.', details: 'Скачать вручную' },
    uk: { title: 'Оновлення Dubline', available: 'Доступна версія {version}.', downloading: 'Завантаження {version}: {percent}%', downloaded: 'Версія {version} готова.', error: 'Оновлення не вдалося. Повторіть або завантажте вручну.', install: 'Перезапустити й оновити', retry: 'Повторити', manual: 'Відкрити на GitHub', wait: 'Завантаження…', busy: 'Завершіть запис, завантаження та інші активні операції перед перезапуском.', details: 'Завантажити вручну' }
  };
  function presentation(status, language) {
    const copy = labels[language] || labels.en, state = status?.state;
    const text = (copy[state] || copy.available).replace('{version}', status?.version || '').replace('{percent}', Math.floor(status?.progress?.percent || 0));
    return { visible: ['available', 'downloading', 'downloaded'].includes(state) || state === 'error' && !!status?.version,
      title: copy.title, text, action: state === 'downloaded' ? copy.install : state === 'error' ? copy.retry : state === 'downloading' ? copy.wait : copy.manual,
      disabled: ['downloading', 'installing'].includes(state), busy: copy.busy, details: copy.details };
  }
  root.DublineUpdatePresentation = presentation;
  if (typeof document === 'undefined') return;
  document.addEventListener('DOMContentLoaded', async () => {
    const bridge = window.dublineDesktop || window.dublineLauncher;
    if (!bridge) return;
    const language = () => window.DublineI18n?.getLanguage() || document.documentElement.lang || bridge.language || 'en';
    if (bridge.getBuildInfo) {
      const details = document.createElement('details'), title = document.createElement('summary'), output = document.createElement('pre');
      details.className = 'setting-card'; output.style.cssText = 'white-space:pre-wrap;font-size:11px'; details.append(title, output);
      const refresh = () => { title.textContent = ({ en:'Build information',ru:'Информация о сборке',uk:'Інформація про збірку' })[language()] || 'Build information'; };
      refresh(); window.addEventListener('dubline-language-changed',refresh);
      document.getElementById('language')?.addEventListener('change',refresh);
      (document.getElementById('tabContentPlayer') || document.getElementById('storageCard') || document.body).append(details);
      bridge.getBuildInfo().then(info => { window.DublineBuildInfo = info; output.textContent = JSON.stringify(info,null,2); }).catch(()=>{});
    }
    let waitingAt = -Infinity;
    bridge.onProjectOpenWaiting?.(() => {
      if (performance.now() - waitingAt < 5000) return;
      waitingAt = performance.now();
      window.showToast?.(({ en: 'The project will open after the current operation finishes.', ru: 'Проект откроется после завершения текущей операции.', uk: 'Проєкт відкриється після завершення поточної операції.' })[language()] || 'The project will open after the current operation finishes.');
    });
    for (const [bannerId, actionId] of [['appUpdateBanner', '.app-update-actions'], ['updateBanner', '.update-actions']]) {
      const actions = document.getElementById(bannerId)?.querySelector(actionId);
      if (!actions || !bridge.openUpdateDetails) continue;
      const details = document.createElement('button'); details.className = 'btn-outline update-later';
      details.textContent = presentation(null, language()).details; details.onclick = () => bridge.openUpdateDetails(); actions.append(details);
    }
    if (!bridge.projectAssociation) return;
    const copy = {
      en: ['.dubline projects', 'Register this Portable copy', 'Repair this copy', 'Unregister this copy', 'Choose the default app through Windows Open with.', 'Registration failed.'],
      ru: ['Проекты .dubline', 'Зарегистрировать эту Portable-копию', 'Исправить регистрацию', 'Отменить регистрацию этой копии', 'Приложение по умолчанию выбирается через «Открыть с помощью» в Windows.', 'Регистрация не удалась.'],
      uk: ['Проєкти .dubline', 'Зареєструвати цю Portable-копію', 'Виправити реєстрацію', 'Скасувати реєстрацію цієї копії', 'Програму за замовчуванням оберіть через «Відкрити за допомогою» у Windows.', 'Реєстрація не вдалася.']
    };
    let status;
    try { status = await bridge.projectAssociation('status'); } catch (_) { return; }
    if (!status.supported) return;
    const parent = document.getElementById('desktopAboutVersion')?.closest('.setting-card') || document.getElementById('launcherVersion')?.parentElement;
    if (!parent) return;
    const box = document.createElement('div'); box.className = 'portable-project-association';
    box.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px;width:100%;font-size:12px';
    const title = document.createElement('span'), register = document.createElement('button'), unregister = document.createElement('button'), help = document.createElement('span');
    register.className = unregister.className = 'btn-outline';
    help.style.cssText = 'width:100%;opacity:.65'; help.setAttribute('role', 'status');
    box.append(title, register, unregister, help); parent.append(box);
    const render = () => {
      const text = copy[language()] || copy.en;
      title.textContent = text[0]; register.textContent = text[status.registered || status.staleOwned ? 2 : 1];
      unregister.textContent = text[3]; unregister.hidden = !status.registered; help.textContent = text[4];
    };
    const action = async operation => {
      register.disabled = unregister.disabled = true;
      try { status = await bridge.projectAssociation(operation); render(); }
      catch (_) { help.textContent = (copy[language()] || copy.en)[5]; }
      finally { register.disabled = unregister.disabled = false; }
    };
    register.onclick = () => action('register'); unregister.onclick = () => action('unregister');
    window.addEventListener('dubline-language-changed', render); render();
    new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  });
})(typeof window === 'undefined' ? globalThis : window);
