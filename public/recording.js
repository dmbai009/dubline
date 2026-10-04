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

window.handleStudioRecord = async function(lineId) {
  const line = session.lines.find(l => l.id === lineId);
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

  const btn = document.getElementById('recBtn');
  if (!btn) return;

  if (watchMode && recordState === 'idle') {
    showToast(t('watch.noRecord'));
    return;
  }

  if (recordState === 'recording' || recordState === 'preparing') {
    finishRecording();
    return;
  }

  const recordingSessionId = session.activeSessionId || '';
  const recordingRoom = currentRoom;
  const recordingNick = myName;
  let recordingMic;
  try {
    recordingMic = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: noiseSuppression,
        noiseSuppression,
        autoGainControl: false,
        channelCount: 1
      }
    });
  } catch (err) {
    alert(t('error.mic'));
    return;
  }
  // The microphone permission prompt can outlive a mode/session/ownership change.
  const currentLine = session && session.lines.find(item => item.id === lineId);
  if (recordState !== 'idle' || !session || session.mode === 'edit' || watchMode ||
      (session.activeSessionId || '') !== recordingSessionId || myName !== recordingNick ||
      !currentLine || getLineOwner(currentLine) !== recordingNick) {
    recordingMic.getTracks().forEach(track => track.stop());
    return;
  }
  micStream = recordingMic;

  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  const micSource = audioCtx.createMediaStreamSource(micStream);
  const gainNode = audioCtx.createGain();
  gainNode.gain.value = userMicGain;
  const audioDest = audioCtx.createMediaStreamDestination();
  micSource.connect(gainNode);
  gainNode.connect(audioDest);
  // A separate voice level analyser tells us when the player has finished speaking
  const voiceMeter = audioCtx.createAnalyser();
  voiceMeter.fftSize = 2048;
  gainNode.connect(voiceMeter);

  startVisualizer(micStream);

  const wantedPreRoll = Math.max(0, Math.min(5, Number(preRollSeconds) || 0));
  const videoPreRoll = Math.min(wantedPreRoll, line.start);
  const holdSeconds = Math.max(0, wantedPreRoll - videoPreRoll);
  const playbackAt = performance.now() + holdSeconds * 1000;
  const startTime = Number((line.start - videoPreRoll).toFixed(3));
  const recordingStartTime = Number((startTime - holdSeconds).toFixed(3));
  currentRecordingStartTime = recordingStartTime;
  video.currentTime = startTime;

  recordState = 'preparing';
  audioChunks = [];
  discardTake = false;
  recordingLineId = lineId;

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
  mediaRecorder = mimeType ? new MediaRecorder(audioDest.stream, { mimeType }) : new MediaRecorder(audioDest.stream);

  mediaRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }

    recordingLineId = null;

    // Recording was interrupted by the host: don't save the take
    if (discardTake) {
      discardTake = false;
      if (selectedLine) showInspector(selectedLine);
      return;
    }

    const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    if (audioBlob.size === 0) {
      alert(t('error.emptyAudio'));
      btn.className = 'btn-record';
      btn.innerText = t('record.retry');
      return;
    }

    // Silence detection: find where speech starts and ends in the recording
    btn.innerText = t('record.trim');
    let speech = null;
    try {
      speech = detectSpeechBounds(await decodeAudio(await audioBlob.arrayBuffer()));
    } catch (err) {
      console.warn('[Dubline] Could not analyse the take:', err);
    }

    btn.innerText = t('record.saving');
    await submitTake({
      uploadId: newUploadId(),
      room: recordingRoom,
      sessionId: recordingSessionId,
      lineId,
      nick: recordingNick,
      audioStart: recordingStartTime,
      trimStart: speech ? speech.start : null,
      trimEnd: speech ? speech.end : null,
      blob: audioBlob,
      createdAt: Date.now()
    });
  };

  mediaRecorder.start(100);
  socket.emit('recording_status', { lineId, recording: true });
  btn.className = 'btn-prep';
  btn.innerText = t('record.preparing');
  clearTimeout(recordPlayTimeout);
  if (holdSeconds > 0) {
    video.pause();
    recordPlayTimeout = setTimeout(() => {
      if (recordState !== 'idle') video.play().catch(() => {});
    }, holdSeconds * 1000);
  } else {
    video.play().catch(() => {}); // recording may have been stopped right away: not an error
  }
  startRecordCue(line, wantedPreRoll, holdSeconds);

  const checkSpeechInterval = setInterval(() => {
    if (performance.now() < playbackAt) return;
    if (video.currentTime >= line.start - 0.05) {
      clearInterval(checkSpeechInterval);
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
    voiceMeter.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const level = Math.sqrt(sum / samples.length);

    const now = video.currentTime;
    // Measure microphone noise at the start of the pre-roll while the player is still silent
    if (now < line.start - 0.6) {
      noiseSum += level;
      noiseCount++;
    }
    const noise = noiseCount ? noiseSum / noiseCount : 0.003;
    // Voice threshold: clearly louder than the mic noise, but low enough for quiet phrase endings
    if (level > Math.max(noise * 2.5, 0.004)) lastVoiceAt = performance.now();

    const pastLine = now - line.end;
    const silentFor = (performance.now() - lastVoiceAt) / 1000;
    if ((pastLine >= MIN_TAIL_AFTER_LINE && silentFor >= SILENCE_TO_STOP) || pastLine >= maxOverrun || video.ended) {
      finishRecording();
    }
  }, 50);
};

const MIN_TAIL_AFTER_LINE = 0.6; // seconds recorded after the line ends in any case
const SILENCE_TO_STOP = 0.8;     // seconds of silence after the line ends: the player has finished
const MIN_OVERRUN_LIMIT = 4;     // minimum time allowed to speak past the line

function finishRecording({ discard = false } = {}) {
  clearInterval(recordStopTimeout);
  clearTimeout(recordPlayTimeout);
  if (recordingLineId != null) socket.emit('recording_status', { lineId: recordingLineId, recording: false });
  recordState = 'idle';
  if (discard) discardTake = true;

  video.pause();
  stopVisualizer();
  stopRecordCue();

  const btn = document.getElementById('recBtn');
  if (btn) {
    btn.className = 'btn-stop';
    btn.innerText = t('record.processing');
  }

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
}

// ==========================================

window.deleteLineAudio = async function(lineId) {
  if (!confirm(t('confirm.delete'))) return;
  const res = await fetch('/api/delete-line-audio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lineId, userName: myName, clientId, room: currentRoom })
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

function startRecordCue(line, preRoll, holdSeconds = 0) {
  stopRecordCue();
  if (!cueEnabled) return;
  recordCue.style.display = 'block';
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
  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open('dubline', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('pendingTakes', { keyPath: 'uploadId' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return dbPromise;
  }
  async function run(mode, action) {
    try {
      const database = await db();
      return await new Promise((resolve, reject) => {
        const tx = database.transaction('pendingTakes', mode);
        const request = action(tx.objectStore('pendingTakes'));
        tx.oncomplete = () => resolve(request ? request.result : undefined);
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      return null; // private mode etc.: keep the queue in memory only
    }
  }
  return {
    put: entry => run('readwrite', store => store.put(entry)),
    remove: id => run('readwrite', store => store.delete(id)),
    all: () => run('readonly', store => store.getAll())
  };
})();

function isPendingLine(lineId) {
  const sessionId = session && session.activeSessionId;
  return [...pendingTakes.values()].some(entry => entry.lineId === lineId && (!entry.sessionId || entry.sessionId === sessionId));
}

function refreshPendingUi(lineId) {
  pendingTakeLines.clear();
  for (const entry of pendingTakes.values()) {
    if (!entry.sessionId || entry.sessionId === (session && session.activeSessionId)) pendingTakeLines.add(entry.lineId);
  }
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
  // A new take of the same line replaces the old unsent one
  for (const [id, old] of pendingTakes) {
    if (old.lineId === entry.lineId && old.sessionId === entry.sessionId && id !== entry.uploadId) {
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
  // Keep the finished blob locally while its session is being edited. A 409 here
  // would otherwise resend the entire recording on every backoff interval.
  if (takePausedByEditMode(entry)) {
    if (!queuedToastShown) {
      showToast(t('toast.takeQueued'));
      queuedToastShown = true;
    }
    return false;
  }

  const form = new FormData();
  form.append('lineId', entry.lineId);
  form.append('userName', entry.nick);
  form.append('clientId', clientId);
  form.append('uploadId', entry.uploadId);
  form.append('sessionId', entry.sessionId);
  form.append('audioStart', entry.audioStart);
  if (entry.trimStart != null && entry.trimEnd != null) {
    form.append('trimStart', entry.trimStart);
    form.append('trimEnd', entry.trimEnd);
  }
  form.append('audio', entry.blob, 'take.webm');

  let res = null;
  try {
    res = await fetch(`/api/upload-line-audio?room=${encodeURIComponent(entry.room)}`, { method: 'POST', body: form });
  } catch (err) {
    res = null; // network unavailable
  }

  if (res && res.ok) {
    const wasRetry = entry.attempts > 0;
    pendingTakes.delete(entry.uploadId);
    takeStore.remove(entry.uploadId);
    refreshPendingUi(entry.lineId);
    if (wasRetry) showToast(t('toast.takeSent'));
    if (!pendingTakes.size) {
      retryDelay = 2000;
      queuedToastShown = false;
    }
    return true;
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
    if (takePausedByEditMode(entry)) continue;
    if (!await sendTake(entry)) break; // the server is still down: stop trying for now
  }
}

window.retryPendingTakes = function() {
  retryDelay = 2000;
  flushPendingTakes();
};

window.onRecordingModeChanged = function(mode) {
  clearTimeout(retryTimer);
  if (mode !== 'dub' || !pendingTakes.size) return;
  retryDelay = 2000;
  setTimeout(flushPendingTakes, 0);
};

// The connection is back: send whatever has queued up (called from room.js when the socket connects)
function onConnectionRestored() {
  if (!pendingTakes.size) return;
  retryDelay = 2000;
  setTimeout(flushPendingTakes, 500);
}

// Takes not sent before the page was reloaded
takeStore.all().then(entries => {
  (entries || []).filter(entry => entry.room === currentRoom).forEach(entry => pendingTakes.set(entry.uploadId, entry));
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
