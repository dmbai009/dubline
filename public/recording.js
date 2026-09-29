// ==========================================
// RECORDING
// Запись дубля с микрофона, визуализатор, автообрезка тишины
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

// Подготовка перед репликой: видео отматывается назад, игрок успевает сориентироваться
const PRE_ROLL = 2.0;

window.handleStudioRecord = async function(lineId) {
  const line = session.lines.find(l => l.id === lineId);
  if (!line) return;

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

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
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
  // Пока спрашивали разрешение на микрофон, запись могли начать заново — проверяем
  if (recordState !== 'idle') return;

  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  const micSource = audioCtx.createMediaStreamSource(micStream);
  const gainNode = audioCtx.createGain();
  gainNode.gain.value = userMicGain;
  const audioDest = audioCtx.createMediaStreamDestination();
  micSource.connect(gainNode);
  gainNode.connect(audioDest);

  startVisualizer(micStream);

  const preRoll = Math.min(PRE_ROLL, line.start);
  const startTime = Number((line.start - preRoll).toFixed(2));
  currentRecordingStartTime = startTime;
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

    // Запись прервана хостом — дубль не сохраняем
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

    // Автоопределение тишины: ищем, где в записи начинается и заканчивается речь
    btn.innerText = t('record.trim');
    let speech = null;
    try {
      speech = detectSpeechBounds(await decodeAudio(await audioBlob.arrayBuffer()));
    } catch (err) {
      console.warn('[Dubline] Не удалось проанализировать дубль:', err);
    }

    btn.innerText = t('record.saving');
    await submitTake({
      uploadId: newUploadId(),
      room: currentRoom,
      sessionId: session.activeSessionId || '',
      lineId,
      nick: myName,
      audioStart: currentRecordingStartTime,
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
  video.play().catch(() => {}); // запись могли сразу прервать (пауза у всех) — это не ошибка
  startRecordCue(line, preRoll);

  const checkSpeechInterval = setInterval(() => {
    if (video.currentTime >= line.start - 0.05) {
      clearInterval(checkSpeechInterval);
      if (recordState === 'preparing') {
        recordState = 'recording';
        btn.className = 'btn-record recording-active';
        btn.innerText = t('record.speak');
      }
    }
  }, 25);

  const lineDuration = Math.max(0.5, line.end - line.start);
  const totalRecordTimeMs = (preRoll + lineDuration + 1.0) * 1000;

  recordStopTimeout = setTimeout(() => {
    if (recordState === 'recording' || recordState === 'preparing') finishRecording();
  }, totalRecordTimeMs);
};

function finishRecording({ discard = false } = {}) {
  clearTimeout(recordStopTimeout);
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
// ВИЗУАЛЬНЫЙ ОТСЧЁТ ПЕРЕД ЗАПИСЬЮ (без звука)
// Полоса проходит по видео, три точки загораются по очереди, затем «Говорите!».
// Все привязано ко времени видео, поэтому не разъезжается с картинкой.
// ==========================================
const recordCue = document.getElementById('recordCue');
const recordCueBar = document.getElementById('recordCueBar');
const recordCueLabel = document.getElementById('recordCueLabel');
const recordCueDots = [...recordCue.querySelectorAll('.cue-dot')];
let cueFrame = null;

function startRecordCue(line, preRoll) {
  stopRecordCue();
  if (!cueEnabled) return;
  recordCue.style.display = 'block';

  const tick = () => {
    const now = video.currentTime;
    const untilSpeech = line.start - now;
    let mode = 'ready';
    if (untilSpeech <= 0.02) mode = now <= line.end ? 'speak' : 'finish';

    recordCue.className = `record-cue ${mode === 'ready' ? '' : mode}`;
    recordCueBar.style.display = mode === 'ready' && preRoll > 0 ? 'block' : 'none';
    if (mode === 'ready') {
      const progress = preRoll > 0 ? Math.min(1, Math.max(0, 1 - untilSpeech / preRoll)) : 1;
      recordCueBar.style.left = `${progress * 100}%`;
      // Точки загораются за 3/4, 2/4 и 1/4 подготовки до реплики
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
// НАДЕЖНАЯ ОТПРАВКА ДУБЛЕЙ
// Если связь моргнула, дубль не теряется: он лежит в браузере (IndexedDB) и
// отправляется повторно, пока сервер его не примет. Повтор той же отправки
// сервер узнает по uploadId и второй раз не сохраняет.
// ==========================================
const pendingTakes = new Map(); // uploadId -> запись
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
      return null; // приватный режим и т.п. — остаемся с очередью в памяти
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

// Сервер точно не примет этот дубль — повторять бессмысленно
function isPermanentFailure(status) {
  return status === 400 || status === 403 || status === 404 || status === 410 || status === 413;
}

async function submitTake(entry) {
  // Новый дубль той же реплики заменяет старый неотправленный
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

async function sendTake(entry) {
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
    res = null; // сеть недоступна
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

  if (res && isPermanentFailure(res.status)) {
    const reason = await readError(res);
    pendingTakes.delete(entry.uploadId);
    takeStore.remove(entry.uploadId);
    refreshPendingUi(entry.lineId);
    alert(t('toast.takeDropped', { reason }));
    return false;
  }

  // Обрыв связи или сервер/туннель временно недоступен (502/503/504) — попробуем позже
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
    if (!await sendTake(entry)) break; // сервер все еще недоступен — дальше не ломимся
  }
}

window.retryPendingTakes = function() {
  retryDelay = 2000;
  flushPendingTakes();
};

// Связь вернулась — сразу отправляем, что накопилось (вызывается из room.js при подключении сокета)
function onConnectionRestored() {
  if (!pendingTakes.size) return;
  retryDelay = 2000;
  setTimeout(flushPendingTakes, 500);
}

// Дубли, не отправленные до перезагрузки страницы
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
