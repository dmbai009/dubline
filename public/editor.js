// ==========================================
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

window.addEditorTrack = function() {
  if (!canAddTrack()) return;
  const name = prompt(t('editor.trackPrompt'), '');
  if (!name || !name.trim()) return;
  queueEditorRequest(() => ['editor_add_track', { character: name.trim() }]).then(editorResult);
};

window.createLineAtPlayhead = function(character = '') {
  if (!session || session.mode !== 'edit') return;
  const tracks = sessionCharacters();
  const selectedTrack = character || (selectedLine && selectedLine.character) || tracks[0];
  if (!selectedTrack) return addEditorTrack();
  const start = Math.max(0, Number((video.currentTime || 0).toFixed(3)));
  const end = Number((Math.min(video.duration || start + 2, start + 2)).toFixed(3));
  queueEditorRequest(() => ['editor_create_line', { character: selectedTrack, caption: '', start, end: Math.max(start + 0.1, end) }]).then(result => {
    if (!editorResult(result) || !result.line) return;
    revealLineId = result.line.id;
    selectedLine = result.line;
  });
};

window.showEditorInspector = function(line) {
  const tracks = sessionCharacters();
  inspector.innerHTML = `
    <div class="insp-head">
      <div class="insp-title"><b>${t('editor.line')}</b><span>#${line.id}</span></div>
      <span class="insp-chip me">${t('mode.edit')}</span>
    </div>
    <form id="editorLineForm" class="setting-card" onsubmit="saveEditorLine(event, ${line.id})">
      <label class="setting-sub">${t('editor.caption')}</label>
      <textarea id="editorCaption" class="text-input" maxlength="2000" rows="4">${esc(line.caption || '')}</textarea>
      <label class="setting-sub">${t('editor.track')}</label>
      <select id="editorCharacter" class="text-input">
        ${tracks.map(name => `<option value="${esc(name)}" ${name === line.character ? 'selected' : ''}>${esc(name)}</option>`).join('')}
      </select>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <label class="setting-sub">${t('editor.start')}<input id="editorStart" class="text-input" type="number" min="0" max="43200" step="0.01" value="${line.start}" style="width:100%;margin-top:4px;"></label>
        <label class="setting-sub">${t('editor.end')}<input id="editorEnd" class="text-input" type="number" min="0.1" max="43200" step="0.01" value="${line.end}" style="width:100%;margin-top:4px;"></label>
      </div>
      <div class="insp-actions">
        <button class="btn-play grow" type="submit">${t('save')}</button>
        <button class="btn-outline" type="button" onclick="video.currentTime=${line.start}">${t('editor.seek')}</button>
        <button class="btn-delete" type="button" onclick="deleteEditorLines([${line.id}])">${t('editor.delete')}</button>
      </div>
    </form>
    <p class="take-hint">${t('editor.dragHint')}</p>
  `;
};

window.saveEditorLine = async function(event, lineId) {
  event.preventDefault();
  const line = session.lines.find(item => item.id === lineId);
  if (!line) return;
  const start = Number(document.getElementById('editorStart').value);
  const end = Number(document.getElementById('editorEnd').value);
  const character = document.getElementById('editorCharacter').value;
  const caption = document.getElementById('editorCaption').value;
  const result = await updateEditorLine(line, { start, end, character, caption });
  if (result && result.ok) showToast(t('editor.saved'));
};

window.deleteEditorLines = function(lineIds) {
  if (!lineIds.length || !confirm(t('line.deleteConfirm', { n: lineIds.length }))) return;
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
    const minStart = Math.min(...group.map(item => item.start));
    const originX = event.clientX;
    const originY = event.clientY;
    let delta = 0;
    let start = line.start;
    let end = line.end;
    let targetRow = null;
    let moved = false;

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
        start = Number(Math.max(0, Math.min(line.end - 0.1, line.start + shift)).toFixed(3));
      } else if (edge === 'end') {
        end = Number(Math.max(line.start + 0.1, line.end + shift).toFixed(3));
      } else {
        delta = Number(Math.max(-minStart, shift).toFixed(3));
        // Vertical movement picks another role's track
        const row = trackUnderPointer(moveEvent.clientX, moveEvent.clientY);
        setTarget(row && row.dataset.character !== line.character ? row : (row ? null : targetRow));
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
        block.classList.remove('editor-dragging');
        block.style.transform = '';
      });
      if (!moved) return;
      el.dataset.justDragged = '1';
      const changes = new Map();
      if (edge) {
        if (start !== line.start || end !== line.end) changes.set(line.id, { start, end });
      } else {
        group.forEach(item => {
          const update = {};
          if (delta) Object.assign(update, { start: Number((item.start + delta).toFixed(3)), end: Number((item.end + delta).toFixed(3)) });
          if (character && character !== item.character) update.character = character;
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
    const shift = Math.max(step, -Math.min(...lines.map(line => line.start)));
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
    const target = tracks[tracks.indexOf(lines[0].character) + (e.code === 'ArrowUp' ? -1 : 1)];
    if (!target) return true;
    sendLineUpdates(new Map(lines.filter(line => line.character !== target).map(line => [line.id, { character: target }])));
    revealLineId = lines[0].id;
    return true;
  }
  return false;
};

updateModeUi();
