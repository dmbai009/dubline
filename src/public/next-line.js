(() => {
  const button = document.createElement('button'); button.id = 'nextUnrecordedLine'; button.type = 'button'; button.className = 'btn-play';
  document.querySelector('.timeline-filters').append(button);
  let queued = false;
  const busy = () => recordState !== 'idle' || renderInProgress || window.snapshotFrozen || pendingTakeLines.size > 0 || processingRecordings.size > 0 || watchMode && !amHost();
  const candidate = () => DublineNextLineModel.next(session?.lines || [], selectedLine?.id, { nick: myName, owner: getLineOwner, available: line => !liveRecordings.has(line.id) });
  function paint() { button.hidden = !session?.loaded; button.textContent = t('nextLine.title'); button.title = t('nextLine.help'); button.disabled = !socket.connected || busy() || !candidate(); }
  function refresh() { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; paint(); }); } }
  button.onclick = () => { if (busy() || !socket.connected) return; const line = candidate(); if (line) { audio.stopPreview(); revealTimelineLine(line.id); if (studioCanTransport()) video.currentTime = line.start; } paint(); };
  window.DublineNextLine = { refresh };
  for (const event of ['session_updated', 'line_updated', 'takes_updated', 'recording_state', 'nick_state', 'room_users_updated', 'disconnect', 'watch_start', 'watch_stop']) socket.on(event, refresh);
  window.addEventListener('dubline-language-changed', refresh); paint();
})();
