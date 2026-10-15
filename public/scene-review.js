(() => {
  const model = DublineSceneReviewModel, availability = new Map(), processing = new Map(); let sceneId = null, sourceIssues = [], sourceKey = '', checking = false, focus = null, queued = false;
  const badge = document.createElement('button'); badge.id = 'sceneReviewBtn'; badge.className = 'btn-outline'; badge.type = 'button'; document.querySelector('.timeline-filters').append(badge);
  const dialog = document.createElement('dialog'); dialog.id = 'sceneReviewDialog'; dialog.className = 'modal-card fx-dialog'; dialog.setAttribute('aria-labelledby', 'sceneReviewTitle');
  dialog.innerHTML = '<header class="fx-header"><div class="modal-header-row"><h2 id="sceneReviewTitle" data-i18n="review.title"></h2><button id="sceneReviewClose" type="button" class="btn-icon" data-i18n-title="close">×</button></div><p id="sceneReviewSummary"></p></header><div class="fx-body"><p class="setting-sub" data-i18n="review.help"></p><div id="sceneReviewIssues" class="review-issues"></div></div><footer class="fx-footer"><button id="sceneReviewCheck" type="button" class="btn-outline" data-i18n="review.checkFiles"></button><p id="sceneReviewStatus" class="setting-sub" role="status"></p></footer>';
  document.body.append(dialog); const $ = id => document.getElementById(id);
  const size = observeDialogZoom(dialog);
  function scoped() { if (sceneId !== session?.activeSessionId) { sceneId = session?.activeSessionId; availability.clear(); processing.clear(); sourceIssues = []; sourceKey = ''; } const sources = DublineProjectAudio.sources(session || {}), key = JSON.stringify([session?.videoUrl, sources.original, sources.backing]); if (key !== sourceKey) { sourceIssues = []; sourceKey = key; } }
  function processingSignature(line) { const scene = session || {}; return JSON.stringify([line.audioUrl, DublineVoiceChain.key(DublineVoiceChain.resolve(line, scene)), DublineNoiseModel.settingKey(Object.hasOwn(line, '_exportNoise') ? line._exportNoise : DublineNoiseModel.resolve(line, scene)), line.trimEnabled !== false, line.trimStart, line.trimEnd, Object.hasOwn(line, '_exportLevel') ? line._exportLevel : DublineProjectAudio.normalize(scene).normalizeVoices]); }
  function snapshot(scene = session) {
    scoped(); const quality = {}, failures = {};
    for (const line of scene?.lines || []) if (canHearLine(line) && processing.has(processingSignature(line))) failures[line.id] = true;
    for (const line of scene?.lines || []) if (canHearLine(line)) { const known = window.DublineTakeAnalysis?.known?.(line); if (known) quality[line.audioUrl] = known; }
    return model.inspect(scene, { allow: canHearLine, quality, availability: Object.fromEntries(availability), processing: failures, sources: sourceIssues.map(source => ({ ...source, resource: t('review.source.' + source.resource) })), pending: liveRecordings.size + pendingTakeLines.size + processingRecordings.size + editorQueue.length + (recordState !== 'idle' && !liveRecordings.size ? 1 : 0) });
  }
  function paint() {
    scoped(); badge.hidden = !session?.loaded; const recorded = (session?.lines || []).filter(line => line.audioUrl).length; badge.textContent = t('review.summary', { n: recorded, total: session?.lines?.length || 0 }); badge.title = t('review.title');
    if (!dialog.open) return; const report = snapshot(); $('sceneReviewSummary').textContent = t('review.summary', { n: report.recorded, total: report.total }) + ' · ' + t('review.retakes', { n: report.retakes }); $('sceneReviewIssues').replaceChildren();
    for (const issue of report.issues) {
      const row = document.createElement('div'); row.className = 'review-issue'; const text = document.createElement('span'); text.textContent = t(issue.key, issue.params); row.append(text);
      if (issue.lineId != null) { const button = document.createElement('button'); button.className = 'btn-outline'; button.textContent = '#' + issue.lineId + ' · ' + t('review.go'); button.onclick = () => { const line = session.lines.find(line => line.id === issue.lineId); close(); if (line) { closeFilesModal(); if (!window.revealTimelineLine?.(line.id)) selectLine(line); } }; row.append(button); }
      $('sceneReviewIssues').append(row);
    }
    if (!report.issues.length) $('sceneReviewIssues').textContent = t('review.ready'); $('sceneReviewCheck').disabled = checking || !socket.connected;
  }
  async function checkFiles() {
    if (checking || !session?.loaded) throw Error(t('review.checking')); scoped(); const id = sceneId; checking = true; $('sceneReviewStatus').textContent = t('review.checking'); paint();
    try { const response = await fetch('/api/scene-review?' + new URLSearchParams({ room: currentRoom, clientId, sessionId: id })); if (!response.ok) throw Error(await readError(response)); const result = await response.json(); if (id !== session.activeSessionId) return;
      availability.clear(); sourceIssues = (result.sources || []).filter(source => source.status !== 'ready').map(source => ({ key: source.status === 'missing' ? 'review.sourceFile' : 'review.sourceTemporary', severity: source.status === 'missing' ? 'error' : 'warning', resource: source.channel })); for (const take of result.takes || []) { const line = session.lines.find(line => line.id === take.lineId); if (line?.takeId === take.takeId && canHearLine(line)) { availability.set(line.audioUrl, take.status); if (take.quality) window.DublineTakeAnalysis?.receive(line.audioUrl, take.quality); } }
      $('sceneReviewStatus').textContent = t('review.checked'); const source = (result.sources || []).find(source => source.status !== 'ready'); if (source) $('sceneReviewStatus').textContent = t('review.missingSource');
    } catch (error) { if (id === session?.activeSessionId) $('sceneReviewStatus').textContent = error.message; throw error; }
    finally { checking = false; paint(); }
  }
  function close() { dialog.close(); focus?.isConnected && focus.focus(); }
  badge.onclick = () => { if (document.querySelector('dialog[open]')) return; focus = document.activeElement; dialog.showModal(); paint(); $('sceneReviewCheck').focus(); };
  $('sceneReviewClose').onclick = close; $('sceneReviewCheck').onclick = () => checkFiles().catch(() => {}); dialog.oncancel = event => { event.preventDefault(); close(); };
  function schedule() { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; if (sceneId && sceneId !== session?.activeSessionId && dialog.open) close(); paint(); }); } }
  for (const event of ['session_updated', 'line_updated', 'takes_updated', 'voice_updated', 'voice_presets_updated', 'editor_lines_updated', 'recording_state', 'disconnect']) socket.on(event, schedule);
  window.addEventListener('dubline-language-changed', () => { DublineI18n.apply(dialog); if (!checking) $('sceneReviewStatus').textContent = ''; paint(); });
  window.DublineSceneReview = { snapshot, checkFiles, refresh: schedule, processingError: (line, error) => { scoped(); const key = processingSignature(line); const previous = processing.has(key); if (error) { processing.set(key, true); if (processing.size > 1024) processing.delete(processing.keys().next().value); } else processing.delete(key); if (previous !== !!error) schedule(); } };
  DublineI18n.apply(dialog); paint(); window.addEventListener('pagehide', () => size.disconnect());
})();
