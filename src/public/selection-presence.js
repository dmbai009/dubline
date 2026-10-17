(() => {
  let remote = [], signature = '', frame = null, sequence = 0, version = -1, epoch = null, rendered = '';
  const oldEpochs = new Set();
  window.publishSelection = (force = false) => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (!socket.connected || !session?.loaded || session.singlePlayer || !myName) return;
      const ids = new Set(session.lines.map(line => line.id));
      const lineIds = [...(multiSelection.size ? multiSelection : selectedLine ? [selectedLine.id] : [])].filter(id => ids.has(id)).sort((a, b) => a - b);
      const next = JSON.stringify([socket.id, session.activeSessionId, lineIds]);
      if (next === signature && (!force || !lineIds.length)) return;
      signature = next;
      // Reliable clears plus a short lease heal lost packets and suspended tabs.
      (lineIds.length ? socket.volatile : socket).emit('selection_update', { sessionId: session.activeSessionId, lineIds, seq: ++sequence });
    });
  };
  window.renderRemoteSelection = block => {
    block.querySelector('.remote-selection-markers')?.remove();
    const id = Number(block.id.replace('line-block-', ''));
    const actors = remote.filter(actor => actor.actorId !== socket.id && actor.sessionId === session?.activeSessionId && actor.expires > performance.now() && actor.ids.has(id));
    if (!actors.length) return;
    const markers = document.createElement('div'); markers.className = 'remote-selection-markers';
    for (const actor of actors) {
      const chip = document.createElement('span'); chip.textContent = actor.nick; chip.title = actor.nick;
      chip.style.setProperty('--player-color', playerColor(actor.nick)); markers.appendChild(chip);
    }
    block.appendChild(markers);
  };
  window.refreshRemoteSelections = () => document.querySelectorAll('.line-block').forEach(renderRemoteSelection);
  function refresh() {
    const next = JSON.stringify(remote.map(actor => [actor.actorId, actor.nick, actor.lineIds]));
    if (next === rendered) return;
    rendered = next; refreshRemoteSelections();
  }
  socket.on('selection_presence', data => {
    if (data?.sessionId !== session?.activeSessionId || !Array.isArray(data.selections)) return;
    if (data.epoch) {
      if (oldEpochs.has(data.epoch) || data.epoch === epoch && data.version <= version) return;
      if (epoch && epoch !== data.epoch) { oldEpochs.add(epoch); version = -1; }
      while (oldEpochs.size > 8) oldEpochs.delete(oldEpochs.values().next().value);
      epoch = data.epoch; version = data.version;
    }
    remote = data.selections.map(actor => ({ ...actor, ids: new Set(actor.lineIds), expires: performance.now() + Math.max(0, Math.min(6000, actor.ttlMs ?? 6000)) }));
    refresh();
  });
  socket.on('disconnect', () => { remote = []; signature = ''; version = -1; refresh(); });
  socket.on('session_updated', () => {
    remote = remote.filter(actor => actor.sessionId === session?.activeSessionId);
    refresh(); publishSelection();
  });
  let heartbeat, expiry;
  function start() {
    clearInterval(heartbeat); clearInterval(expiry);
    heartbeat = setInterval(() => { if (!document.hidden) publishSelection(true); }, 2000);
    expiry = setInterval(() => { remote = remote.filter(actor => actor.expires > performance.now()); refresh(); }, 1000);
  }
  start();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) publishSelection(true); });
  window.addEventListener('pagehide', () => { clearInterval(heartbeat); clearInterval(expiry); cancelAnimationFrame(frame); frame = null; });
  window.addEventListener('pageshow', event => { if (event.persisted) { start(); publishSelection(true); } });
})();
