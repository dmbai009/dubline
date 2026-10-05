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
  document.querySelectorAll('#modeSwitch button').forEach(button => { button.disabled = !amHost(); });
  document.querySelector('.toolbar-hint').textContent = t(editing ? 'timeline.editHint' : 'timeline.hint');
}

window.setStudioMode = function(mode) {
  if (!amHost() || !['edit', 'dub'].includes(mode) || !session || session.mode === mode) return;
  socket.emit('set_session_mode', { mode });
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

function applyEditorLines(lines) {
  if (!session || !Array.isArray(session.lines) || !Array.isArray(lines)) return;
  lines.forEach(line => {
    const index = session.lines.findIndex(item => item.id === line.id);
    if (index === -1) session.lines.push(line);
    else session.lines[index] = line;
    if (selectedLine && selectedLine.id === line.id) selectedLine = line;
  });
  session.lines.sort((a, b) => a.start - b.start || a.id - b.id);
  renderTimeline();
  updatePrompter();
  if (selectedLine && lines.some(line => line.id === selectedLine.id)) showInspector(selectedLine);
}

socket.on('editor_lines_updated', applyEditorLines);

function editorResult(result) {
  if (result && result.ok) return true;
  if (!result) {
    showToast(t('editor.rejected'));
    return false;
  }
  if (result.reason === 'conflict' && (result.lines || result.line)) {
    applyEditorLines(result.lines || [result.line]);
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

// Edits go out one after another and each takes the line's latest revision when sent:
// a second drag right after the first is not mistaken for someone else's change.
let editorQueue = Promise.resolve();

const OPTIMISTIC_FIELDS = ['start', 'end', 'character', 'caption', 'claimedBy'];

// Show an edit right away (tiles take their new place and lanes at once);
// a rejected edit puts the lines back as they were
function applyLocally(changesById) {
  const saved = [];
  for (const [lineId, changes] of changesById) {
    const line = session.lines.find(item => item.id === lineId);
    if (!line) continue;
    saved.push({ line, fields: Object.fromEntries(OPTIMISTIC_FIELDS.map(field => [field, line[field]])) });
    if (changes.character !== undefined && changes.character !== line.character && selectedLine && selectedLine.id === line.id) revealLineId = line.id;
    Object.assign(line, changes);
    if (changes.character !== undefined && changes.character !== saved[saved.length - 1].fields.character) line.claimedBy = null;
  }
  session.lines.sort((a, b) => a.start - b.start || a.id - b.id);
  renderTimeline();
  return () => {
    saved.forEach(({ line, fields }) => {
      const current = session.lines.find(item => item.id === line.id);
      if (current !== line) return; // a newer server snapshot already replaced this object
      Object.assign(current, fields);
    });
    session.lines.sort((a, b) => a.start - b.start || a.id - b.id);
    renderTimeline();
    if (selectedLine) showInspector(selectedLine);
  };
}

// The current revision of a line, read when a queued request is actually sent
function lineRevision(lineId) {
  const line = session.lines.find(item => item.id === lineId);
  return line ? line.revision || 0 : 0;
}

// Every editor request waits for the previous one. `build` runs at send time and returns
// [event, payload], so revisions in the payload already include our earlier edits.
// No answer in time (the connection dropped after sending): the server may or may not have
// applied the request, so it is never repeated; the scene is reloaded from the server instead.
const EDITOR_ACK_TIMEOUT_MS = 10000;
let editorQueueGeneration = 0;
let editorNeedsResync = false;

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

function queueEditorRequest(build) {
  const generation = editorQueueGeneration;
  const sessionId = session && session.activeSessionId;
  const run = async () => {
    if (generation !== editorQueueGeneration || !session || session.activeSessionId !== sessionId) {
      return { ok: false, reason: 'cancelled' };
    }
    if (editorNeedsResync && !await resyncEditor()) return { ok: false, reason: 'timeout' };
    if (!socket.connected) {
      editorNeedsResync = true;
      editorQueueGeneration++;
      return { ok: false, reason: 'timeout' };
    }
    if (session.activeSessionId !== sessionId) return { ok: false, reason: 'cancelled' };
    const [event, payload] = build();
    return new Promise(resolve => {
      socket.timeout(EDITOR_ACK_TIMEOUT_MS).emit(event, { ...payload, sessionId }, async (err, result) => {
        if (!err) return resolve(result);
        // Drop dependent requests, then wait for authoritative state before a new action.
        editorQueueGeneration++;
        editorNeedsResync = true;
        await resyncEditor();
        resolve({ ok: false, reason: 'timeout' });
      });
    });
  };
  const next = editorQueue.then(run);
  editorQueue = next.catch(() => {});
  return next;
}

function sendLineUpdates(changesById) {
  const restore = applyLocally(changesById);
  return queueEditorRequest(() => {
    const updates = [...changesById].map(([lineId, changes]) => ({ lineId, revision: lineRevision(lineId), ...changes }));
    return updates.length === 1 ? ['editor_update_line', updates[0]] : ['editor_update_lines', { updates }];
  }).then(result => {
    // A conflict brings the current lines; after a timeout the reloaded scene replaces them
    if (result && !result.ok && !['conflict', 'timeout', 'cancelled'].includes(result.reason)) restore();
    editorResult(result);
    return result;
  });
}

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
  if (!session || session.mode !== 'edit') return;
  const tracks = sessionCharacters();
  const selectedTrack = character || (selectedLine && selectedLine.character) || tracks[0];
  if (!selectedTrack) return addEditorTrack();
  return createEditorLineAt(selectedTrack, video.currentTime || 0);
};

window.createEditorLineAt = function(character, time) {
  if (!session || session.mode !== 'edit' || !session.loaded || !sessionCharacters().includes(character)) return;
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
  const previous = editorDrafts.get(key);
  if (previous && previous.pending) { previous.values = values; return previous; }
  if (EDITOR_FORM_FIELDS.every(field => values[field] === String(form.editorBase[field] ?? ''))) {
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
  for (const field of EDITOR_FORM_FIELDS) {
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
      oldForm.dataset.revision === String(line.revision || 0) && oldForm.dataset.tracks === JSON.stringify(tracks)) return;
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
    <p class="take-hint">${t('editor.dragHint')}</p>
  `;
  const form = inspector.querySelector('#editorLineForm');
  form.dataset.draftKey = key;
  form.dataset.revision = String(line.revision || 0);
  form.dataset.tracks = JSON.stringify(tracks);
  form.editorBase = draft ? draft.base : { ...line };
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
  const changes = { ...submitted, start: Number(submitted.start), end: Number(submitted.end) };
  // A form edits the version the user actually saw, not a newer revision picked
  // up while the request waited in the drag queue.
  const result = await queueEditorRequest(() => ['editor_update_line', { lineId, revision: draft.base.revision || 0, ...changes }]);
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
  if (!lineIds.length || !await askConfirm(t('line.deleteConfirm', { n: lineIds.length }))) return;
  return queueEditorRequest(() => ['editor_delete_lines', {
    lines: lineIds.map(lineId => ({ lineId, revision: lineRevision(lineId) }))
  }]).then(result => {
    if (!editorResult(result)) return;
    if (selectedLine && lineIds.includes(selectedLine.id)) {
      selectedLine = null;
      inspector.innerHTML = `<h3>${t('inspector.title')}</h3><p>${t('inspector.empty')}</p>`;
    }
    clearMultiSelection();
  });
};

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

  const begin = (event, edge = null) => {
    if (event.button !== 0) return;
    // The timeline's own mouse handlers stay out of Edit Mode (this also suppresses their mousedown)
    event.preventDefault();
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey || event.shiftKey) return; // with a modifier the click selects
    const line = session.lines.find(item => item.id === lineId);
    if (!line || session.mode !== 'edit') return;
    // Dragging one of several selected lines moves the whole selection
    const group = !edge && multiSelection.size >= 2 && multiSelection.has(lineId)
      ? session.lines.filter(item => multiSelection.has(item.id))
      : [line];
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
        if (Math.abs(dx) >= 12) axisReleased = true;
        const locked = !axisReleased && Math.abs(dy) > 6;
        delta = window.DublineTimeline.move(group, locked ? 0 : shift, editorVideoDuration());
        blocks.forEach(({ el: block }) => block.classList.toggle('axis-locked', locked));
        // Vertical movement picks another role's track
        const row = trackUnderPointer(moveEvent.clientX, moveEvent.clientY);
        setTarget(row && row.dataset.character !== line.character ? row : (row ? null : targetRow));
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
        block.style.transform = edge ? '' : `translateY(${dy}px)`;
      });
    };

    const onUp = () => {
      clearInterval(edgeScroll);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const character = targetRow ? targetRow.dataset.character : null;
      setTarget(null);
      blocks.forEach(({ el: block }) => {
        block.classList.remove('editor-dragging', 'axis-locked', 'move-blocked');
        block.style.transform = '';
      });
      if (!moved) return;
      el.dataset.justDragged = '1';
      if (character && !roleChanges) { renderTimeline(); showToast(t('timeline.trackBoundary')); return; }
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
      if (changes.size) sendLineUpdates(changes);
      else renderTimeline();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
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
    const step = (e.shiftKey ? 1 : 0.1) * (e.code === 'ArrowLeft' ? -1 : 1);
    const shift = window.DublineTimeline.move(lines, step, editorVideoDuration());
    if (!shift) return true;
    sendLineUpdates(new Map(lines.map(line => [line.id, {
      start: Number((line.start + shift).toFixed(3)),
      end: Number((line.end + shift).toFixed(3))
    }])));
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
