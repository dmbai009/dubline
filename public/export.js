// ==========================================
// EXPORT
// Сведение звука, рендер видео (WebCodecs / реальное время), стемы
// ==========================================
// БЕЗОПАСНЫЙ СТУДИЙНЫЙ РЕНДЕР
// ==========================================
const renderDubVol = document.getElementById('renderDubVol');
const renderBackingVol = document.getElementById('renderBackingVol');
const renderOrigVol = document.getElementById('renderOrigVol');
const renderDubVal = document.getElementById('renderDubVal');
const renderBackingVal = document.getElementById('renderBackingVal');
const renderOrigVal = document.getElementById('renderOrigVal');

renderDubVol.oninput = () => renderDubVal.innerText = `${renderDubVol.value}%`;
renderBackingVol.oninput = () => renderBackingVal.innerText = `${renderBackingVol.value}%`;
renderOrigVol.oninput = () => renderOrigVal.innerText = `${renderOrigVol.value}%`;

window.openRenderModal = function() {
  if (!session || !session.loaded) {
    alert(t('error.noScene'));
    return;
  }
  openFilesModal();
  switchFilesTab('export');
};

window.closeRenderModal = function() {
  closeFilesModal();
};

function readRenderGains() {
  return {
    dub: renderDubVol.value / 100,
    backing: renderBackingVol.value / 100,
    original: renderOrigVol.value / 100
  };
}

function downloadBlob(blob, ext) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Dubline_${session.title}_export.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Офлайн-сведение всей звуковой дорожки: интершум + оригинал + дубли с эффектами и обрезкой
async function mixSoundtrack(duration, gains, onStep) {
  const rate = 48000;
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * rate)), rate);

  // Мягкий лимитер на мастере, чтобы громкие места не хрипели после кодирования
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -2;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;
  limiter.connect(ctx.destination);

  const backingBus = ctx.createGain();
  const originalBus = ctx.createGain();
  backingBus.connect(limiter);
  originalBus.connect(limiter);
  const hasSeparateBacking = !!session.backingUrl;
  const backingBase = hasSeparateBacking ? gains.backing : 0;
  const originalBase = hasSeparateBacking ? gains.original : gains.backing;
  backingBus.gain.value = backingBase;
  originalBus.gain.value = originalBase;

  const place = (buffer, gain, when, from = 0, to = buffer ? buffer.duration : 0, destination = limiter) => {
    if (!buffer || gain <= 0) return;
    to = Math.min(to, buffer.duration);
    if (to <= from) return;
    const skip = Math.max(0, -when);
    if (from + skip >= to) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(destination);
    src.start(Math.max(0, when), from + skip, to - from - skip);
  };

  if (session.backingUrl && backingBase > 0) {
    onStep(t('render.decodeBackground'));
    place(await fetchAndDecode(mediaUrl(session.backingUrl)).catch(() => null), 1, 0, 0, Infinity, backingBus);
  }
  // Оригинал — выбранная звуковая дорожка видео (если их несколько) или звук самого видео
  const originalTrack = selectedOriginalTrack();
  const originalUrl = originalTrack === undefined ? session.videoUrl : originalTrack && originalTrack.url;
  if (originalUrl && originalBase > 0) {
    onStep(t('render.decodeOriginal'));
    place(await fetchAndDecode(mediaUrl(originalUrl)).catch(() => null), 1, 0, 0, Infinity, originalBus);
  }

  const takes = session.lines.filter(l => l.audioUrl);
  const duckIntervals = [];
  for (let i = 0; i < takes.length; i++) {
    onStep(t('render.takes', { current: i + 1, total: takes.length }));
    const line = takes[i];
    const buffer = await getProcessedTake(line);
    if (!buffer) continue;
    const { from, to } = takeBounds(line, buffer.duration);
    place(buffer, gains.dub, takeStartTime(line) + from, from, to);
    duckIntervals.push([Math.max(0, takeStartTime(line) + from), Math.min(duration, takeStartTime(line) + to)]);
  }

  if (autoDuckEnabled && autoDuckAmount > 0 && duckIntervals.length) {
    duckIntervals.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const interval of duckIntervals) {
      const last = merged[merged.length - 1];
      if (last && interval[0] <= last[1] + 0.25) last[1] = Math.max(last[1], interval[1]);
      else merged.push([...interval]);
    }
    const automateDuck = (param, base) => {
      if (base <= 0) return;
      const ducked = base * (1 - autoDuckAmount);
      param.setValueAtTime(base, 0);
      merged.forEach(([start, end]) => {
        param.setValueAtTime(base, Math.max(0, start));
        param.linearRampToValueAtTime(ducked, Math.min(duration, start + 0.08));
        param.setValueAtTime(ducked, Math.max(start + 0.08, end));
        param.linearRampToValueAtTime(base, Math.min(duration, end + 0.25));
      });
    };
    automateDuck(backingBus.gain, backingBase);
    automateDuck(originalBus.gain, originalBase);
  }

  onStep(t('render.mix'));
  return ctx.startRendering();
}

function audioBufferToWav(buffer) {
  const channels = buffer.numberOfChannels;
  const rate = buffer.sampleRate;
  const frames = buffer.length;
  const bytesPerSample = 2;
  const dataBytes = frames * channels * bytesPerSample;
  const out = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(out);
  const write = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true); view.setUint16(34, 16, true); write(36, 'data');
  view.setUint32(40, dataBytes, true);
  const channelData = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const sample = Math.max(-1, Math.min(1, channelData[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return out;
}

async function renderCharacterStem(lines, duration, sampleRate = 48000) {
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(duration * sampleRate)), sampleRate);
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.connect(ctx.destination);
  for (const line of lines) {
    const buffer = await getProcessedTake(line);
    if (!buffer) continue;
    const { from, to } = takeBounds(line, buffer.duration);
    const when = takeStartTime(line) + from;
    const skip = Math.max(0, -when);
    if (from + skip >= to) continue;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(limiter);
    source.start(Math.max(0, when), from + skip, to - from - skip);
  }
  return ctx.startRendering();
}

window.downloadReaperStems = async function() {
  if (!session || !session.loaded) return alert(t('error.noScene'));
  const takes = session.lines.filter(line => line.audioUrl);
  if (!takes.length) return alert(t('error.noTakes'));
  const grouped = new Map();
  takes.forEach(line => {
    if (!grouped.has(line.character)) grouped.set(line.character, []);
    grouped.get(line.character).push(line);
  });
  const status = document.getElementById('stemsStatus');
  const button = document.getElementById('downloadStemsBtn');
  status.style.display = 'block';
  status.style.color = '#a78bfa';
  button.disabled = true;
  try {
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      await new Promise(resolve => {
        const done = () => resolve();
        video.addEventListener('loadedmetadata', done, { once: true });
        setTimeout(done, 5000);
        video.load();
      });
    }
    const duration = Math.max(Number(video.duration) || 0, ...takes.map(line => takeStartTime(line) + Math.max(1, line.end - line.start) + 1));
    const zip = new JSZip();
    const manifest = [];
    let index = 0;
    for (const [character, lines] of grouped) {
      index++;
      status.textContent = t('stems.progress', { current: index, total: grouped.size, name: character });
      const stem = await renderCharacterStem(lines, duration);
      const safeName = String(character || `Character_${index}`).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80);
      zip.file(`${String(index).padStart(2, '0')}_${safeName}.wav`, audioBufferToWav(stem));
      lines.forEach(line => manifest.push(`${character}\t${takeStartTime(line).toFixed(3)}\t${line.id}\t${line.caption || ''}`));
    }
    zip.file('timeline.tsv', `character\tstart_seconds\tline_id\tcaption\n${manifest.join('\n')}\n`);
    status.textContent = t('stems.mixing');
    const archive = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } });
    const safeProject = String(session.title || 'dubline').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
    const url = URL.createObjectURL(archive);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeProject}_stems.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status.textContent = t('stems.done');
    status.style.color = '#10b981';
  } catch (err) {
    status.textContent = t('error.generic', { message: err.message });
    status.style.color = '#ef4444';
  } finally {
    button.disabled = false;
  }
};

function sliceAudioBuffer(buffer, fromSample, toSample) {
  const length = Math.max(1, toSample - fromSample);
  const chunk = new AudioBuffer({ length, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    chunk.copyToChannel(buffer.getChannelData(c).subarray(fromSample, toSample), c);
  }
  return chunk;
}

function supportsWebCodecsRender() {
  return typeof window.AudioEncoder === 'function' && typeof window.EncodedVideoChunk === 'function';
}

// Рендер через WebCodecs: видеодорожка копируется без перекодирования, звук кодируется AudioEncoder'ом.
// Работает в разы быстрее реального времени и не зависит от того, свернута ли вкладка.
async function renderWithWebCodecs(progress) {
  const mb = await import('/vendor/mediabunny/mediabunny.min.mjs');

  progress(1, t('render.readVideo'));
  // Если видео выбрано с диска — читаем его локально, а не через туннель
  const source = localMedia && localMedia.forVideoUrl === session.videoUrl
    ? new mb.BlobSource(localMedia.videoBlob)
    : new mb.UrlSource(session.videoUrl);
  const input = new mb.Input({ source, formats: mb.ALL_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error(t('render.noVideo'));
  const videoCodec = await videoTrack.getCodec();
  const decoderConfig = await videoTrack.getDecoderConfig();
  const duration = await videoTrack.computeDuration();
  if (!videoCodec || !decoderConfig) throw new Error(t('render.unknownCodec'));

  const soundtrack = await mixSoundtrack(duration, readRenderGains(), text => progress(5, text));

  const audioCodec = await mb.getFirstEncodableAudioCodec(['aac', 'opus'], {
    numberOfChannels: soundtrack.numberOfChannels,
    sampleRate: soundtrack.sampleRate
  });
  if (!audioCodec) throw new Error(t('render.noAudioCodec'));

  const output = new mb.Output({
    format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new mb.BufferTarget()
  });
  const videoSource = new mb.EncodedVideoPacketSource(videoCodec);
  const audioSource = new mb.AudioBufferSource({ codec: audioCodec, quality: mb.QUALITY_HIGH });
  output.addVideoTrack(videoSource);
  output.addAudioTrack(audioSource);
  await output.start();

  // Звук добавляем порциями вперемешку с видео, чтобы дорожки в файле шли чередуясь
  const rate = soundtrack.sampleRate;
  let audioPos = 0;
  const pushAudioUntil = async (seconds) => {
    const target = Math.min(soundtrack.length, Math.ceil(seconds * rate));
    while (audioPos < target) {
      const next = Math.min(target, audioPos + rate);
      await audioSource.add(sliceAudioBuffer(soundtrack, audioPos, next));
      audioPos = next;
    }
  };

  const sink = new mb.EncodedPacketSink(videoTrack);
  let first = true;
  let lastUiUpdate = 0;
  for await (const packet of sink.packets()) {
    await videoSource.add(packet, first ? { decoderConfig } : undefined);
    first = false;
    await pushAudioUntil(packet.timestamp + 1);

    const now = performance.now();
    if (now - lastUiUpdate > 100) {
      lastUiUpdate = now;
      const pct = Math.min(95, 10 + 85 * (packet.timestamp / duration));
      progress(pct, t('render.mp4Progress', { current: Math.round(packet.timestamp), total: Math.round(duration) }));
    }
  }
  await pushAudioUntil(Infinity);

  videoSource.close();
  audioSource.close();
  progress(97, t('render.finalize'));
  await output.finalize();
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}

// Запасной вариант для браузеров без WebCodecs: запись с экрана в реальном времени
async function renderRealtime(progress) {
  const duration = video.duration;
  const soundtrack = await mixSoundtrack(duration, readRenderGains(), text => progress(2, text));

  const renderCanvas = document.createElement('canvas');
  renderCanvas.width = video.videoWidth || 1280;
  renderCanvas.height = video.videoHeight || 720;
  const ctx = renderCanvas.getContext('2d');

  const actx = new (window.AudioContext || window.webkitAudioContext)();
  const dest = actx.createMediaStreamDestination();
  const mixSource = actx.createBufferSource();
  mixSource.buffer = soundtrack;
  mixSource.connect(dest);

  const combinedStream = new MediaStream([
    ...renderCanvas.captureStream(30).getVideoTracks(),
    ...dest.stream.getAudioTracks()
  ]);

  const mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')
    ? 'video/mp4;codecs=avc1,mp4a.40.2'
    : (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm');

  const recorder = new MediaRecorder(combinedStream, { mimeType });
  const recordedChunks = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
  const stopped = new Promise(resolve => { recorder.onstop = resolve; });

  const savedMuted = video.muted;
  video.muted = true;
  video.currentTime = 0;
  await new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));

  recorder.start();
  await video.play();
  mixSource.start();

  await new Promise(resolve => {
    function drawRenderFrame() {
      ctx.drawImage(video, 0, 0, renderCanvas.width, renderCanvas.height);
      const pct = (video.currentTime / duration) * 100;
      progress(pct, t('render.realtimeProgress', { current: Math.round(video.currentTime), total: Math.round(duration) }));
      if (video.ended || video.currentTime >= duration - 0.1) return resolve();
      requestAnimationFrame(drawRenderFrame);
    }
    requestAnimationFrame(drawRenderFrame);
  });

  video.pause();
  video.muted = savedMuted;
  recorder.stop();
  await stopped;
  actx.close();

  return { blob: new Blob(recordedChunks, { type: mimeType }), ext: mimeType.includes('mp4') ? 'mp4' : 'webm' };
}

window.startVideoRender = async function() {
  const startBtn = document.getElementById('startRenderBtn');
  const progressBox = document.getElementById('renderProgressBox');
  const progressBar = document.getElementById('renderProgressBar');
  const statusText = document.getElementById('renderStatusText');

  const progress = (pct, text) => {
    progressBar.style.width = `${pct}%`;
    statusText.innerText = `⏳ ${text}`;
  };

  startBtn.disabled = true;
  progressBox.style.display = 'block';
  video.pause();
  renderInProgress = true;
  applyVolumes();
  const startedAt = performance.now();

  try {
    let result = null;
    if (supportsWebCodecsRender()) {
      try {
        result = { blob: await renderWithWebCodecs(progress), ext: 'mp4' };
      } catch (err) {
        console.error('[Dubline] WebCodecs-рендер не удался, переключаюсь на запись в реальном времени:', err);
        progress(0, t('render.fallback'));
      }
    }
    if (!result) result = await renderRealtime(progress);

    downloadBlob(result.blob, result.ext);
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    progressBar.style.width = '100%';
    statusText.innerText = t('render.done', { seconds });
    setTimeout(() => {
      closeRenderModal();
      progressBox.style.display = 'none';
    }, 2000);
  } catch (err) {
    console.error('[Dubline] Ошибка рендера:', err);
    statusText.innerText = t('render.error', { message: err.message });
  } finally {
    renderInProgress = false;
    applyVolumes();
    startBtn.disabled = false;
  }
};

// ==========================================

// ==========================================
// КНОПКИ СКАЧИВАНИЯ С РАЗМЕРАМИ
// ==========================================
const downloadVideoBtn = document.getElementById('downloadVideoBtn');

function updateDownloadButtons() {
  const loaded = !!(session && session.loaded);
  if (loaded && session.zipUrl) {
    downloadPackBtn.href = session.zipUrl;
    downloadPackBtn.querySelector('span').textContent = session.zipSize
      ? t('downloadSourceSized', { size: formatSize(session.zipSize) })
      : t('downloadSource');
    downloadPackBtn.style.display = 'inline-block';
    downloadPackNone.style.display = 'none';
  } else {
    downloadPackBtn.style.display = 'none';
    downloadPackNone.style.display = 'inline';
  }

  if (loaded && session.videoUrl) {
    downloadVideoBtn.href = session.videoUrl;
    downloadVideoBtn.querySelector('span').textContent = t('downloadVideo', { size: formatSize(session.videoSize) || '?' });
    downloadVideoBtn.style.display = 'inline-block';
  } else {
    downloadVideoBtn.style.display = 'none';
  }
}
