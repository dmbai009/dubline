// ==========================================
function editorVideoDuration() {
  const actual = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
  const saved = Number.isFinite(session?.videoDuration) && session.videoDuration > 0 ? session.videoDuration : Infinity;
  return Math.min(actual, saved, 43200);
}
// COLLABORATIVE EDIT MODE
// Dub mode only shifts recorded takes. Edit mode changes source lines and tracks.
// ==========================================
function updateModeUi() {
  const editing = !!session && session.mode === 'edit';
  document.body.classList.toggle('edit-mode', editing);
  document.getElementById('editModeBtn').classList.toggle('active', editing);
  document.getElementById('dubModeBtn').classList.toggle('active', !editing);
  document.querySelectorAll('#modeSwitch button').forEach(button => { button.disabled = !canModerate(); });
  const protect = document.getElementById('protectTimingsBtn');
  protect.disabled = !canModerate(); protect.setAttribute('aria-pressed', String(session?.protectTimings === true));
  protect.textContent = t(session?.protectTimings ? 'editor.timingsProtected' : 'editor.protectTimings');
  protect.title = t('editor.protectTimingsHelp');
  document.getElementById('addEditorLineBtn').disabled = session?.protectTimings === true;
  document.querySelector('.toolbar-hint').textContent = t(editing ? 'timeline.editHint' : 'timeline.hint');
}

window.setStudioMode = async function(mode) {
  if (!canModerate() || !['edit', 'dub'].includes(mode) || !session || session.mode === mode) return;
  const sessionId = session.activeSessionId, deadline = Date.now() + 8000;
  while (editorQueue.length && socket.connected && session?.activeSessionId === sessionId && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  if (!socket.connected || session?.activeSessionId !== sessionId || !canModerate()) return;
  if (editorQueue.length || editorConflicts.some(entry => entry.sessionId === sessionId)) return showToast(t('editor.rejected'));
  socket.emit('set_session_mode', { mode, sessionId });
};

window.toggleProtectTimings = function() {
  if (!canModerate() || session?.mode !== 'edit') return;
  socket.volatile.timeout(5000).emit('set_protect_timings', { sessionId: session.activeSessionId, enabled: !session.protectTimings }, (error, result) => {
    if (error || !result?.ok) showToast(t('editor.rejected'));
  });
};

// Edit Mode opened during a recording: stop it and keep the take. The server accepts it
// once Dub Mode is back; until then it waits in the upload queue like any unsent take.
let lastSessionMode = null;
function watchModeChange() {
  const mode = session && session.mode;
  if (lastSessionMode && mode && mode !== lastSessionMode && window.onRecordingModeChanged) {
    window.onRecordingModeChanged(mode);
  }
  if (mode === 'edit' && lastSessionMode && lastSessionMode !== 'edit' && recordState !== 'idle') {
    finishRecording();
    showToast(t('editor.modeStoppedRecording'));
  }
  lastSessionMode = mode || null;
}

socket.on('session_updated', () => {
  watchModeChange();
  updateModeUi();
});

function applyEditorLines(lines, ownConfirmation = false) {
  if (!session || !Array.isArray(session.lines) || !Array.isArray(lines)) return;
  const gesture = window.activeEditorGesture;
  const touchesGesture = gesture && lines.some(line => {
    if (!gesture.lineIds.has(line.id)) return false;
    const previous = editorAuthoritative.get(line.id);
    return !previous || ['start', 'end', ...(gesture.type === 'move' ? ['character'] : [])].some(field => previous[field] !== line[field]);
  });
  for (const operation of editorQueue) operation.coalesce = null; // incoming authoritative boundary
  lines.forEach(line => {
    const previous = editorAuthoritative.get(line.id);
    if (!previous || Number(line.revision || 0) >= Number(previous.revision || 0)) editorAuthoritative.set(line.id, { ...line });
  });
  rebuildEditorOverlay();
  // A confirmation of our preceding edit may arrive during the next gesture.
  // Preserve it only when replayed visible semantic bases still match exactly.
  if (touchesGesture && (!ownConfirmation || [...gesture.baseFields].some(([id, base]) => {
    const visible = session.lines.find(line => line.id === id);
    return !visible || ['start', 'end', ...(gesture.type === 'move' ? ['character'] : [])].some(field => visible[field] !== base[field]);
  }))) cancelEditorGesture('conflict');
  refreshEditorTimeline(lines);
  updatePrompter();
  if (selectedLine && lines.some(line => line.id === selectedLine.id)) showInspector(selectedLine);
}

socket.on('editor_lines_updated', (lines, metadata) => {
  if (metadata?.actorClientId === clientId && metadata.sessionId === session?.activeSessionId) {
    const applied = editorQueue.find(operation => operation.id === metadata.operationId);
    if (applied?.mutationLease) { window.releaseEditLease(applied.mutationLease); applied.mutationLease = null; }
  }
  if (!window.acceptSceneDelta(metadata?.sessionId, lines)) return;
  if (!acceptSessionProtocol(metadata?.editorProtocol)) return;
  const ownConfirmation = metadata?.actorClientId === clientId && editorQueue.some(operation => operation.id === metadata.operationId);
  applyEditorLines(lines, ownConfirmation);
});

function editorResult(result) {
  if (result && result.ok) return true;
  if (!result) {
    showToast(t('editor.rejected'));
    return false;
  }
  if (result.reason === 'conflict' && (result.lines || result.line)) {
    if (acceptSessionProtocol(result.editorProtocol)) applyEditorLines(result.lines || [result.line]);
    showToast(t('editor.conflict'));
  } else if (result.reason === 'timeout') {
    showToast(t('editor.timeout'));
  } else if (result.reason === 'cancelled' || result.reason === 'session') {
    showToast(t('editor.cancelled'));
  } else if (result.reason === 'exists') {
    showToast(t('editor.trackExists'));
  } else if (result.reason === 'caption') {
    showToast(t('editor.captionTooLong'));
  } else {
    showToast(t('editor.rejected'));
  }
  return false;
}

// Authoritative data is never modified by optimistic edits. Requests capture the
// state the user saw, once; retries reuse that payload and operationId verbatim.
const editorQueue = [];
const editorConflicts = [];
const editorAuthoritative = new Map((session?.lines || []).map(line => [line.id, { ...line }]));
let editorScene = session?.activeSessionId;
let editorProtocolReceivedAt = performance.now();
let editorPumping = false;
let editorRetryTimer = null;
let editorNeedsResync = false;
const EDITOR_ACK_TIMEOUT_MS = 10000;
const editorIntentStore = window.DublineLocalDatabase.store('pendingEditorOperations');
let editorPersistence = Promise.resolve();
let restoredEditorRecords = null;
let editorRecoveryLoading = false;
function persistEditorOperation(operation, remove = false) {
  const record = remove ? null : structuredClone({ id: operation.id, event: operation.event, payload: operation.payload,
    request: operation.request, sessionId: operation.sessionId, roomId: operation.roomId, clientId: operation.clientId,
    status: operation.status, sent: !!operation.sent, targetBases: [...operation.targetBases], createdAt: operation.createdAt || Date.now(), replacesId: operation.replacesId });
  // Serialize writes so a late put cannot resurrect a confirmed/discarded record.
  editorPersistence = editorPersistence.then(() => remove ? editorIntentStore.remove(operation.id) : operation.replacesId ? editorIntentStore.replace(operation.replacesId, record) : editorIntentStore.put(record))
    .then(() => true).catch(error => { console.warn('[DubLine] Editor recovery is memory-only:', error); return false; });
  return editorPersistence;
}
async function restoreEditorOperations() {
  if (editorRecoveryLoading || !myName || !session?.editorProtocol || !socket.connected) return;
  editorRecoveryLoading = true;
  try {
    if (!restoredEditorRecords) restoredEditorRecords = await editorIntentStore.all();
    for (const record of [...restoredEditorRecords]) {
      if (record.clientId !== clientId || record.roomId !== currentRoom) continue;
      restoredEditorRecords.splice(restoredEditorRecords.indexOf(record), 1);
      if (editorQueue.some(item => item.id === record.id) || editorConflicts.some(item => item.id === record.id)) continue;
      const operation = { ...record, targetBases: new Map(record.targetBases || []), coalesce: null };
      operation.promise = new Promise(resolve => { operation.resolve = resolve; });
      const patches = editorUpdates(operation);
      const currentScene = operation.sessionId === session.activeSessionId;
      const expired = record.request?.operationEpoch !== session.editorProtocol.epoch ||
        session.editorProtocol.serverTime - Number(record.request?.operationTime) > 30 * 60 * 1000;
      // Only an already-satisfied semantic patch may complete after receipt expiry.
      const satisfied = currentScene && patches.length && patches.every(patch => {
        const line = editorAuthoritative.get(patch.lineId);
        return line && ['caption', 'start', 'end', 'character'].every(field => patch[field] === undefined || line[field] === patch[field]);
      });
      if (expired && satisfied) { persistEditorOperation(operation, true); continue; }
      if (!currentScene || expired || operation.status === 'conflict' || (session.mode !== 'edit' && operation.event !== 'editor_add_track')) {
        operation.status = 'conflict'; editorConflicts.push(operation); persistEditorOperation(operation); continue;
      }
      operation.status = 'queued'; editorQueue.push(operation);
    }
    rebuildEditorOverlay(); renderEditorSyncState();
    if (editorQueue.length) scheduleEditorPump(0);
  } catch (error) { console.warn('[DubLine] Could not load editor recovery:', error); }
  finally { editorRecoveryLoading = false; }
}

function lineRevision(lineId) {
  const line = session.lines.find(item => item.id === lineId);
  return line ? line.revision || 0 : 0;
}

function editorUpdates(operation) {
  if (operation.event === 'editor_update_line') return [operation.payload];
  if (operation.event === 'editor_update_lines') return operation.payload.updates;
  return [];
}
function editorRevisionTargets(operation) {
  if (operation.event === 'set_line_character') return [operation.payload];
  if (Array.isArray(operation.payload.lines)) return operation.payload.lines;
  return editorUpdates(operation);
}

function rebuildEditorOverlay() {
  if (!session || session.activeSessionId !== editorScene) return;
  const visible = new Map([...editorAuthoritative].map(([id, line]) => [id, { ...line }]));
  for (const operation of editorQueue) {
    if (operation.sessionId !== editorScene) continue;
    for (const patch of editorUpdates(operation)) {
      const line = visible.get(patch.lineId);
      if (!line) continue;
      const delta = patch.start !== undefined ? patch.start - line.start : 0;
      for (const field of ['caption', 'start', 'end', 'character']) if (patch[field] !== undefined) line[field] = patch[field];
      if (delta) for (const field of ['audioStart', 'recordedStart']) if (line[field] != null) line[field] = Number((line[field] + delta).toFixed(3));
      if (patch.character !== undefined && patch.character !== patch.base?.character) line.claimedBy = null;
    }
  }
  session.lines = [...visible.values()].sort((a, b) => a.start - b.start || a.id - b.id);
  if (selectedLine) selectedLine = visible.get(selectedLine.id) || null;
}

window.acceptEditorSnapshot = function(data) {
  editorProtocolReceivedAt = performance.now();
  cancelEditorGesture();
  const changed = editorScene !== data.activeSessionId;
  if (changed) { editorDrafts.clear(); editorScene = data.activeSessionId; }
  editorAuthoritative.clear();
  for (const line of data.lines || []) editorAuthoritative.set(line.id, { ...line });
  for (const key of editorDrafts.keys()) if (!editorAuthoritative.has(Number(key.split(':').pop()))) editorDrafts.delete(key);
  const oldForm = inspector.querySelector('#editorLineForm');
  if (oldForm && (changed || !editorAuthoritative.has(Number(oldForm.dataset.draftKey.split(':').pop())))) {
    inspector.innerHTML = `<h3>${t('inspector.title')}</h3><p>${t('inspector.empty')}</p>`;
  }
  for (const operation of [...editorQueue]) {
    operation.coalesce = null;
    // Captured requests retain identity and epoch. A new server cannot blindly
    // replay a structural operation whose old receipt may already have applied.
    if (operation.request.operationEpoch !== data.editorProtocol?.epoch) {
      finishEditorOperation(operation, { ok: false, reason: 'expired' }); continue;
    }
    if (operation.roomId !== currentRoom || operation.clientId !== clientId || operation.sessionId !== editorScene || (data.mode !== 'edit' && operation.event !== 'editor_add_track')) {
      finishEditorOperation(operation, { ok: false, reason: operation.sessionId !== editorScene ? 'session' : 'mode' });
    }
  }
  rebuildEditorOverlay();
  renderEditorSyncState();
  // session_updated on reconnect arrives only after join_room has succeeded.
  if (socket.connected) { editorNeedsResync = false; scheduleEditorPump(0); }
  restoreEditorOperations();
};

function renderEditorSyncState() {
  const status = document.getElementById('editorSyncState');
  if (!status) return;
  status.hidden = !editorQueue.length && !editorConflicts.length;
  status.disabled = !editorConflicts.length;
  status.textContent = t(editorConflicts.length ? 'editor.syncConflict' : editorNeedsResync ? 'editor.syncing' : 'editor.pending', { n: editorConflicts.length || editorQueue.length });
  status.classList.toggle('conflict', !!editorConflicts.length);
  renderEditorConflicts();
}

let editorReviewBusy = false, editorReviewSummary = '';
function renderEditorConflicts() {
  const panel = document.getElementById('editorConflictPanel');
  if (panel.hidden) return;
  const scroll = panel.querySelector('.editor-conflict-list')?.scrollTop || 0;
  panel.innerHTML = `<div class="editor-conflict-actions"><button class="btn-play" data-review-all="keep" ${editorReviewBusy ? 'disabled' : ''}>${t('editor.keepAll')}</button><button class="btn-delete" data-review-all="discard" ${editorReviewBusy ? 'disabled' : ''}>${t('editor.discardAll')}</button></div><p role="status">${esc(editorReviewSummary)}</p><div class="editor-conflict-list">` + editorConflicts.map(operation => `<div class="editor-conflict-item">${editorIntentHtml(operation)}
    <button class="btn-play" data-retry-operation="${operation.id}" ${editorReviewBusy || operation.sessionId !== session?.activeSessionId || session?.mode !== 'edit' ? 'disabled' : ''}>${t('editor.keepMine')}</button>
    <button class="btn-outline" data-discard-operation="${operation.id}" ${editorReviewBusy ? 'disabled' : ''}>${t('editor.discardPending')}</button></div>`).join('') + '</div>';
  panel.querySelector('.editor-conflict-list').scrollTop = scroll;
}
window.reviewEditorConflicts = function() {
  const panel = document.getElementById('editorConflictPanel'); panel.hidden = !panel.hidden; renderEditorConflicts();
};

async function retryEditorConflict(operation, sceneId) {
  if (!socket.connected || session?.activeSessionId !== sceneId || operation.sessionId !== sceneId || session.mode !== 'edit' || operation.roomId !== currentRoom || operation.clientId !== clientId || !myName || window.snapshotFrozen) return false;
  if (!editorUpdates(operation).length) { showToast(t('editor.repeatAction')); return false; }
  if (editorQueue.length || !await resyncEditor() || session?.activeSessionId !== sceneId || session.mode !== 'edit') return false;
  const payload = structuredClone(operation.payload);
  for (const patch of editorUpdates({ ...operation, payload })) {
    const line = editorAuthoritative.get(patch.lineId);
    if (!line || session.protectTimings && (patch.start !== undefined && patch.start !== line.start || patch.end !== undefined && patch.end !== line.end)) return false;
    patch.revision = line.revision || 0; patch.base = editorBase(line);
  }
  const result = await Promise.race([queueEditorRequest(() => [operation.event, payload], { replacement: operation }), new Promise(resolve => setTimeout(() => resolve(null), 15000))]);
  return !!result?.ok;
}

async function resolveEditorConflicts(action, operations) {
  if (editorReviewBusy) return;
  if (action === 'discard' && !await askConfirm(t('editor.discardAllConfirm', { n: operations.length }), { danger: true })) return;
  editorReviewBusy = true; renderEditorConflicts();
  const sceneId = session?.activeSessionId;
  let applied = 0, discarded = 0;
  try {
    for (const operation of operations) {
      if (!editorConflicts.includes(operation)) continue;
      if (action === 'keep') {
        if (!socket.connected || session?.activeSessionId !== sceneId || session.mode !== 'edit' || editorQueue.length) break;
        if (await retryEditorConflict(operation, sceneId)) applied++;
      } else if (await persistEditorOperation(operation, true)) {
        const index = editorConflicts.indexOf(operation); if (index >= 0) editorConflicts.splice(index, 1); discarded++;
      }
    }
  } finally {
    editorReviewBusy = false;
    editorReviewSummary = t('editor.reviewSummary', { applied, discarded, remaining: editorConflicts.length + editorQueue.length });
    renderEditorSyncState(); renderEditorConflicts();
  }
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-review-all]');
  if (button && !button.disabled) resolveEditorConflicts(button.dataset.reviewAll, [...editorConflicts]);
});

function editorIntentHtml(operation) {
  const labels = { editor_create_line: 'editor.addLine', editor_update_line: 'editor.line', editor_update_lines: 'editor.line', editor_delete_lines: 'editor.delete', editor_add_track: 'editor.addTrack', editor_undo: 'editor.undo', set_line_character: 'editor.track', set_lines_character: 'editor.track', rename_character: 'editor.track' };
  const patches = editorUpdates(operation);
  const targets = patches.length ? patches : editorRevisionTargets(operation);
  const details = targets.map(patch => {
    const line = session?.lines.find(item => item.id === patch.lineId);
    const number = line ? lineNumber(line) : patch.lineId;
    return `<p><b>#${number}</b> ${esc(patch.caption ?? '')} ${patch.start !== undefined || patch.end !== undefined ? `${patch.start ?? patch.base?.start}–${patch.end ?? patch.base?.end}s` : ''} ${esc(patch.character ?? operation.payload.character ?? '')}</p>`;
  }).join('') || `<p>${esc(operation.payload.from || '')} ${operation.payload.to ? '→ ' + esc(operation.payload.to) : ''}${esc(operation.payload.character || '')} ${esc(operation.payload.caption || '')}</p>`;
  return `<b>${esc(t(labels[operation.event] || 'editor.line'))}</b>${operation.sessionId !== session?.activeSessionId ? `<p>${t('editor.otherScene')}</p>` : ''}${details}`;
}
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-retry-operation], [data-discard-operation]');
  if (!button || button.disabled) return;
  const id = button.dataset.retryOperation || button.dataset.discardOperation;
  const operation = editorConflicts.find(item => item.id === id);
  if (!operation || editorReviewBusy) return;
  if (button.dataset.retryOperation) {
    await resolveEditorConflicts('keep', [operation]); return;
  }
  if (!await persistEditorOperation(operation, true)) return;
  const index = editorConflicts.indexOf(operation); if (index >= 0) editorConflicts.splice(index, 1);
  renderEditorSyncState();
  renderEditorConflicts();
});

function editorBase(line) {
  return { caption: line.caption, start: line.start, end: line.end, character: line.character };
}

function scheduleEditorPump(delay = 1000) {
  clearTimeout(editorRetryTimer);
  editorRetryTimer = setTimeout(pumpEditorQueue, delay);
}

function resyncEditor() {
  if (!socket.connected) return Promise.resolve(false);
  return new Promise(resolve => {
    // Volatile requests cannot survive offline in Socket.IO's outgoing buffer.
    socket.volatile.timeout(EDITOR_ACK_TIMEOUT_MS).emit('editor_resync', {}, (err, result) => {
      if (err || !result || !result.ok) return resolve(false);
      applySessionUpdate(result.session);
      watchModeChange();
      updateModeUi();
      if (typeof renderBlindSettings === 'function') renderBlindSettings();
      editorNeedsResync = false;
      resolve(true);
    });
  });
}

function finishEditorOperation(operation, result) {
  const index = editorQueue.indexOf(operation);
  if (index === -1) return;
  editorQueue.splice(index, 1);
  if (result?.ok) {
    const lines = result.lines || (result.line ? [result.line] : []);
    for (const next of editorQueue) {
      if (next.sent) continue;
      for (const patch of editorRevisionTargets(next)) {
        const line = lines.find(item => item.id === patch.lineId);
        const base = patch.base || next.targetBases.get(patch.lineId);
        if (line && base && Object.entries(base).every(([field, value]) => line[field] === value)) patch.revision = line.revision || 0;
      }
      next.request = { ...next.request, ...next.payload };
      persistEditorOperation(next);
    }
  }
  if (!result?.ok) { operation.status = 'conflict'; editorConflicts.push(operation); }
  persistEditorOperation(operation, !!result?.ok);
  operation.resolve(result);
}

async function pumpEditorQueue() {
  if (editorPumping || !editorQueue.length || !socket.connected) return;
  editorPumping = true;
  let mutationLease = null;
  try {
    if (editorNeedsResync && !await resyncEditor()) return;
    const operation = editorQueue[0];
    if (!operation) return;
    if (operation.status === 'persisting') return;
    if (operation.roomId !== currentRoom || operation.clientId !== clientId || operation.sessionId !== session?.activeSessionId || (session.mode !== 'edit' && operation.event !== 'editor_add_track')) {
      finishEditorOperation(operation, { ok: false, reason: 'session' }); return;
    }
    if (!operation.sent && session.mode === 'edit' && window.editorLeaseTargets) {
      const targets = window.editorLeaseTargets(operation.event, operation.payload);
      if (targets.length) {
        mutationLease = await window.acquireEditLease(targets);
        operation.mutationLease = mutationLease;
        if (!editorQueue.includes(operation)) return;
        if (!mutationLease) { finishEditorOperation(operation, { ok: false, reason: 'locked' }); return; }
      }
    }
    operation.status = 'in-flight';
    operation.sent = true;
    await persistEditorOperation(operation);
    const result = await new Promise(resolve => {
      socket.volatile.timeout(EDITOR_ACK_TIMEOUT_MS).emit(operation.event, operation.request, (err, value) => resolve(err ? null : value));
    });
    if (!editorQueue.includes(operation)) return; // scene/mode changed while ACK was pending
    if (!result) { operation.status = 'queued'; editorNeedsResync = true; return; }
    finishEditorOperation(operation, result);
    const lines = result.lines || (result.line ? [result.line] : []);
    if (lines.length && acceptSessionProtocol(result.editorProtocol)) applyEditorLines(lines, !!result.ok);
    else { rebuildEditorOverlay(); if (!result.ok || editorQueue.length) refreshEditorTimeline(session.lines); }
  } finally {
    window.releaseEditLease?.(mutationLease);
    editorPumping = false;
    renderEditorSyncState();
    if (editorQueue.length && socket.connected) scheduleEditorPump(editorNeedsResync ? 1000 : editorQueue[0].status === 'persisting' ? 100 : 0);
  }
}

function queueEditorRequest(build, options = {}) {
  if (window.snapshotFrozen) return Promise.resolve({ ok: false, reason: 'snapshot' });
  const [event, original] = build();
  const payload = structuredClone(original);
  const sessionId = session?.activeSessionId;
  const last = editorQueue.at(-1);
  // Only unsent keyboard bursts with the same selection and remote boundary coalesce.
  if (options.coalesce && last?.status === 'queued' && !last.sent && last.coalesce === options.coalesce && last.sessionId === sessionId && !editorNeedsResync) {
    const updates = editorUpdates({ event, payload });
    const previous = editorUpdates(last);
    if (updates.length === previous.length && updates.every((patch, i) => patch.lineId === previous[i].lineId)) {
      updates.forEach((patch, i) => { previous[i].start = patch.start; previous[i].end = patch.end; });
      last.request = { ...last.request, ...last.payload };
      persistEditorOperation(last);
      rebuildEditorOverlay(); renderTimeline(); scheduleEditorPump(80);
      return last.promise;
    }
  }
  const id = crypto.randomUUID?.() || [...crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16)).join('-');
  const operation = { id, event, payload, sessionId, roomId: currentRoom, clientId, status: options.replacement ? 'persisting' : 'queued', replacesId: options.replacement?.id, coalesce: options.coalesce, targetBases: new Map() };
  for (const target of editorRevisionTargets(operation)) {
    const line = session.lines.find(item => item.id === target.lineId);
    if (line) operation.targetBases.set(line.id, editorBase(line));
  }
  operation.request = { ...payload, sessionId, operationId: operation.id, operationEpoch: session?.editorProtocol?.epoch,
    operationTime: session?.editorProtocol?.serverTime ? session.editorProtocol.serverTime + performance.now() - editorProtocolReceivedAt : Date.now() };
  operation.promise = new Promise(resolve => { operation.resolve = resolve; });
  operation.createdAt = Date.now();
  editorQueue.push(operation);
  persistEditorOperation(operation).then(saved => {
    if (!options.replacement) return;
    if (!saved) {
      if (!editorQueue.includes(operation)) return;
      editorQueue.splice(editorQueue.indexOf(operation), 1); operation.resolve({ ok: false, reason: 'storage' });
      rebuildEditorOverlay(); renderTimeline(); renderEditorSyncState(); return;
    }
    const index = editorConflicts.indexOf(options.replacement); if (index >= 0) editorConflicts.splice(index, 1);
    if (!editorQueue.includes(operation)) { renderEditorConflicts(); return; }
    operation.status = 'queued'; renderEditorConflicts(); scheduleEditorPump(0);
  });
  // A selected clip moved into another role must remain visible after overlay redraw.
  if (selectedLine && editorUpdates(operation).some(patch => patch.lineId === selectedLine.id && patch.character !== undefined && patch.character !== selectedLine.character)) revealLineId = selectedLine.id;
  rebuildEditorOverlay(); renderTimeline(); renderEditorSyncState();
  if (!options.replacement) scheduleEditorPump(options.coalesce ? 80 : 0);
  return operation.promise;
}

function sendLineUpdates(changesById, options = {}) {
  if (session?.protectTimings && [...changesById].some(([id, patch]) => {
    const line = session.lines.find(item => item.id === id);
    return !line || patch.start !== undefined && Number(patch.start) !== line.start || patch.end !== undefined && Number(patch.end) !== line.end;
  })) { showToast(t('editor.timingsProtected')); return Promise.resolve({ ok: false, reason: 'timingsProtected' }); }
  return queueEditorRequest(() => {
    const updates = [...changesById].map(([lineId, changes]) => ({ lineId, revision: lineRevision(lineId), base: editorBase(session.lines.find(item => item.id === lineId)), ...changes }));
    return updates.length === 1 ? ['editor_update_line', updates[0]] : ['editor_update_lines', { updates }];
  }, options).then(result => {
    editorResult(result);
    return result;
  });
}

socket.on('disconnect', () => { editorNeedsResync = true; cancelEditorGesture(); clearTimeout(editorRetryTimer); renderEditorSyncState(); });
window.addEventListener('dubline-language-changed', renderEditorSyncState);
window.addEventListener('beforeunload', event => {
  if (!editorQueue.length && !editorConflicts.length) return;
  event.preventDefault(); event.returnValue = '';
});

function updateEditorLine(line, changes) {
  return sendLineUpdates(new Map([[line.id, changes]]));
}

// In Edit Mode anyone adds a role; while dubbing only the host can
function canAddTrack() {
  return !!session && session.loaded && (session.mode === 'edit' || amHost());
}

window.addEditorTrack = async function() {
  if (!canAddTrack()) return;
  const sessionId = session.activeSessionId;
  const name = await askText(t('editor.trackPrompt'));
  if (session.activeSessionId !== sessionId || !canAddTrack()) return;
  if (!name || !name.trim()) return;
  return queueEditorRequest(() => ['editor_add_track', { character: name.trim() }]).then(editorResult);
};

window.createLineAtPlayhead = function(character = '') {
  if (!session || session.mode !== 'edit' || session.protectTimings) return;
  const tracks = sessionCharacters();
  const selectedTrack = character || (selectedLine && selectedLine.character) || tracks[0];
  if (!selectedTrack) return addEditorTrack();
  return createEditorLineAt(selectedTrack, video.currentTime || 0);
};

window.createEditorLineAt = function(character, time) {
  if (!session || session.mode !== 'edit' || session.protectTimings || !session.loaded || !sessionCharacters().includes(character)) return;
  if (!Number.isFinite(time) || time < 0 || time > 43200) return;
  const bounds = window.DublineTimeline.create(time, editorVideoDuration());
  if (!bounds) return showToast(t('timeline.outsideCreate'));
  const { start, end } = bounds;
  const sessionId = session.activeSessionId;
  return queueEditorRequest(() => ['editor_create_line', { character, caption: '', start, end }]).then(result => {
    if (session.activeSessionId !== sessionId) return;
    if (!editorResult(result) || !result.line) return;
    revealLineId = result.line.id;
    clearMultiSelection();
    selectLine(result.line);
    renderTimeline();
    return result;
  });
};

// Drafts are scoped to a scene and line, never to the currently selected tile.
const editorDrafts = new Map();
const EDITOR_FORM_FIELDS = ['start', 'end', 'character', 'caption'];
function editorDraftKey(lineId) { return `${session.activeSessionId}:${lineId}`; }
function readEditorForm(form) {
  return Object.fromEntries(EDITOR_FORM_FIELDS.map(field => [field, form.querySelector(`[data-editor-field="${field}"]`).value]));
}
function rememberEditorDraft(form) {
  const values = readEditorForm(form);
  const key = form.dataset.draftKey;
  if (!key?.startsWith(`${session.activeSessionId}:`) || !editorAuthoritative.has(Number(key.split(':').pop()))) return null;
  const previous = editorDrafts.get(key);
  if (previous && previous.pending) { previous.values = values; return previous; }
  if (EDITOR_FORM_FIELDS.every(field => sameEditorValue(field, values[field], form.editorBase[field] ?? ''))) {
    editorDrafts.delete(key);
    return null;
  }
  const draft = { base: form.editorBase, values };
  editorDrafts.set(key, draft);
  return draft;
}
function editorMinimumDuration(line) { return Math.max(0.001, Math.min(0.1, line.end - line.start)); }
function validateEditorForm(form, line) {
  const startInput = form.querySelector('[data-editor-field="start"]');
  const endInput = form.querySelector('[data-editor-field="end"]');
  endInput.setCustomValidity('');
  const start = startInput.valueAsNumber;
  const end = endInput.valueAsNumber;
  let message = '';
  if (!Number.isFinite(start) || !Number.isFinite(end)) message = t('editor.timingRequired');
  else if (start < 0 || end > window.DublineTimeline.limit(editorVideoDuration())) message = t('timeline.bounds');
  else if (end <= start) message = t('editor.timingOrder');
  else if (Math.round(end * 1000) - Math.round(start * 1000) < Math.round(editorMinimumDuration(line) * 1000)) {
    message = t('editor.timingMinimum', { seconds: Number(editorMinimumDuration(line).toFixed(3)) });
  } else if (startInput.validity.stepMismatch || endInput.validity.stepMismatch) message = t('editor.timingPrecision');
  if (message) endInput.setCustomValidity(message);
  form.querySelector('[data-editor-error]').textContent = message;
  return !message && form.checkValidity();
}
// Text fields compare as typed; times compare as numbers ("1.50" is the same as 1.5)
function sameEditorValue(field, a, b) {
  if (field === 'start' || field === 'end') return Number(a) === Number(b) && String(a).trim() !== '' && String(b).trim() !== '';
  return String(a ?? '') === String(b ?? '');
}

// The line changed on the server while a draft was open. Fields only the server changed are
// taken from it, fields only the user changed stay in the draft. Returns true when the same
// field was changed on both sides to different values: a real conflict for the user to decide.
function mergeEditorDraft(key, draft, line) {
  let conflict = false;
  const timing = ['start', 'end'];
  const localTiming = timing.some(field => !sameEditorValue(field, draft.values[field], draft.base[field]));
  const remoteTiming = timing.some(field => !sameEditorValue(field, line[field], draft.base[field]));
  if (remoteTiming && localTiming && timing.some(field => !sameEditorValue(field, draft.values[field], line[field]))) conflict = true;
  else if (remoteTiming && !localTiming) for (const field of timing) { draft.values[field] = String(line[field]); draft.base[field] = line[field]; }
  for (const field of EDITOR_FORM_FIELDS.filter(field => !timing.includes(field))) {
    const base = String(draft.base[field] ?? '');
    const latest = String(line[field] ?? '');
    const mine = draft.values[field];
    const editedByMe = !sameEditorValue(field, mine, base);
    const changedThere = !sameEditorValue(field, latest, base);
    if (changedThere && !editedByMe) {
      draft.values[field] = latest;
      // A conflict in another field must not turn this merged remote value into
      // a local edit on the next update (and then overwrite later remote edits).
      draft.base[field] = line[field];
    }
    else if (changedThere && editedByMe && !sameEditorValue(field, mine, latest)) conflict = true;
  }
  if (conflict) return true;
  draft.base = { ...line };
  if (EDITOR_FORM_FIELDS.every(field => sameEditorValue(field, draft.values[field], line[field] ?? ''))) editorDrafts.delete(key);
  return false;
}

// "Keep my version": the draft now edits the latest revision and overwrites the changed fields
window.keepEditorDraft = function(lineId) {
  const key = editorDraftKey(lineId);
  const draft = editorDrafts.get(key);
  const line = session.lines.find(item => item.id === lineId);
  if (!draft || !line || draft.pending) return;
  draft.base = { ...line };
  showEditorInspector(line, false);
};

window.reloadEditorDraft = function(lineId) {
  editorDrafts.delete(editorDraftKey(lineId));
  const line = session.lines.find(item => item.id === lineId);
  if (line) showEditorInspector(line, false);
};

window.showEditorInspector = function(line, capture = true) {
  const oldForm = inspector.querySelector('#editorLineForm');
  if (oldForm && capture) rememberEditorDraft(oldForm);
  if (oldForm) oldForm.querySelectorAll('[data-editor-field="start"], [data-editor-field="end"]').forEach(input => { input.disabled = session.protectTimings === true; });
  const key = editorDraftKey(line.id);
  let draft = editorDrafts.get(key);
  const tracks = sessionCharacters();
  // A newer revision arrived (someone else's edit, or my own drag / keys / undo): merge it into
  // the draft field by field; only the same field changed on both sides is a conflict
  const conflict = !!draft && !draft.pending && Number(draft.base.revision || 0) !== Number(line.revision || 0) &&
    mergeEditorDraft(key, draft, line);
  draft = editorDrafts.get(key);
  // Unrelated room snapshots must not reset focus, selection or partially typed numbers.
  if (capture && oldForm && oldForm.dataset.draftKey === key &&
      oldForm.dataset.revision === String(line.revision || 0) && oldForm.dataset.tracks === JSON.stringify(tracks)) {
    const mix = inspector.querySelector('[data-editor-take]');
    if (mix) mix.innerHTML = takePanelHtml(line, canEditTake(line));
    return;
  }
  const focused = oldForm && oldForm.contains(document.activeElement) ? document.activeElement : null;
  const focusState = focused ? { id: focused.id, start: focused.selectionStart, end: focused.selectionEnd } : null;
  const values = draft ? draft.values : Object.fromEntries(EDITOR_FORM_FIELDS.map(field => [field, String(line[field] ?? '')]));
  const options = tracks.includes(values.character) ? tracks : [...tracks, values.character];
  inspector.innerHTML = `
    <div class="insp-head">
      <div class="insp-title"><b>${t('editor.line')}</b><span>#${lineNumber(line)}</span></div>
      <span class="insp-chip me">${t('mode.edit')}</span>
    </div>
    <form id="editorLineForm" class="setting-card" onsubmit="saveEditorLine(event, ${line.id})" novalidate>
      <label class="setting-sub">${t('editor.caption')}</label>
      <textarea id="editorCaption" data-editor-field="caption" class="text-input" maxlength="2000" rows="4">${esc(values.caption)}</textarea>
      <label class="setting-sub">${t('editor.track')}</label>
      <select id="editorCharacter" data-editor-field="character" class="text-input">
        ${options.map(name => `<option value="${esc(name)}" ${name === values.character ? 'selected' : ''}>${esc(name)}</option>`).join('')}
      </select>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <label class="setting-sub">${t('editor.start')}<input id="editorStart" data-editor-field="start" class="text-input" type="number" min="0" max="43200" step="0.001" required value="${esc(values.start)}" style="width:100%;margin-top:4px;"></label>
        <label class="setting-sub">${t('editor.end')}<input id="editorEnd" data-editor-field="end" class="text-input" type="number" min="0" max="43200" step="0.001" required value="${esc(values.end)}" style="width:100%;margin-top:4px;"></label>
      </div>
      <p data-editor-error role="alert" style="color:var(--danger)"></p>
      ${conflict ? `<div role="alert"><p>${t('editor.draftConflict')}</p><p>${esc(line.caption || '')} (${line.start}–${line.end})</p></div>` : ''}
      ${conflict ? `<button class="btn-play" type="button" onclick="keepEditorDraft(${line.id})">${t('editor.keepMine')}</button>` : ''}
      ${draft ? `<button class="btn-outline" type="button" ${draft.pending ? 'disabled' : ''} onclick="reloadEditorDraft(${line.id})">${t('editor.loadLatest')}</button>` : ''}
      <div class="insp-actions">
        <button class="btn-play grow" type="submit" ${conflict || (draft && draft.pending) ? 'disabled' : ''}>${t('save')}</button>
        <button class="btn-outline" type="button" onclick="video.currentTime=${line.start}">${t('editor.seek')}</button>
        <button class="btn-delete" type="button" onclick="deleteEditorLines([${line.id}])">${t('editor.delete')}</button>
      </div>
    </form>
    ${retakeControlHtml(line)}
    <div data-editor-take>${takePanelHtml(line, canEditTake(line))}</div>
    <p class="take-hint">${t('editor.dragHint')}</p>
  `;
  const form = inspector.querySelector('#editorLineForm');
  form.querySelectorAll('[data-editor-field="start"], [data-editor-field="end"]').forEach(input => { input.disabled = session.protectTimings === true; });
  form.dataset.draftKey = key;
  form.dataset.revision = String(line.revision || 0);
  form.dataset.tracks = JSON.stringify(tracks);
  form.editorBase = draft ? draft.base : { ...line };
  window.bindEditorLeases?.(form);
  form.addEventListener('input', () => { rememberEditorDraft(form); validateEditorForm(form, line); });
  validateEditorForm(form, line);
  if (focusState) {
    const input = form.querySelector(`#${focusState.id}`);
    if (input) {
      input.focus();
      if (input.tagName === 'TEXTAREA') input.setSelectionRange(focusState.start, focusState.end);
    }
  }
};

window.saveEditorLine = async function(event, lineId) {
  event.preventDefault();
  const line = session.lines.find(item => item.id === lineId);
  if (!line) return;
  const form = event.currentTarget;
  if (!validateEditorForm(form, line)) return form.reportValidity();
  const key = form.dataset.draftKey;
  const draft = rememberEditorDraft(form) || { base: form.editorBase, values: readEditorForm(form) };
  if (draft.pending || Number(draft.base.revision || 0) !== Number(line.revision || 0)) {
    showEditorInspector(line);
    return;
  }
  const submitted = { ...draft.values };
  draft.pending = true;
  editorDrafts.set(key, draft);
  form.querySelector('button[type="submit"]').disabled = true;
  const changes = {};
  for (const field of EDITOR_FORM_FIELDS) if (!sameEditorValue(field, submitted[field], draft.base[field])) changes[field] = submitted[field];
  if (changes.start !== undefined || changes.end !== undefined) { changes.start = Number(submitted.start); changes.end = Number(submitted.end); }
  if (session.protectTimings && (changes.start !== undefined && changes.start !== line.start || changes.end !== undefined && changes.end !== line.end)) {
    draft.pending = false; form.querySelector('button[type="submit"]').disabled = false;
    showToast(t('editor.timingsProtected')); return;
  }
  // A form edits the version the user actually saw, not a newer revision picked
  // up while the request waited in the drag queue.
  const result = await queueEditorRequest(() => ['editor_update_line', { lineId, revision: draft.base.revision || 0, base: editorBase(draft.base), ...changes }]);
  draft.pending = false;
  if (result && result.ok) {
    const saved = result.line;
    if (EDITOR_FORM_FIELDS.every(field => draft.values[field] === submitted[field])) editorDrafts.delete(key);
    else draft.base = { ...saved };
    showToast(t('editor.saved'));
  } else editorResult(result);
  if (session && editorDraftKey(lineId) === key && selectedLine && selectedLine.id === lineId && session.mode === 'edit') {
    const current = session.lines.find(item => item.id === lineId);
    if (current) showEditorInspector(current, false);
  }
};

window.deleteEditorLines = async function(lineIds) {
  const binding = captureEditorTargets(lineIds);
  if (!lineIds.length || !await askConfirm(t('line.deleteConfirm', { n: lineIds.length }))) return;
  if (!editorTargetsMatch(binding)) return showToast(t('editor.dialogChanged'));
  return queueEditorRequest(() => ['editor_delete_lines', {
    lines: binding.lines
  }]).then(result => {
    if (!editorResult(result)) return;
    if (selectedLine && lineIds.includes(selectedLine.id)) {
      selectedLine = null;
      inspector.innerHTML = `<h3>${t('inspector.title')}</h3><p>${t('inspector.empty')}</p>`;
    }
    clearMultiSelection();
  });
};

function captureEditorTargets(lineIds) {
  return { sessionId: session.activeSessionId, lines: lineIds.map(lineId => ({ lineId, revision: lineRevision(lineId) })) };
}
function editorTargetsMatch(binding) {
  return session?.mode === 'edit' && session.activeSessionId === binding.sessionId && binding.lines.every(item =>
    session.lines.some(line => line.id === item.lineId && Number(line.revision || 0) === item.revision));
}

window.activeEditorGesture = null;
let deferredEditorRender = false;
function cancelEditorGesture(reason) {
  const gesture = window.activeEditorGesture;
  if (!gesture) return;
  gesture.cleanup();
  if (reason === 'conflict') showToast(t('editor.gestureConflict'));
}
window.addEventListener('blur', () => { if (!window.activeEditorGesture) return; cancelEditorGesture(); if (session?.loaded) renderTimeline(); });

window.acceptEditorTake = function(line) {
  const previous = editorAuthoritative.get(line.id);
  if (previous && Number(line.revision || 0) >= Number(previous.revision || 0)) editorAuthoritative.set(line.id, { ...line });
  rebuildEditorOverlay();
};

function refreshEditorTimeline(lines) {
  if (window.activeEditorGesture) { deferredEditorRender = true; return; }
  if (window.refreshEditorRows) refreshEditorRows(lines);
  else renderTimeline();
}

// The role track under the pointer (its row carries the character name)
function trackUnderPointer(x, y) {
  const hit = document.elementFromPoint(x, y);
  const row = hit && hit.closest('.track-row');
  return row && row.dataset.character ? row : null;
}

window.enableLineEditDrag = function(el, lineId) {
  el.classList.add('editor-draggable');
  const startHandle = document.createElement('span');
  startHandle.className = 'line-resize-handle start';
  const endHandle = document.createElement('span');
  endHandle.className = 'line-resize-handle end';
  el.append(startHandle, endHandle);
  startHandle.hidden = endHandle.hidden = session?.protectTimings === true;

  const begin = async (event, edge = null) => {
    if (event.button !== 0) return;
    // The timeline's own mouse handlers stay out of Edit Mode (this also suppresses their mousedown)
    event.preventDefault();
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey || event.shiftKey) return; // with a modifier the click selects
    const line = session.lines.find(item => item.id === lineId);
    if (!line || session.mode !== 'edit') return;
    if (edge && session.protectTimings) return;
    cancelEditorGesture();
    // Dragging one of several selected lines moves the whole selection
    const group = !edge && multiSelection.size >= 2 && multiSelection.has(lineId)
      ? session.lines.filter(item => multiSelection.has(item.id))
      : [line];
    const sessionId = session.activeSessionId;
    const protection = session.protectTimings;
    const identities = group.map(item => [item.id, item.revision || 0]);
    let released = false;
    let pendingPointer = null;
    const earlyMove = next => { pendingPointer = { clientX: next.clientX, clientY: next.clientY }; };
    const earlyRelease = () => { released = true; };
    window.addEventListener('pointerup', earlyRelease, { once: true });
    window.addEventListener('pointercancel', earlyRelease, { once: true });
    window.addEventListener('blur', earlyRelease, { once: true });
    window.addEventListener('pointermove', earlyMove);
    const targets = group.length > 64 ? [{ type: 'session', key: '*', group: 'structural' }] : group.flatMap(item =>
      [...(!session.protectTimings ? [{ type: 'line', key: item.id, group: 'timing' }] : []), ...(!edge ? [{ type: 'line', key: item.id, group: 'assignment' }] : [])]);
    const leaseToken = await acquireEditLease(targets);
    window.removeEventListener('pointerup', earlyRelease);
    window.removeEventListener('pointercancel', earlyRelease);
    window.removeEventListener('blur', earlyRelease);
    window.removeEventListener('pointermove', earlyMove);
    if (!leaseToken || released || !el.isConnected || session.activeSessionId !== sessionId || session.mode !== 'edit' || session.protectTimings !== protection || identities.some(([id, revision]) => (session.lines.find(item => item.id === id)?.revision || 0) !== revision)) {
      releaseEditLease(leaseToken); return;
    }
    const blocks = group.map(item => ({ line: item, el: document.getElementById(`line-block-${item.id}`) })).filter(item => item.el);
    const tracks = sessionCharacters();
    const originX = event.clientX;
    const originY = event.clientY;
    let delta = 0;
    let start = line.start;
    let end = line.end;
    let targetRow = null;
    let moved = false;
    let axisReleased = false;
    let roleChanges = null;

    const setTarget = row => {
      if (row === targetRow) return;
      if (targetRow) targetRow.classList.remove('drop-target');
      targetRow = row;
      if (targetRow) targetRow.classList.add('drop-target');
    };

    // Near the top or bottom edge the timeline scrolls, so a role further down can be reached
    const scroller = document.getElementById('timelineContainer');
    const guides = document.createElement('div');
    guides.className = 'editor-drag-guides';
    for (const time of [line.start, line.end]) {
      const guide = document.createElement('i'); guide.style.left = `${labelWidth + time * pxPerSec}px`; guides.appendChild(guide);
    }
    timeline.appendChild(guides);
    const scrollOrigin = scroller.scrollTop;
    let lastPointer = null;
    const edgeScroll = setInterval(() => {
      if (!lastPointer || edge) return;
      const box = scroller.getBoundingClientRect();
      const step = lastPointer.clientY > box.bottom - 36 ? 14 : lastPointer.clientY < box.top + 56 ? -14 : 0;
      if (!step) return;
      const before = scroller.scrollTop;
      scroller.scrollTop += step;
      if (scroller.scrollTop !== before) onMove(lastPointer);
    }, 30);

    const onMove = moveEvent => {
      lastPointer = { clientX: moveEvent.clientX, clientY: moveEvent.clientY };
      const dx = moveEvent.clientX - originX;
      const dy = moveEvent.clientY - originY + (scroller.scrollTop - scrollOrigin);
      if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      moved = true;
      const shift = dx / pxPerSec;
      if (edge === 'start') {
        start = window.DublineTimeline.resize(line, edge, line.start + shift, editorVideoDuration(), editorMinimumDuration(line))?.start ?? line.start;
      } else if (edge === 'end') {
        end = window.DublineTimeline.resize(line, edge, line.end + shift, editorVideoDuration(), editorMinimumDuration(line))?.end ?? line.end;
      } else {
        if (Math.abs(dx) >= 14) axisReleased = true;
        else if (Math.abs(dx) <= 6) axisReleased = false;
        const locked = session.protectTimings || !axisReleased && Math.abs(dy) > 6;
        guides.classList.toggle('locked', locked);
        delta = window.DublineTimeline.move(group, locked ? 0 : shift, editorVideoDuration());
        blocks.forEach(({ el: block }) => block.classList.toggle('axis-locked', locked));
        // Vertical movement picks another role's track
        const row = trackUnderPointer(moveEvent.clientX, moveEvent.clientY);
        setTarget(row && row.dataset.character !== line.character ? row : null);
        const offset = targetRow ? tracks.indexOf(targetRow.dataset.character) - tracks.indexOf(line.character) : 0;
        roleChanges = window.DublineTimeline.roles(group, tracks, offset);
        blocks.forEach(({ el: block }) => block.classList.toggle('move-blocked', !!offset && !roleChanges));
      }
      blocks.forEach(({ line: item, el: block }) => {
        block.classList.add('editor-dragging');
        const from = edge ? start : item.start + delta;
        const to = edge ? end : item.end + delta;
        block.style.left = `${from * pxPerSec}px`;
        block.style.width = `${Math.max((to - from) * pxPerSec, MIN_TILE_PX)}px`;
        const targetCharacter = roleChanges?.get(item.id);
        const targetTrack = targetCharacter && [...timeline.querySelectorAll('.track-row')].find(row => row.dataset.character === targetCharacter);
        const sourceTrack = block.closest('.track-row');
        const previewY = targetTrack && targetRow ? targetTrack.offsetTop - sourceTrack.offsetTop : dy;
        block.style.transform = edge ? '' : `translateY(${previewY}px)`;
      });
    };

    const cleanup = (keepLease = false) => {
      if (!keepLease) releaseEditLease(leaseToken);
      clearInterval(edgeScroll);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      setTarget(null);
      guides.remove();
      blocks.forEach(({ line: item, el: block }) => {
        block.classList.remove('editor-dragging', 'axis-locked', 'move-blocked');
        block.style.transform = '';
        block.style.left = `${item.start * pxPerSec}px`;
        block.style.width = `${Math.max((item.end - item.start) * pxPerSec, MIN_TILE_PX)}px`;
      });
      window.activeEditorGesture = null;
    };
    const onCancel = () => { cleanup(); renderTimeline(); };
    const onUp = () => {
      const character = targetRow ? targetRow.dataset.character : null;
      cleanup(true);
      if (deferredEditorRender) { deferredEditorRender = false; renderTimeline(); }
      if (!moved) { releaseEditLease(leaseToken); return; }
      el.dataset.justDragged = '1';
      if (character && !roleChanges) { releaseEditLease(leaseToken); renderTimeline(); showToast(t('timeline.trackBoundary')); return; }
      const changes = new Map();
      if (edge) {
        if (start !== line.start || end !== line.end) changes.set(line.id, { start, end });
      } else {
        group.forEach(item => {
          const update = {};
          if (delta) Object.assign(update, { start: Number((item.start + delta).toFixed(3)), end: Number((item.end + delta).toFixed(3)) });
          const target = roleChanges?.get(item.id);
          if (target && target !== item.character) update.character = target;
          if (Object.keys(update).length) changes.set(item.id, update);
        });
      }
      if (changes.size) sendLineUpdates(changes).finally(() => releaseEditLease(leaseToken));
      else { releaseEditLease(leaseToken); renderTimeline(); }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.activeEditorGesture = { sessionId: session.activeSessionId, lineIds: new Set(group.map(item => item.id)),
      baseFields: new Map(group.map(item => [item.id, editorBase(item)])), baseRevisions: new Map(group.map(item => [item.id, item.revision || 0])), type: edge ? `resize-${edge}` : 'move', cleanup };
    if (pendingPointer) onMove(pendingPointer);
  };

  el.onpointerdown = event => begin(event, null);
  startHandle.onpointerdown = event => begin(event, 'start');
  endHandle.onpointerdown = event => begin(event, 'end');
};

// Ctrl+Z / "Undo": every player undoes their own last edit
window.editorUndo = function() {
  if (!session || session.mode !== 'edit') return;
  return queueEditorRequest(() => ['editor_undo', {}]).then(result => {
    if (!result || !result.ok) showToast(t(result && result.reason === 'empty' ? 'editor.undoNothing' : 'editor.rejected'));
    else if (!result.undone && result.skipped) showToast(t('editor.undoSkipped', { n: result.skipped }));
    else showToast(t('editor.undone') + (result.skipped ? ' ' + t('editor.undoSkipped', { n: result.skipped }) : ''));
    return result;
  });
};

function editorSelection() {
  if (multiSelection.size) return session.lines.filter(line => multiSelection.has(line.id));
  return selectedLine ? session.lines.filter(line => line.id === selectedLine.id) : [];
}

// Keyboard in Edit Mode. Returns true when the key was handled here.
window.handleEditorKey = function(e) {
  if (!session || session.mode !== 'edit') return false;
  if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
    e.preventDefault();
    editorUndo();
    return true;
  }
  const lines = editorSelection();
  if (!lines.length) return false;

  if (e.code === 'Delete' || e.code === 'Backspace') {
    e.preventDefault();
    deleteEditorLines(lines.map(line => line.id));
    return true;
  }
  // ←/→ move the selected lines in time (instead of seeking the video)
  if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    if (session.protectTimings) return true;
    const step = (e.shiftKey ? 1 : 0.1) * (e.code === 'ArrowLeft' ? -1 : 1);
    const shift = window.DublineTimeline.move(lines, step, editorVideoDuration());
    if (!shift) return true;
    sendLineUpdates(new Map(lines.map(line => [line.id, {
      start: Number((line.start + shift).toFixed(3)),
      end: Number((line.end + shift).toFixed(3))
    }])), { coalesce: lines.map(line => line.id).sort((a, b) => a - b).join(',') });
    return true;
  }
  // Alt+↑/↓ move them to the role above / below
  if ((e.code === 'ArrowUp' || e.code === 'ArrowDown') && e.altKey) {
    e.preventDefault();
    const tracks = sessionCharacters();
    const targets = window.DublineTimeline.roles(lines, tracks, e.code === 'ArrowUp' ? -1 : 1);
    if (!targets) { showToast(t('timeline.trackBoundary')); return true; }
    sendLineUpdates(new Map(lines.map(line => [line.id, { character: targets.get(line.id) }])));
    revealLineId = lines[0].id;
    return true;
  }
  return false;
};

updateModeUi();
