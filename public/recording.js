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

window.handleStudioRecord = async function(lineId) {
  const line = session.lines.find(l => l.id === lineId);
  const btn = document.getElementById('recBtn');
  if (!line || !btn) return;

  const owner = getLineOwner(line);
  if (owner !== myName) {
    alert(t('error.notOwner'));
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

  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  const micSource = audioCtx.createMediaStreamSource(micStream);
  const gainNode = audioCtx.createGain();
  gainNode.gain.value = userMicGain;
  const audioDest = audioCtx.createMediaStreamDestination();
  micSource.connect(gainNode);
  gainNode.connect(audioDest);

  startVisualizer(micStream);

  const preRoll = Math.min(1.0, line.start);
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
  btn.className = 'btn-prep';
  btn.innerText = t('record.preparing');
  video.play();

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
  recordState = 'idle';
  if (discard) discardTake = true;

  video.pause();
  stopVisualizer();

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
