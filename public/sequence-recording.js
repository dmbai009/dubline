(() => {
  let enabled = false, sceneId = null, candidate = null, skipped = new Set(), message = '', queued = false;
  const area = document.createElement('details'); area.id = 'sequenceRecording'; area.className = 'sequence-recording'; area.innerHTML = '<summary data-i18n="sequence.title"></summary><div class="sequence-content"><label><span data-i18n="sequence.enable"></span><span class="switch-ui"><input id="sequenceEnable" type="checkbox"><span class="switch-slider"></span></span></label><select id="sequenceMode"><option value="missing" data-i18n="sequence.missing"></option><option value="retake" data-i18n="sequence.retake"></option><option value="filter" data-i18n="sequence.filter"></option></select><p class="setting-sub" data-i18n="sequence.help"></p><div class="insp-actions"><button id="sequenceListen" type="button" class="btn-outline" data-i18n="sequence.listen"></button><button id="sequenceNext" type="button" class="btn-play"></button><button id="sequenceSkip" type="button" class="btn-outline" data-i18n="sequence.skip"></button></div><p id="sequenceStatus" role="status" class="setting-sub"></p></div>'; document.querySelector('.timeline-filters').append(area);
  const $ = id => document.getElementById(id), busy = () => recordState !== 'idle' || renderInProgress || window.snapshotFrozen || pendingTakeLines.size > 0 || processingRecordings.size > 0;
  function paint() {
    if (sceneId !== session?.activeSessionId) { sceneId = session?.activeSessionId; candidate = null; skipped.clear(); message = ''; }
    const own = selectedLine && getLineOwner(selectedLine) === myName, confirmed = candidate && own && selectedLine.id === candidate.lineId && selectedLine.audioUrl === candidate.audioUrl;
    area.hidden = !session?.loaded; $('sequenceEnable').checked = enabled; $('sequenceMode').disabled = !enabled || busy(); $('sequenceMode').setAttribute('aria-label', t('sequence.mode')); $('sequenceEnable').setAttribute('aria-label', t('sequence.enable'));
    $('sequenceNext').textContent = t(confirmed ? 'sequence.keepNext' : 'sequence.next'); $('sequenceNext').disabled = !enabled || busy() || !socket.connected;
    $('sequenceListen').disabled = !enabled || !confirmed || busy() || !canHearLine(selectedLine); $('sequenceSkip').disabled = !enabled || !own || busy(); $('sequenceStatus').textContent = t(message || (!enabled ? 'sequence.off' : candidate && !confirmed ? 'sequence.waiting' : 'sequence.help'));
  }
  function next(reset = false) {
    if (!enabled || busy() || !socket.connected) return;
    const line = DublineSequenceModel.next(session.lines, reset ? null : selectedLine?.id, { nick: myName, owner: getLineOwner, visible: DublineTimelineFilters.visible, mode: $('sequenceMode').value, skipped });
    candidate = null; audio.stopPreview(); if (line) { revealTimelineLine(line.id); message = ''; } else message = 'sequence.end'; paint();
  }
  function refresh() { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; paint(); }); } }
  $('sequenceEnable').onchange = () => { enabled = $('sequenceEnable').checked; candidate = null; skipped.clear(); if (enabled) { const selected = selectedLine && getLineOwner(selectedLine) === myName; if (!selected) next(true); } paint(); };
  $('sequenceMode').onchange = () => { candidate = null; message = ''; paint(); }; $('sequenceNext').onclick = () => next();
  $('sequenceSkip').onclick = () => { if (selectedLine && getLineOwner(selectedLine) === myName && !busy()) { skipped.add(selectedLine.id); next(); } };
  $('sequenceListen').onclick = async () => { if (!candidate || busy() || selectedLine?.id !== candidate.lineId || !canHearLine(selectedLine)) return; await audio.previewTake(selectedLine).catch(() => { message = 'quality.previewFailed'; paint(); }); };
  window.DublineSequence = { refresh, saved: (entry, result) => { if (enabled && !result.superseded && entry.sessionId === session?.activeSessionId && entry.lineId === selectedLine?.id && getLineOwner(selectedLine) === myName) { candidate = { lineId: entry.lineId, audioUrl: result.audioUrl }; message = ''; refresh(); } }, state: () => ({ enabled, candidate: candidate && { ...candidate }, skipped: [...skipped] }) };
  for (const event of ['session_updated', 'line_updated', 'takes_updated', 'recording_state', 'nick_state', 'room_users_updated', 'disconnect']) socket.on(event, refresh);
  window.addEventListener('dubline-language-changed', () => { DublineI18n.apply(area); paint(); }); DublineI18n.apply(area); paint();
})();
