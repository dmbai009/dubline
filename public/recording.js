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

    const formData = new FormData();
    formData.append('lineId', lineId);
    formData.append('userName', myName);
    formData.append('clientId', clientId);
    formData.append('audioStart', currentRecordingStartTime);
    if (speech) {
      formData.append('trimStart', speech.start);
      formData.append('trimEnd', speech.end);
    }
    formData.append('audio', audioBlob);

    btn.innerText = t('record.saving');
    const res = await fetch(`/api/upload-line-audio?room=${encodeURIComponent(currentRoom)}`, { method: 'POST', body: formData });
    if (!res.ok) {
      alert(await readError(res));
      showInspector(line);
      return;
    }
    const resData = await res.json();

    if (resData.success) {
      const fresh = session.lines.find(l => l.id === lineId) || line;
      selectedLine = fresh;
      showInspector(fresh);
    }
  };

  mediaRecorder.start(100);
  socket.emit('recording_status', { lineId, recording: true });
  btn.className = 'btn-prep';
  btn.innerText = t('record.preparing');
  video.play();
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
