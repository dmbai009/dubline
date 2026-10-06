(() => {
  let remote = [], signature = '', frame = null;
  window.publishSelection = () => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (!socket.connected || !session?.loaded || session.singlePlayer || !myName) return;
      const lineIds = [...(multiSelection.size ? multiSelection : selectedLine ? [selectedLine.id] : [])]
        .filter(id => session.lines.some(line => line.id === id)).sort((a, b) => a - b);
      const next = JSON.stringify([socket.id, session.activeSessionId, lineIds]);
      if (next === signature) return;
      signature = next;
      socket.volatile.emit('selection_update', { sessionId: session.activeSessionId, lineIds });
    });
  };
  window.renderRemoteSelection = block => {
    block.querySelector('.remote-selection-markers')?.remove();
    const id = Number(block.id.replace('line-block-', ''));
    const actors = remote.filter(actor => actor.actorId !== socket.id && actor.sessionId === session?.activeSessionId && actor.lineIds.includes(id));
    if (!actors.length) return;
    const markers = document.createElement('div'); markers.className = 'remote-selection-markers';
    for (const actor of actors) {
      const chip = document.createElement('span'); chip.textContent = actor.nick; chip.title = actor.nick;
      chip.style.setProperty('--player-color', playerColor(actor.nick)); markers.appendChild(chip);
    }
    block.appendChild(markers);
  };
  window.refreshRemoteSelections = () => document.querySelectorAll('.line-block').forEach(renderRemoteSelection);
  socket.on('selection_presence', data => {
    remote = data.sessionId === session?.activeSessionId ? data.selections : [];
    refreshRemoteSelections();
  });
  socket.on('disconnect', () => { remote = []; signature = ''; refreshRemoteSelections(); });
  socket.on('session_updated', () => {
    remote = remote.filter(actor => actor.sessionId === session?.activeSessionId);
    refreshRemoteSelections(); publishSelection();
  });
})();
