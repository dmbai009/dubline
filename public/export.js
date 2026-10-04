// ==========================================
// EXPORT
// Audio mixdown, video render (WebCodecs / real time), stems
// ==========================================
// SAFE STUDIO RENDER
// ==========================================
// The export levels shown in this window come from the project mix (studio.js keeps them in sync)
const longExportWarning = document.getElementById('longExportWarning');
const LONG_EXPORT_WARNING_SECONDS = 20 * 60;

window.updateExportDurationWarning = function() {
  const duration = Number(video.duration);
  const isLong = !!(session && session.loaded && Number.isFinite(duration) && duration >= LONG_EXPORT_WARNING_SECONDS);
  longExportWarning.style.display = isLong ? 'block' : 'none';
  if (isLong) longExportWarning.textContent = t('warning.longExport', { minutes: Math.ceil(duration / 60) });
};

video.addEventListener('loadedmetadata', updateExportDurationWarning);

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

function readRenderGains(scene = session) {
  const mix = window.DublineProjectAudio.normalize(scene);
  return { ...window.DublineProjectAudio.gains(mix), mix };
}

function downloadBlob(blob, ext, title = session.title) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Dubline_${title}_export.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Offline mixdown of the whole soundtrack: background + original + takes with effects and trimming
// Blind Mode hides takes while dubbing; an export asks whether to include them
// instead of silently leaving them out of the result.
let includeHiddenTakes = false;

function confirmHiddenTakes() {
  const hidden = session.lines.filter(line => line.audioUrl && !canHearLine(line)).length;
  includeHiddenTakes = hidden > 0 && confirm(t('blind.exportConfirm', { n: hidden }));
}

function exportableTake(line) {
  return !!line.audioUrl && (includeHiddenTakes || canHearLine(line));
}

function createExportSnapshot() {
  const scene = structuredClone(session);
  const sources = window.DublineProjectAudio.sources(scene);
  return { scene, takes: scene.lines.filter(exportableTake), gains: readRenderGains(scene),
    originalUrl: mediaUrl(sources.original), backingUrl: mediaUrl(sources.backing),
    videoUrl: scene.videoUrl, videoBlob: localMedia && localMedia.forVideoUrl === scene.videoUrl ? localMedia.videoBlob : null };
}

function exportTakeStart(line, scene) {
  return (line.audioStart ?? line.start) - (Number((scene.latency || {})[line.recordedBy]) || 0) / 1000;
}

function exportAudioError(source) {
  const error = new Error(t('render.audioUnavailable', { source }));
  error.code = 'DUBLINE_EXPORT_AUDIO';
  return error;
}

async function requireExportTake(line) {
  const buffer = await getProcessedTake(line) || await getProcessedTake(line);
  if (!buffer) throw exportAudioError(`#${line.id}`);
  return buffer;
}

async function decodeExportSource(url, label) {
  try { return await fetchAndDecode(url); }
  catch { throw exportAudioError(label); }
}

function assertExportScene(snapshot) {
  if (!session || session.activeSessionId !== snapshot.scene.activeSessionId || session.videoUrl !== snapshot.scene.videoUrl) {
    const error = new Error(t('render.sceneChanged')); error.code = 'DUBLINE_EXPORT_SCENE'; throw error;
  }
}

function waitForRenderPlayback(snapshot, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearInterval(watchdog);
      if (error) { video.pause(); reject(error); } else resolve();
    };
    const failed = () => { const error = new Error(t('render.playbackFailed')); error.code = 'DUBLINE_EXPORT_PLAYBACK'; return error; };
    const watchdog = setInterval(() => {
      try { assertExportScene(snapshot); if (video.error) done(failed()); } catch (error) { done(error); }
    }, 100);
    const timer = setTimeout(() => done(failed()), timeoutMs);
    Promise.resolve().then(() => video.play()).then(() => {
      if (settled) return;
      try { assertExportScene(snapshot); done(); } catch (error) { done(error); }
    }, error => done(error));
  });
}

async function mixSoundtrack(duration, gains, onStep, snapshot = createExportSnapshot()) {
  const { scene, takes } = snapshot;
  const mix = gains.mix || window.DublineProjectAudio.normalize(scene);
  const startOf = line => exportTakeStart(line, scene);
  const rate = 48000;
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * rate)), rate);

  // Soft limiter on the master so loud parts don't distort after encoding
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
  const backingBase = gains.backing;
  const originalBase = gains.original;
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

  if (snapshot.backingUrl && backingBase > 0) {
    onStep(t('render.decodeBackground'));
    place(await decodeExportSource(snapshot.backingUrl, 'Intershum / M&E'), 1, mix.backing.offset, 0, Infinity, backingBus);
  }
  // Original is the chosen video audio track (if there are several) or the video's own sound
  const originalUrl = snapshot.originalUrl;
  if (originalUrl && originalBase > 0) {
    onStep(t('render.decodeOriginal'));
    place(await decodeExportSource(originalUrl, 'Original'), 1, mix.original.offset, 0, Infinity, originalBus);
  }

  const duckIntervals = [];
  for (let i = 0; gains.dub > 0 && i < takes.length; i++) {
    onStep(t('render.takes', { current: i + 1, total: takes.length }));
    const line = takes[i];
    const buffer = await requireExportTake(line);
    const { from, to } = takeBounds(line, buffer.duration);
    place(buffer, gains.dub, startOf(line) + from, from, to);
    if (gains.dub > 0) duckIntervals.push([Math.max(0, startOf(line) + from), Math.min(duration, startOf(line) + to)]);
  }

  if (mix.autoDuckEnabled && mix.autoDuckAmount > 0 && duckIntervals.length) {
    duckIntervals.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const interval of duckIntervals) {
      const last = merged[merged.length - 1];
      if (last && interval[0] <= last[1] + 0.25) last[1] = Math.max(last[1], interval[1]);
      else merged.push([...interval]);
    }
    const automateDuck = (param, base) => {
      if (base <= 0) return;
      const ducked = base * (1 - mix.autoDuckAmount);
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

async function renderCharacterStem(lines, duration, sampleRate = 48000, snapshot = createExportSnapshot()) {
  lines = structuredClone(lines);
  const gain = snapshot.gains.dub;
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(duration * sampleRate)), sampleRate);
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.connect(ctx.destination);
  for (const line of gain > 0 ? lines : []) {
    const buffer = await requireExportTake(line);
    const { from, to } = takeBounds(line, buffer.duration);
    const when = exportTakeStart(line, snapshot.scene) + from;
    const skip = Math.max(0, -when);
    if (from + skip >= to) continue;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const level = ctx.createGain();
    level.gain.value = gain;
    source.connect(level).connect(limiter);
    source.start(Math.max(0, when), from + skip, to - from - skip);
  }
  return ctx.startRendering();
}

window.downloadReaperStems = async function() {
  if (!session || !session.loaded) return alert(t('error.noScene'));
  confirmHiddenTakes();
  const snapshot = createExportSnapshot(), takes = snapshot.takes;
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
    assertExportScene(snapshot);
    const duration = Math.max(Number(video.duration) || 0, ...takes.map(line => exportTakeStart(line, snapshot.scene) + Math.max(1, line.end - line.start) + 1));
    const zip = new JSZip();
    const manifest = [];
    let index = 0;
    for (const [character, lines] of grouped) {
      index++;
      status.textContent = t('stems.progress', { current: index, total: grouped.size, name: character });
      const stem = await renderCharacterStem(lines, duration, 48000, snapshot);
      const safeName = String(character || `Character_${index}`).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80);
      zip.file(`${String(index).padStart(2, '0')}_${safeName}.wav`, audioBufferToWav(stem));
      lines.forEach(line => manifest.push(`${character}\t${exportTakeStart(line, snapshot.scene).toFixed(3)}\t${line.id}\t${line.caption || ''}`));
    }
    zip.file('timeline.tsv', `character\tstart_seconds\tline_id\tcaption\n${manifest.join('\n')}\n`);
    status.textContent = t('stems.mixing');
    const archive = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } });
    const safeProject = String(snapshot.scene.title || 'dubline').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
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

window.exportVoxalikePack = async function() {
  if (!session || !session.loaded) return alert(t('error.noScene'));
  if (!amHost()) return alert(t('onlyHost'));
  const button = document.getElementById('packExportBtn');
  const status = document.getElementById('packExportStatus');
  if (button.disabled) return;
  const requestId = newUploadId();
  const exportTitle = String(session.title || 'Dubline_pack').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  const onProgress = progress => {
    if (progress.requestId === requestId) status.textContent = t('packExport.lines', { current: progress.current, total: progress.total });
  };
  socket.on('pack_export_progress', onProgress);
  button.disabled = true;
  status.style.display = 'block';
  status.style.color = 'var(--accent-2)';
  status.textContent = t('packExport.progress');
  try {
    const response = await fetch('/api/export-voxalike-pack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: currentRoom, clientId, requestId })
    });
    if (!response.ok) throw new Error(await readError(response));
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const disposition = response.headers.get('Content-Disposition') || '';
    const filename = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    link.download = filename ? decodeURIComponent(filename[1]) : `${exportTitle}.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status.style.color = 'var(--success)';
    status.textContent = t('packExport.done');
  } catch (err) {
    status.style.color = 'var(--danger)';
    status.textContent = t('error.generic', { message: err.message });
  } finally {
    socket.off('pack_export_progress', onProgress);
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

// WebCodecs render: the video track is copied without re-encoding, the audio is encoded by AudioEncoder.
// Many times faster than real time and works even when the tab is minimized.
async function renderWithWebCodecs(progress, snapshot = createExportSnapshot()) {
  const mb = await import('/vendor/mediabunny/mediabunny.min.mjs');

  progress(1, t('render.readVideo'));
  // If the video was picked from disk, read it locally instead of through the tunnel
  const source = snapshot.videoBlob ? new mb.BlobSource(snapshot.videoBlob) : new mb.UrlSource(snapshot.videoUrl);
  const input = new mb.Input({ source, formats: mb.ALL_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error(t('render.noVideo'));
  const videoCodec = await videoTrack.getCodec();
  const decoderConfig = await videoTrack.getDecoderConfig();
  const duration = await videoTrack.computeDuration();
  if (!videoCodec || !decoderConfig) throw new Error(t('render.unknownCodec'));

  assertExportScene(snapshot);
  const soundtrack = await mixSoundtrack(duration, snapshot.gains, text => progress(5, text), snapshot);

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

  // Add audio in chunks mixed with video so the tracks are interleaved in the file
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

// Fallback for browsers without WebCodecs: real-time capture
async function renderRealtime(progress, snapshot = createExportSnapshot()) {
  assertExportScene(snapshot);
  const duration = video.duration;
  const soundtrack = await mixSoundtrack(duration, snapshot.gains, text => progress(2, text), snapshot);
  assertExportScene(snapshot);

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
  let frame, watchdog;
  try {
    video.muted = true;
    if (video.currentTime !== 0 || video.seeking) await new Promise((resolve, reject) => {
      const done = error => { clearTimeout(timer); video.removeEventListener('seeked', seeked); error ? reject(error) : resolve(); };
      const seeked = () => done();
      const timer = setTimeout(() => done(new Error(t('render.playbackFailed'))), 8000);
      video.addEventListener('seeked', seeked, { once: true });
      video.currentTime = 0;
    });
    assertExportScene(snapshot);
    recorder.start();
    await waitForRenderPlayback(snapshot);
    mixSource.start();
    await new Promise((resolve, reject) => {
      let lastTime = video.currentTime, lastProgress = performance.now();
      const check = () => {
        try {
          assertExportScene(snapshot);
          if (video.error) throw new Error(t('render.playbackFailed'));
          if (video.currentTime !== lastTime) { lastTime = video.currentTime; lastProgress = performance.now(); }
          if (video.ended || video.currentTime >= duration - 0.1) return resolve();
          if (performance.now() - lastProgress > 10000) throw new Error(t('render.playbackFailed'));
        } catch (error) { reject(error); }
      };
      const drawRenderFrame = () => {
        try {
          ctx.drawImage(video, 0, 0, renderCanvas.width, renderCanvas.height);
          progress((video.currentTime / duration) * 100, t('render.realtimeProgress', { current: Math.round(video.currentTime), total: Math.round(duration) }));
          check();
          frame = requestAnimationFrame(drawRenderFrame);
        } catch (error) { reject(error); }
      };
      watchdog = setInterval(check, 250);
      frame = requestAnimationFrame(drawRenderFrame);
    });
  } finally {
    clearInterval(watchdog); cancelAnimationFrame(frame);
    video.pause(); video.muted = savedMuted;
    try { mixSource.stop(); } catch { /* not started */ }
    if (recorder.state !== 'inactive') { recorder.stop(); await stopped; }
    combinedStream.getTracks().forEach(track => track.stop());
    await actx.close();
  }

  return { blob: new Blob(recordedChunks, { type: mimeType }), ext: mimeType.includes('mp4') ? 'mp4' : 'webm' };
}

window.startVideoRender = async function() {
  if (renderInProgress || recordState !== 'idle') return showToast(t('studio.mediaBusy'));
  if (!session || !session.loaded) return showToast(t('error.noScene'));
  const startBtn = document.getElementById('startRenderBtn');
  const progressBox = document.getElementById('renderProgressBox');
  const progressBar = document.getElementById('renderProgressBar');
  const statusText = document.getElementById('renderStatusText');

  const progress = (pct, text) => {
    progressBar.style.width = `${pct}%`;
    statusText.innerText = `⏳ ${text}`;
  };

  confirmHiddenTakes();
  const snapshot = createExportSnapshot();
  startBtn.disabled = true;
  progressBox.style.display = 'block';
  video.pause();
  renderInProgress = true;
  window.refreshStudioTransport?.();
  applyVolumes();
  const startedAt = performance.now();

  try {
    let result = null;
    if (supportsWebCodecsRender()) {
      try {
        result = { blob: await renderWithWebCodecs(progress, snapshot), ext: 'mp4' };
      } catch (err) {
        if (err.code === 'DUBLINE_EXPORT_AUDIO' || err.code === 'DUBLINE_EXPORT_SCENE') throw err;
        console.error('[Dubline] WebCodecs render failed, falling back to real-time capture:', err);
        progress(0, t('render.fallback'));
      }
    }
    if (!result) result = await renderRealtime(progress, snapshot);

    assertExportScene(snapshot);
    downloadBlob(result.blob, result.ext, snapshot.scene.title);
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    progressBar.style.width = '100%';
    statusText.innerText = t('render.done', { seconds });
    setTimeout(() => {
      closeRenderModal();
      progressBox.style.display = 'none';
    }, 2000);
  } catch (err) {
    console.error('[Dubline] Render failed:', err);
    statusText.innerText = t('render.error', { message: err.message });
  } finally {
    renderInProgress = false;
    window.refreshStudioTransport?.();
    applyVolumes();
    startBtn.disabled = false;
  }
};

// ==========================================

// ==========================================
// DOWNLOAD BUTTONS WITH SIZES
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
