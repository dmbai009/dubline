// One presentation for local exports and authoritative room scene operations.
(() => {
  const records = new Map(), dismissed = new Set(), container = document.createElement('aside');
  container.id = 'backgroundOperations';
  container.setAttribute('aria-label', t('background.title'));
  document.body.append(container);
  let boundRoom = currentRoom, latestRevision = 0, sharedConfirmed = false;
  const activeStates = ['running', 'cancelling', 'reconnecting'];
  const clock = seconds => {
    const n = Math.max(0, Math.floor(seconds || 0));
    return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
  };
  function render() {
    if (boundRoom !== currentRoom) {
      for (const [key, record] of records) if (record.shared) records.delete(key);
      dismissed.clear(); boundRoom = currentRoom; latestRevision = 0; sharedConfirmed = false;
    }
    container.setAttribute('aria-label', t('background.title'));
    const header = document.querySelector('header'), scale = parseFloat(getComputedStyle(document.body).zoom) || 1;
    const top = (header?.getBoundingClientRect().bottom || 40) + 8;
    container.style.top = top / scale + 'px';
    container.style.width = Math.min(320, (innerWidth - 24) / scale) + 'px';
    container.style.maxHeight = Math.max(80, Math.min(innerHeight * .55, innerHeight - top - 12) / scale) + 'px';
    for (const [key, record] of records) {
      if (dismissed.has(key)) continue;
      const view = record.read();
      let card = container.querySelector('[data-operation="' + key + '"]');
      if (!card) {
        card = document.createElement('section'); card.className = 'background-operation'; card.dataset.operation = key;
        card.innerHTML = '<div class="background-operation-heading"><strong></strong><button class="btn-outline" data-action="close">×</button></div><p></p><progress></progress><small></small><div class="background-operation-actions"></div>';
        container.append(card);
      }
      card.dataset.state = view.state;
      card.querySelector('strong').textContent = view.title;
      card.querySelector('p').textContent = view.text;
      const meter = card.querySelector('progress');
      meter.max = 100; meter.setAttribute('aria-label', view.title);
      if (Number.isFinite(view.percent)) meter.value = view.percent; else meter.removeAttribute('value');
      meter.hidden = !activeStates.includes(view.state);
      const quiet = view.quiet >= 15000 && view.state === 'running';
      card.dataset.quiet = String(quiet);
      card.querySelector('small').textContent = (view.elapsed != null ? t('exportProgress.elapsed', { time: clock(view.elapsed / 1000) }) : '') +
        (quiet ? ' · ' + t('background.quiet', { seconds: Math.floor(view.quiet / 1000) }) : '');
      const close = card.querySelector('[data-action=close]');
      close.hidden = activeStates.includes(view.state); close.setAttribute('aria-label', t('close'));
      close.onclick = () => { dismissed.add(key); card.remove(); render(); };
      const actions = card.querySelector('.background-operation-actions');
      // Keep buttons stable while progress advances, preserving keyboard focus.
      for (const [action, label] of [['details', 'background.details'], ['cancel', 'background.cancel'], ['reveal', 'background.reveal']]) {
        let button = actions.querySelector('[data-action=' + action + ']');
        if (!view[action]) { button?.remove(); continue; }
        if (!button) { button = document.createElement('button'); button.dataset.action = action; button.className = 'btn-outline'; actions.append(button); }
        button.textContent = t(label); button.onclick = view[action];
        button.disabled = action === 'cancel' && (view.state === 'cancelling' || view.canCancel === false);
      }
    }
    for (const card of [...container.children]) if (!records.has(card.dataset.operation) || dismissed.has(card.dataset.operation)) card.remove();
    container.hidden = !container.childElementCount;
  }
  function setLocal(key, read) { dismissed.delete(key); records.set(key, { read, shared: false }); render(); }
  function receive(roomId, operation) {
    if (roomId !== currentRoom || !operation || !/^[a-zA-Z0-9_-]{1,80}$/.test(operation.id)) return;
    if (boundRoom !== currentRoom) render();
    const key = 'scene-' + operation.id, old = records.get(key);
    if (old ? old.revision >= operation.revision : operation.revision < latestRevision) return;
    latestRevision = Math.max(latestRevision, operation.revision);
    const received = performance.now();
    records.set(key, { shared: true, revision: operation.revision, read: () => {
      const running = operation.state === 'running', age = performance.now() - received;
      let quiet = running ? (operation.quietMs || 0) + age : 0;
      const localUpload = running && amHost() && typeof customImportStatus !== 'undefined' &&
        customImportStatus?.requestId === operation.id && customImportStatus.phase === 'upload' ? customImportStatus : null;
      if (localUpload) quiet = Math.max(0, performance.now() - (localUpload.lastAdvance || received));
      const state = running && (!socket.connected || !sharedConfirmed) ? 'reconnecting' : operation.state;
      return {
        title: t('background.scene'), state,
        percent: state === 'reconnecting' ? null : localUpload ? localUpload.percent : operation.percent,
        quiet, elapsed: (operation.elapsedMs || 0) + (running ? age : 0),
        text: t(state === 'reconnecting' ? 'background.reconnecting' : running ? 'background.stage.' + operation.stage : 'background.scene.' + state) +
          (running && operation.backend ? ' · ' + t(operation.backend === 'cpu-fallback' ? 'acceleration.fallback' : operation.backend === 'gpu' ? 'acceleration.gpu' : 'acceleration.cpu') : ''),
        details: () => { openFilesModal(); switchFilesTab(operation.section); },
        cancel: running && socket.connected && sharedConfirmed && operation.cancellable && amHost() && typeof customImportRequest !== 'undefined' && customImportRequest?.id === operation.id ? () => cancelCustomImport() : null
      };
    } });
    // Match the server's bounded recent history instead of retaining every old scene card.
    const shared = [...records].filter(([, record]) => record.shared).sort((a, b) => b[1].revision - a[1].revision);
    for (const [expired] of shared.slice(2)) { records.delete(expired); dismissed.delete(expired); }
    render();
  }
  socket.on('scene_operation', data => receive(data?.roomId, data?.operation));
  socket.on('scene_operations', data => {
    if (data?.roomId !== currentRoom) return;
    if (boundRoom !== currentRoom) render();
    sharedConfirmed = true;
    const ids = new Set((data.operations || []).map(operation => 'scene-' + operation.id));
    for (const [key, record] of records) if (record.shared && !ids.has(key)) { records.delete(key); dismissed.delete(key); }
    for (const operation of data.operations || []) receive(data.roomId, operation);
    render();
  });
  socket.on('session_updated', render); socket.on('disconnect', () => { sharedConfirmed = false; render(); }); socket.on('connect', render);
  window.addEventListener('resize', render); window.addEventListener('dubline-language-changed', render);
  new ResizeObserver(render).observe(document.querySelector('header')); setInterval(render, 1000);
  window.DublineBackgroundOperations = { setLocal, refresh: render };
})();
