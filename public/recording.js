// ==========================================
// RECORDING
// Recording a take from the microphone, visualizer, automatic silence trimming
// ==========================================
function startVisualizer(stream) {
  const canvas = document.getElementById('visualizerCanvas');
  if (!canvas) return;
  canvas.style.display = 'block';
  const ctx = canvas.getContext('2d');

  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  const source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 64;
  source.connect(analyser);

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  isVisualizerRunning = true;

  function draw() {
    if (!isVisualizerRunning) return;
    requestAnimationFrame(draw);

    analyser.getByteFrequencyData(dataArray);
    ctx.fillStyle = '#121214';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const barWidth = (canvas.width / bufferLength) * 1.5;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * canvas.height;
      if (dataArray[i] > 200) ctx.fillStyle = '#ef4444';
      else if (dataArray[i] > 120) ctx.fillStyle = '#f59e0b';
      else ctx.fillStyle = '#10b981';

      ctx.fillRect(x, canvas.height - barHeight, barWidth - 2, barHeight);
      x += barWidth;
    }
  }
  draw();
}

function stopVisualizer() {
  isVisualizerRunning = false;
  const canvas = document.getElementById('visualizerCanvas');
  if (canvas) canvas.style.display = 'none';
}

// Pre-roll before the line: the video rewinds and, near 0:00, holds the first frame
// long enough to give the player the full configured preparation time.
let recordPlayTimeout = null;
let recordSpeechInterval = null;
let activeRecording = null;
let recordStartPending = false;
const processingRecordings = new Set();
function finishRecordingProcessing(operation) { processingRecordings.delete(operation); window.DublineNextLine?.refresh(); }

function reserveTake(lineId, sessionId, options = {}) {
  if (!socket.connected) return Promise.resolve(null);
  return new Promise(resolve => {
    socket.volatile.timeout(5000).emit('reserve_take', { lineId, sessionId, ...options }, (err, result) => {
      if (result?.reason?.startsWith('takeHistory.')) showToast(t(result.reason));
      resolve(!err && result && result.ok ? result.takeSequence : null);
    });
  });
}

let recordShortcutPending = false;
window.recordSelectedLine = async function() {
  if (!selectedLine) return showToast(t('toast.selectLine'));
  if (recordShortcutPending) return;
  if (recordState !== 'idle') return handleStudioRecord(selectedLine.id);
  if (!socket.connected) return showToast(t('record.connectionRequired'));
  if (renderInProgress || watchMode || session?.mode === 'edit') return handleStudioRecord(selectedLine.id);
  const lineId = selectedLine.id, sessionId = session.activeSessionId, nick = myName, room = currentRoom;
  const line = session.lines.find(item => item.id === lineId);
  const owner = line && getLineOwner(line);
  if (!line) return;
  if (owner === myName) return handleStudioRecord(lineId);
  if (owner) return showToast(t('record.owned', { owner }));
  recordShortcutPending = true;
  try {
    const identity = line.audioUrl;
    if (line.audioUrl && line.recordedBy && line.recordedBy !== myName && !await askConfirm(t('record.replaceForeign', { owner: line.recordedBy }))) return;
    const current = session?.lines.find(item => item.id === lineId);
    if (!socket.connected || session?.activeSessionId !== sessionId || currentRoom !== room || myName !== nick || selectedLine?.id !== lineId || current?.audioUrl !== identity || session.mode !== 'dub' || recordState !== 'idle' || renderInProgress || watchMode) return;
    const result = await new Promise(resolve => socket.volatile.timeout(5000).emit('claim_line', { lineId, sessionId, audioUrl: identity }, (error, value) => resolve(error ? null : value)));
    if (!result?.ok) return showToast(t(result?.owner ? 'record.owned' : 'record.connectionRequired', { owner: result?.owner }));
    if (!socket.connected || session?.activeSessionId !== sessionId || currentRoom !== room || myName !== nick || selectedLine?.id !== lineId || session.mode !== 'dub' || recordState !== 'idle' || renderInProgress || watchMode) return;
    applyTakeUpdates(sessionId, [result.line], result.editorProtocol);
    if (getLineOwner(session.lines.find(item => item.id === lineId)) === myName) return await handleStudioRecord(lineId);
  } finally { recordShortcutPending = false; }
};

window.handleStudioRecord = async function(lineId) {
  if (window.snapshotFrozen && recordState === 'idle') return showToast(t('snapshot.frozen'));
  if (renderInProgress) return showToast(t('studio.mediaBusy'));
  if (!socket.connected && recordState === 'idle') return showToast(t('record.connectionRequired'));
  let line = session.lines.find(l => l.id === lineId);
  if (!line) return;
  if (session.mode === 'edit') {
    showToast(t('editor.recordDisabled'));
    return;
  }

  const owner = getLineOwner(line);
  if (owner !== myName) {
    showToast(t('toast.claimFirst'));
    return;
  }

  let btn = document.getElementById('recBtn');
  if (!btn) return;
  if (recordState === 'idle' && video.playbackRate !== 1) window.setPreviewRate?.(1);

  if (watchMode && recordState === 'idle') {
    showToast(t('watch.noRecord'));
    return;
  }

  if (recordState === 'recording' || recordState === 'preparing') {
    finishRecording({ discard: recordState === 'preparing' });
    return;
  }

  const mediaPreparation = window.sceneMediaPreparation?.();
  if (mediaPreparation?.key) return showToast(t(mediaPreparation.key, { channels: mediaPreparation.channels.map(channel => t('studio.' + channel)).join(', ') }));
  if (window.DublineNoise?.busy()) return showToast(t('noise.busy'));
  if (recordStartPending) return;
  recordStartPending = true;
  try {

  const recordingSessionId = session.activeSessionId || '';
  const recordingRoom = currentRoom;
  const recordingNick = myName;
  const recordingGain = userMicGain;
  const historyCheck = window.DublineTakeHistory?.beforeRecord(line);
  const historyConsent = historyCheck?.then ? await historyCheck : historyCheck ?? (window.DublineTakeHistory ? null : {});
  if (!historyConsent) return;
  if (recordState !== 'idle' || watchMode || session.mode !== 'dub' || currentRoom !== recordingRoom || session.activeSessionId !== recordingSessionId || getLineOwner(session.lines.find(item => item.id === lineId)) !== recordingNick) return;
  window.DublineTakeHistory?.stop();
  btn = document.getElementById('recBtn') || btn;
  let recordingMic;
  try {
    recordingMic = await window.DublineAudioDevices.capture({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
    });
  } catch (err) {
    alert(t('error.mic'));
    return;
  }
  const currentPreparation = window.sceneMediaPreparation?.();
  if (currentPreparation?.key) {
    recordingMic.getTracks().forEach(track => track.stop()); window.DublineAudioDevices.release(recordingMic);
    showToast(t(currentPreparation.key, { channels: currentPreparation.channels.map(channel => t('studio.' + channel)).join(', ') })); return;
  }
  // The microphone permission prompt can outlive a mode/session/ownership change.
  const takeSequence = await reserveTake(lineId, recordingSessionId);
  const currentLine = session && session.lines.find(item => item.id === lineId);
  const microphoneLost = !window.DublineAudioDevices.live(recordingMic);
  if (microphoneLost || recordState !== 'idle' || renderInProgress || !session || session.mode === 'edit' || watchMode ||
      (session.activeSessionId || '') !== recordingSessionId || currentRoom !== recordingRoom || myName !== recordingNick ||
      !takeSequence || !currentLine || getLineOwner(currentLine) !== recordingNick) {
    if (takeSequence) socket.emit('reserve_take', { lineId, sessionId: recordingSessionId, cancelSequence: takeSequence }, () => {});
    recordingMic.getTracks().forEach(track => track.stop());
    window.DublineAudioDevices.release(recordingMic);
    if (microphoneLost) showToast(t('audio.device.recordingInterrupted'));
    if (!takeSequence && !socket.connected) showToast(t('record.connectionRequired'));
    return;
  }
  line = currentLine;
  window.DublineTakeHistory?.stop();
  btn = document.getElementById('recBtn') || btn;
  micStream = recordingMic;

  let micSource, gainNode, audioDest, voiceMeter, recorder;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    micSource = audioCtx.createMediaStreamSource(micStream);
    gainNode = audioCtx.createGain(); gainNode.gain.value = recordingGain;
    audioDest = audioCtx.createMediaStreamDestination();
    micSource.connect(gainNode); gainNode.connect(audioDest);
    voiceMeter = audioCtx.createAnalyser(); voiceMeter.fftSize = 2048; gainNode.connect(voiceMeter);
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    recorder = mimeType ? new MediaRecorder(audioDest.stream, { mimeType }) : new MediaRecorder(audioDest.stream);
    startVisualizer(micStream);
  } catch {
    socket.emit('reserve_take', { lineId, sessionId: recordingSessionId, cancelSequence: takeSequence }, () => {});
    recordingMic.getTracks().forEach(track => track.stop()); window.DublineAudioDevices.release(recordingMic);
    micStream = null; micSource?.disconnect(); gainNode?.disconnect(); voiceMeter?.disconnect();
    audioDest?.stream.getTracks().forEach(track => track.stop()); stopVisualizer();
    showToast(t('error.mic')); return;
  }

  const adrEnabled = localStorage.getItem('dubline_adr') === 'three';
  const wantedPreRoll = window.DublineAdr.preparation(preRollSeconds, adrEnabled);
  const videoPreRoll = Math.min(wantedPreRoll, line.start);
  const holdSeconds = Math.max(0, wantedPreRoll - videoPreRoll);
  const startTime = Number((line.start - videoPreRoll).toFixed(3));
  const recordingStartTime = Number((startTime - holdSeconds).toFixed(3));
  currentRecordingStartTime = recordingStartTime;
  video.pause();
  video.currentTime = startTime;

  recordState = 'preparing';
  if (window.refreshStudioTransport) window.refreshStudioTransport();
  const chunks = [];
  audioChunks = chunks; // compatibility alias; asynchronous handlers own their local array
  discardTake = false;
  recordingLineId = lineId;

  mediaRecorder = recorder;
  const operation = { recorder, stream: recordingMic, discarded: false, nick: recordingNick, room: recordingRoom, sessionId: recordingSessionId, takeSequence, lineId };
  processingRecordings.add(operation);
  activeRecording = operation;
  const mayUpdateUi = () => !activeRecording && mediaRecorder === recorder && recordState === 'idle' &&
    session && session.activeSessionId === recordingSessionId && selectedLine?.id === lineId && document.getElementById('recBtn') === btn;

  recorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = async () => {
    if (activeRecording === operation) finishRecording({ discard: operation.discarded });
    recordingMic.getTracks().forEach(track => track.stop());
    micSource.disconnect(); gainNode.disconnect(); voiceMeter.disconnect();
    audioDest.stream.getTracks().forEach(track => track.stop());

    // Recording was interrupted by the host: don't save the take
    if (operation.discarded) {
      finishRecordingProcessing(operation);
      console.warn(`[Dubline] Take for line #${lineId} discarded`);
      if (mayUpdateUi()) showInspector(selectedLine);
      return;
    }

    const audioBlob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    if (audioBlob.size === 0) {
      finishRecordingProcessing(operation);
      // Never drop a take silently: the player must know it has to record again,
      // even if the inspector has been redrawn (or another line selected) meanwhile
      console.warn(`[Dubline] Take for line #${lineId} is empty (${chunks.length} chunks, audio context ${audioCtx && audioCtx.state})`);
      if (mayUpdateUi()) {
        alert(t('error.emptyAudio')); btn.className = 'btn-record'; btn.innerText = t('record.retry');
      } else {
        showToast(t('error.emptyAudio'));
      }
      return;
    }

    // Silence detection: find where speech starts and ends in the recording
    if (mayUpdateUi()) btn.innerText = t('record.trim');
    let speech = null, duration = null, quality = null;
    try {
      const decoded = await decodeAudio(await audioBlob.arrayBuffer()); duration = decoded.duration;
      speech = detectSpeechBounds(decoded);
      if (window.DublineTakeAnalysis?.enabled()) quality = await DublineSpeechAnalysis.measure(decoded, speech ? { from: speech.start, to: speech.end } : {}, 'quality').catch(() => null);
    } catch (err) {
      console.warn('[Dubline] Could not analyse the take:', err);
    }

    if (mayUpdateUi()) btn.innerText = t('record.saving');
    await submitTake({
      uploadId: newUploadId(),
      room: recordingRoom,
      sessionId: recordingSessionId,
      lineId,
      nick: operation.nick,
      takeSequence,
      ...historyConsent,
      quality, duration,
      audioStart: recordingStartTime,
      trimStart: speech ? speech.start : null,
      trimEnd: speech ? speech.end : null,
      blob: audioBlob,
      createdAt: Date.now()
    });
    finishRecordingProcessing(operation);
  };

  if (!window.DublineAudioDevices.live(recordingMic)) {
    finishRecording({ discard: true }); finishRecordingProcessing(operation);
    micSource.disconnect(); gainNode.disconnect(); voiceMeter.disconnect();
    audioDest.stream.getTracks().forEach(track => track.stop());
    showToast(t('audio.device.recordingInterrupted')); return;
  }
  try { recorder.start(100); }
  catch {
    finishRecording({ discard: true }); finishRecordingProcessing(operation);
    micSource.disconnect(); gainNode.disconnect(); voiceMeter.disconnect();
    audioDest.stream.getTracks().forEach(track => track.stop());
    showToast(t('error.mic')); return;
  }
  const playbackAt = performance.now() + holdSeconds * 1000;
  let lastProgressAt = playbackAt, lastVideoTime = startTime;
  const playbackFailed = () => {
    if (mediaRecorder !== recorder || recordState === 'idle') return;
    finishRecording({ discard: true });
    showToast(t('record.playbackFailed'));
  };
  const playForRecording = () => {
    if (mediaRecorder !== recorder || recordState === 'idle') return;
    try { video.play().catch(playbackFailed); } catch { playbackFailed(); }
  };
  socket.emit('recording_status', { lineId, recording: true, sessionId: recordingSessionId });
  btn.className = 'btn-prep';
  btn.innerText = t('record.preparing');
  startRecordCue(line, wantedPreRoll, holdSeconds, adrEnabled);
  if (adrEnabled) {
    // The beeps are first timed from the press of Record; once the video really starts
    // (after the seek, buffering or the held first frame) they are re-timed to its clock
    const retimeAdr = () => {
      if (mediaRecorder !== recorder || recordState !== 'preparing') return;
      adrCues.arm(Math.max(0, line.start - video.currentTime));
    };
    video.addEventListener('playing', retimeAdr, { once: true });
  }
  clearTimeout(recordPlayTimeout);
  if (holdSeconds > 0) {
    video.pause();
    recordPlayTimeout = setTimeout(() => {
      playForRecording();
    }, holdSeconds * 1000);
  } else {
    playForRecording();
  }
  if (recordState === 'idle') return;

  clearInterval(recordSpeechInterval);
  recordSpeechInterval = setInterval(() => {
    if (recordState === 'idle') return clearInterval(recordSpeechInterval);
    if (performance.now() < playbackAt || video.seeking) return;
    if (video.currentTime >= line.start - 0.05) {
      clearInterval(recordSpeechInterval);
      recordSpeechInterval = null;
      if (recordState === 'preparing') {
        recordState = 'recording';
        btn.className = 'btn-record recording-active';
        btn.innerText = t('record.speak');
      }
    }
  }, 25);

  // Recording doesn't stop at the original's timing: after the line ends we wait for the player to go quiet.
  // Safety limit: no longer than the line length (at least 4 s) past its end.
  const lineDuration = Math.max(0.5, line.end - line.start);
  const maxOverrun = Math.max(MIN_OVERRUN_LIMIT, lineDuration);
  const samples = new Float32Array(voiceMeter.fftSize);
  let noiseSum = 0;
  let noiseCount = 0;
  let lastVoiceAt = performance.now();

  recordStopTimeout = setInterval(() => {
    if (recordState === 'idle') return clearInterval(recordStopTimeout);
    if (performance.now() >= playbackAt) {
      if (Math.abs(video.currentTime - lastVideoTime) > 0.005) { lastVideoTime = video.currentTime; lastProgressAt = performance.now(); }
      if (video.error || (!video.ended && performance.now() - lastProgressAt > 8000)) return playbackFailed();
    }
    // An ended frame from the previous playback can linger during the seek.
    if (video.seeking) return;
    voiceMeter.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const level = Math.sqrt(sum / samples.length);

    const now = video.currentTime;
    // Measure microphone noise at the start of the pre-roll while the player is still silent
    if (performance.now() < playbackAt || now < line.start - 0.6) {
      noiseSum += level;
      noiseCount++;
    }
    const noise = noiseCount ? noiseSum / noiseCount : 0.003;
    // Voice threshold: clearly louder than the mic noise, but low enough for quiet phrase endings
    if (level > Math.max(noise * 2.5, 0.004)) lastVoiceAt = performance.now();

    // Keep measuring microphone noise during the held frame, but do not stop
    // preparation. After playback starts, an actual video ending still stops it.
    if (performance.now() < playbackAt) return;

    const pastLine = now - line.end;
    const silentFor = (performance.now() - lastVoiceAt) / 1000;
    if ((pastLine >= MIN_TAIL_AFTER_LINE && silentFor >= SILENCE_TO_STOP) || pastLine >= maxOverrun || video.ended) {
      finishRecording();
    }
  }, 50);
  } finally { recordStartPending = false; }
};

const MIN_TAIL_AFTER_LINE = 0.6; // seconds recorded after the line ends in any case
const SILENCE_TO_STOP = 0.8;     // seconds of silence after the line ends: the player has finished
const MIN_OVERRUN_LIMIT = 4;     // minimum time allowed to speak past the line

function finishRecording({ discard = false } = {}) {
  const operation = activeRecording;
  if (!operation) return;
  clearInterval(recordStopTimeout);
  clearTimeout(recordPlayTimeout);
  clearInterval(recordSpeechInterval);
  recordPlayTimeout = null;
  recordSpeechInterval = null;
  if (recordingLineId != null) socket.emit('recording_status', { lineId: recordingLineId, recording: false, sessionId: operation.sessionId });
  recordState = 'idle';
  if (window.refreshStudioTransport) window.refreshStudioTransport();
  operation.discarded = operation.discarded || discard;
  if (operation.discarded) socket.emit('reserve_take', { lineId: operation.lineId, sessionId: operation.sessionId, cancelSequence: operation.takeSequence }, () => {});
  discardTake = operation.discarded; // compatibility alias, never used by another operation's handler
  activeRecording = null;
  recordingLineId = null;
  operation.stream.getTracks().forEach(track => track.stop());
  window.DublineAudioDevices.release(operation.stream);
  if (micStream === operation.stream) micStream = null;

  video.pause();
  stopVisualizer();
  stopRecordCue();

  const btn = document.getElementById('recBtn');
  if (btn) {
    btn.className = 'btn-stop';
    btn.innerText = t('record.processing');
  }

  if (operation.recorder.state !== 'inactive') {
    operation.recorder.stop();
  } else {
    // No stop event arrives if a device disappears before recorder.start.
    finishRecordingProcessing(operation);
    if (selectedLine) showInspector(selectedLine);
  }
}

// ==========================================

window.deleteLineAudio = async function(lineId) {
  const line = session.lines.find(item => item.id === lineId);
  if (!line) return;
  const target = { sessionId: session.activeSessionId, audioUrl: line.audioUrl, takeId: line.takeId, historyRevision: line.takeHistoryRevision || 0, confirmPinned: line.takePinned === true };
  if (!await askConfirm(t(line.takePinned ? 'takeHistory.confirmPinned' : 'confirm.delete'), { danger: true })) return;
  const res = await fetch('/api/delete-line-audio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lineId, ...target, userName: myName, clientId, room: currentRoom })
  });
  if (!res.ok) alert(await readError(res));
};

window.updateUserMicGain = function(val) {
  userMicGain = val / 100;
  localStorage.setItem('dubline_mic_gain', userMicGain);
  const disp = document.getElementById('gainDisplay');
  if (disp) disp.innerText = `${val}%`;
};

// ==========================================
// VISUAL COUNTDOWN BEFORE RECORDING (silent)
// A bar sweeps across the video, three dots light up in turn, then "Speak!".
// Everything follows the video clock, so it never drifts from the picture.
// ==========================================
const recordCue = document.getElementById('recordCue');
const recordCueBar = document.getElementById('recordCueBar');
const recordCueLabel = document.getElementById('recordCueLabel');
const recordCueDots = [...recordCue.querySelectorAll('.cue-dot')];
let cueFrame = null;
const adrCues = window.DublineAdr.create(window.AudioContext || window.webkitAudioContext, () => adrCueVolume);

function startRecordCue(line, preRoll, holdSeconds = 0, adrEnabled = false) {
  stopRecordCue();
  if (!cueEnabled && !adrEnabled) return;
  if (adrEnabled) adrCues.arm(preRoll);
  recordCue.style.display = cueEnabled ? 'block' : 'none';
  const holdUntil = performance.now() + holdSeconds * 1000;

  const tick = () => {
    const now = video.currentTime;
    const holdLeft = Math.max(0, (holdUntil - performance.now()) / 1000);
    const untilSpeech = holdLeft + Math.max(0, line.start - now);
    let mode = 'ready';
    if (untilSpeech <= 0.02) mode = now <= line.end ? 'speak' : 'finish';

    recordCue.className = `record-cue ${mode === 'ready' ? '' : mode}`;
    recordCueBar.style.display = mode === 'ready' && preRoll > 0 ? 'block' : 'none';
    if (mode === 'ready') {
      const progress = preRoll > 0 ? Math.min(1, Math.max(0, 1 - untilSpeech / preRoll)) : 1;
      recordCueBar.style.left = `${progress * 100}%`;
      // Dots light up at 3/4, 2/4 and 1/4 of the pre-roll before the line
      recordCueDots.forEach((dot, i) => {
        dot.classList.toggle('on', untilSpeech <= ((recordCueDots.length - i) / (recordCueDots.length + 1)) * preRoll);
      });
    }
    recordCueLabel.textContent = t(mode === 'ready' ? 'cue.ready' : mode === 'speak' ? 'cue.speak' : 'cue.finish');
    cueFrame = requestAnimationFrame(tick);
  };
  tick();
}

function stopRecordCue() {
  cancelAnimationFrame(cueFrame);
  adrCues.stop();
  recordCue.style.display = 'none';
  recordCue.className = 'record-cue';
}

// ==========================================
// RELIABLE TAKE UPLOADS
// If the connection blinks, the take is not lost: it stays in the browser (IndexedDB) and
// is re-sent until the server accepts it. The server recognizes a repeat of the same
// upload by uploadId and doesn't store it twice.
// ==========================================
const pendingTakes = new Map(); // uploadId -> entry
let retryTimer = null;
let retryDelay = 2000;
let queuedToastShown = false;

function newUploadId() {
  return (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

const takeStore = (() => {
  const table = window.DublineLocalDatabase.store('pendingTakes');
  let warned = false;
  async function run(action) {
    try {
      return await action();
    } catch (err) {
      return null; // private mode etc.: keep the queue in memory only
    }
  }
  return {
    put: async entry => {
      const saved = { ...entry }; delete saved.sending; delete saved.resolving;
      const result = await run(() => table.put(saved));
      if (result === null && !warned) { warned = true; showToast(t('editor.failure.storage')); }
      return result;
    },
    remove: id => run(() => table.remove(id)),
    all: () => run(() => table.all())
  };
})();

function refreshPendingUi(lineId) {
  pendingTakeLines.clear();
  for (const entry of pendingTakes.values()) {
    if (!entry.sessionId || entry.sessionId === (session && session.activeSessionId)) pendingTakeLines.add(entry.lineId);
  }
  window.DublineNextLine?.refresh(); window.DublineSceneReview?.refresh();
  if (!session || !session.lines) return;
  const line = session.lines.find(l => l.id === lineId);
  if (line) updateLineBlock(line);
  if (selectedLine && selectedLine.id === lineId && recordState === 'idle') showInspector(selectedLine);
}

// The server will never accept this take: retrying is pointless
function isPermanentFailure(status) {
  return status === 400 || status === 403 || status === 404 || status === 410 || status === 413;
}

async function submitTake(entry) {
  if (!entry.takeSequence) entry.takeSequence = await reserveTake(entry.lineId, entry.sessionId);
  // A new take of the same line replaces the old unsent one
  for (const [id, old] of pendingTakes) {
    if (!old.historyIssue && old.lineId === entry.lineId && old.sessionId === entry.sessionId && id !== entry.uploadId) {
      if (old.takeSequence && (!entry.takeSequence || old.takeSequence > entry.takeSequence)) return false;
      pendingTakes.delete(id);
      takeStore.remove(id);
    }
  }
  pendingTakes.set(entry.uploadId, entry);
  takeStore.put(entry);
  refreshPendingUi(entry.lineId);
  return sendTake(entry);
}

function takePausedByEditMode(entry) {
  return !!session && session.mode === 'edit' &&
    (!entry.sessionId || entry.sessionId === session.activeSessionId);
}

async function sendTake(entry) {
  if (entry.historyIssue || entry.sending) return false;
  // Keep the finished blob locally while its session is being edited. A 409 here
  // would otherwise resend the entire recording on every backoff interval.
  if (takePausedByEditMode(entry)) {
    if (!queuedToastShown) {
      showToast(t('toast.takeQueued'));
      queuedToastShown = true;
    }
    return false;
  }

  if (!entry.takeSequence) {
    entry.takeSequence = await reserveTake(entry.lineId, entry.sessionId);
    if (!entry.takeSequence) { scheduleRetry(); return false; }
    await takeStore.put(entry);
  }

  const form = new FormData();
  form.append('lineId', entry.lineId);
  form.append('userName', entry.nick);
  form.append('clientId', clientId);
  form.append('uploadId', entry.uploadId);
  form.append('sessionId', entry.sessionId);
  form.append('takeSequence', entry.takeSequence);
  form.append('audioStart', entry.audioStart);
  if (entry.discardCurrentId) { form.append('discardCurrentId', entry.discardCurrentId); form.append('historyRevision', entry.historyRevision); }
  if (Number.isFinite(entry.duration)) form.append('duration', entry.duration);
  if (entry.trimStart != null && entry.trimEnd != null) {
    form.append('trimStart', entry.trimStart);
    form.append('trimEnd', entry.trimEnd);
  }
  if (entry.quality) form.append('quality', JSON.stringify(entry.quality));
  form.append('audio', entry.blob, 'take.webm');

  let res = null;
  entry.sending = true;
  try {
    res = await window.DublineNetwork.upload(`/api/upload-line-audio?room=${encodeURIComponent(entry.room)}`, { method: 'POST', body: form });
  } catch (err) {
    res = null; // network unavailable
  } finally { delete entry.sending; }

  if (res && res.ok) {
    const confirmed = await res.clone().json().catch(() => ({}));
    if (confirmed.cleanupError) showToast(t('takeHistory.cleanupError'));
    const wasRetry = entry.attempts > 0;
    pendingTakes.delete(entry.uploadId);
    takeStore.remove(entry.uploadId);
    refreshPendingUi(entry.lineId);
    window.DublineTakeAnalysis?.uploaded(entry, confirmed);
    if (wasRetry) showToast(t('toast.takeSent'));
    if (!pendingTakes.size) {
      retryDelay = 2000;
      queuedToastShown = false;
    }
    return true;
  }
  const error = res && await res.clone().json().catch(() => ({}));
  if (error?.key?.startsWith('takeHistory.') || error?.key?.startsWith('noise.') || error?.key === 'error.lineTaken') {
    entry.historyIssue = error.key === 'error.lineTaken' ? 'takeHistory.permission' : error.key;
    await takeStore.put(entry); refreshPendingUi(entry.lineId);
    showToast(t(entry.historyIssue)); return false;
  }

  // The server may switch modes a moment before this client receives session_updated.
  // Keep the take, but do not resend its full blob until a later mode/connection event.
  if (res && res.status === 409) {
    if (!queuedToastShown) {
      showToast(t('toast.takeQueued'));
      queuedToastShown = true;
    }
    return false;
  }

  if (res && res.status === 403 && (await res.clone().json().catch(() => ({}))).key === 'error.nickNotConfirmed') {
    // A rename/reconnect can be confirmed while this old request is in flight.
    // Keep the blob until nick_state provides the server-confirmed identity.
    entry.attempts = (entry.attempts || 0) + 1;
    scheduleRetry();
    return false;
  }

  if (res && isPermanentFailure(res.status)) {
    const reason = await readError(res);
    pendingTakes.delete(entry.uploadId);
    takeStore.remove(entry.uploadId);
    refreshPendingUi(entry.lineId);
    alert(t('toast.takeDropped', { reason }));
    return false;
  }

  // Connection dropped or the server/tunnel is temporarily down (502/503/504): try later
  entry.attempts = (entry.attempts || 0) + 1;
  if (!queuedToastShown) {
    showToast(t('toast.takeQueued'));
    queuedToastShown = true;
  }
  scheduleRetry();
  return false;
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(flushPendingTakes, retryDelay);
  retryDelay = Math.min(30000, retryDelay * 2);
}

async function flushPendingTakes() {
  clearTimeout(retryTimer);
  for (const entry of [...pendingTakes.values()]) {
    if (!pendingTakes.has(entry.uploadId)) continue;
    if (entry.historyIssue || entry.sending) continue;
    if (takePausedByEditMode(entry)) continue;
    if (!await sendTake(entry)) break; // the server is still down: stop trying for now
  }
}

window.retryPendingTakes = function() {
  retryDelay = 2000;
  flushPendingTakes();
};
window.takeHistoryPending = lineId => [...pendingTakes.values()].filter(entry => entry.historyIssue && entry.room === currentRoom && entry.sessionId === session?.activeSessionId && entry.lineId === lineId);
window.retryHistoryTake = async uploadId => {
  const entry = pendingTakes.get(uploadId), line = session?.lines.find(line => line.id === entry?.lineId);
  if (!entry || !entry.historyIssue || entry.resolving || !line || entry.room !== currentRoom || entry.sessionId !== session.activeSessionId || getLineOwner(line) !== myName || !socket.connected || recordState !== 'idle') return;
  entry.resolving = true;
  try {
    const expectedTakeId = line.takeId || null, historyRevision = line.takeHistoryRevision || 0;
    const consent = await window.DublineTakeHistory.beforeRecord(line);
    if (!consent || entry.sessionId !== session?.activeSessionId || entry.room !== currentRoom || getLineOwner(session.lines.find(item => item.id === entry.lineId)) !== myName) return;
    const sequence = await reserveTake(entry.lineId, entry.sessionId, { historyResume: true, expectedTakeId, historyRevision });
    if (!sequence) return;
    entry.takeSequence = sequence; entry.nick = myName;
    delete entry.historyIssue; delete entry.discardCurrentId; delete entry.historyRevision;
    Object.assign(entry, consent); await takeStore.put(entry); refreshPendingUi(entry.lineId);
    await sendTake(entry);
  } finally { delete entry.resolving; }
};
window.discardHistoryTake = async uploadId => {
  const entry = pendingTakes.get(uploadId); if (!entry?.historyIssue || entry.resolving) return;
  if (!await askConfirm(t('takeHistory.confirmDiscardLocal'), { danger: true })) return;
  pendingTakes.delete(uploadId); await takeStore.remove(uploadId); refreshPendingUi(entry.lineId);
};

window.onRecordingModeChanged = function(mode) {
  clearTimeout(retryTimer);
  if (mode !== 'dub' || !pendingTakes.size) return;
  retryDelay = 2000;
  setTimeout(flushPendingTakes, 0);
};

let confirmedRecordingNick = null;
window.onRecordingNickConfirmed = function(nick) {
  confirmedRecordingNick = nick;
  for (const operation of processingRecordings) if (operation.room === currentRoom) operation.nick = nick;
  for (const entry of pendingTakes.values()) {
    if (entry.room !== currentRoom) continue;
    entry.nick = nick;
    takeStore.put(entry);
  }
  onConnectionRestored();
};

// The connection is back: send whatever has queued up (called from room.js when the socket connects)
function onConnectionRestored() {
  if (!pendingTakes.size) return;
  retryDelay = 2000;
  setTimeout(flushPendingTakes, 500);
}

// Takes not sent before the page was reloaded
takeStore.all().then(entries => {
  (entries || []).filter(entry => entry.room === currentRoom).forEach(entry => {
    if (confirmedRecordingNick) { entry.nick = confirmedRecordingNick; takeStore.put(entry); }
    if (!pendingTakes.has(entry.uploadId)) pendingTakes.set(entry.uploadId, entry);
  });
  if (pendingTakes.size) {
    pendingTakes.forEach(entry => pendingTakeLines.add(entry.lineId));
    setTimeout(flushPendingTakes, 1500);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (!pendingTakes.size) return;
  e.preventDefault();
  e.returnValue = t('unload.pendingTakes');
});
