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
  if (isLong) longExportWarning.textContent = t(window.dublineVideoExport ? 'exportVideo.longNative' : 'warning.longExport', { minutes: Math.ceil(duration / 60) });
};

video.addEventListener('loadedmetadata', updateExportDurationWarning);

window.openRenderModal = function() {
  if (!session || !session.loaded) {
    alert(t('error.noScene'));
    return;
  }
  openFilesModal();
  switchFilesTab('export');
  document.getElementById('tabBtnExport').focus();
};

window.closeRenderModal = function() {
  closeFilesModal();
};

function readRenderGains(scene = session) {
  const mix = window.DublineProjectAudio.normalize(scene);
  return { ...window.DublineProjectAudio.gains(mix, window.DublineProjectAudio.sources(scene)), mix };
}

function downloadBlob(blob, ext, title = session.title) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = window.DublineVideoExportPolicy?.filename(title, ext) || `Dubline_${title}_export.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Offline mixdown of the whole soundtrack: background + original + takes with effects and trimming
// Blind Mode hides takes while dubbing; an export asks whether to include them
// instead of silently leaving them out of the result.
let includeHiddenTakes = false;

async function confirmHiddenTakes() {
  const hidden = session.lines.filter(line => line.audioUrl && !canHearLine(line)).length;
  includeHiddenTakes = hidden > 0 && await askConfirm(t('blind.exportConfirm', { n: hidden }));
}

function exportableTake(line) {
  return !!line.audioUrl && (includeHiddenTakes || canHearLine(line));
}

function createExportSnapshot() {
  const scene = structuredClone(session);
  const sources = window.DublineProjectAudio.sources(scene);
  scene.lines.forEach(line => { line._exportNoise = window.DublineNoiseModel?.resolve(line, scene) || null; line._exportVoice = window.DublineVoiceChain?.resolve(line, scene); line._exportLevel = window.DublineProjectAudio.normalize(scene).normalizeVoices; });
  return { scene, takes: scene.lines.filter(exportableTake), gains: readRenderGains(scene),
    originalUrl: mediaUrl(sources.original), backingUrl: mediaUrl(sources.backing),
    videoUrl: scene.videoUrl, videoBlob: exportLocalVideo(scene), assets: localMedia?.sessionId === scene.activeSessionId ? localMedia.assets : {} };
}

function exportLocalVideo(scene) {
  if (!localMedia?.videoBlob || localMedia.forVideoUrl !== scene.videoUrl || localMedia.sessionId !== scene.activeSessionId || localMedia.videoHash !== scene.videoHash) return null;
  if (scene.videoSize && localMedia.videoBlob.size !== scene.videoSize) return null;
  // A manually chosen disk file may differ from the room's canonical working video.
  return localMedia.source === 'p2p' || window.DublineMediaTransfer?.stats().currentVideoVerified ? localMedia.videoBlob : null;
}

async function waitForExportVideo(snapshot, job) {
  while (!exportLocalVideo(snapshot.scene) && mediaDownload?.sessionId === snapshot.scene.activeSessionId && mediaDownload.videoUrl === snapshot.videoUrl) {
    job.check();
    await new Promise((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); reject(new DOMException('Export cancelled', 'AbortError')); };
      const timer = setTimeout(() => { job.abort.signal.removeEventListener('abort', aborted); resolve(); }, 200);
      job.abort.signal.addEventListener('abort', aborted, { once: true });
    });
  }
  job.check(); snapshot.videoBlob = exportLocalVideo(snapshot.scene);
  if (localMedia?.sessionId === snapshot.scene.activeSessionId) snapshot.assets = { ...localMedia.assets, ...snapshot.assets };
}

function exportTakeStart(line, scene) {
  return (line.audioStart ?? line.start) - window.DublineProjectAudio.takeLatency(scene, line.recordedBy) / 1000;
}

function exportAudioError(source) {
  const error = new Error(t('render.audioUnavailable', { source }));
  error.code = 'DUBLINE_EXPORT_AUDIO';
  return error;
}

async function requireExportTake(line, signal = null) {
  const wait = promise => !signal ? promise : new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Export cancelled', 'AbortError'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  try { let prepared = await wait(audio.prepareTake(line, { signal, strict: true })); if (!prepared.buffer) prepared = await wait(audio.prepareTake(line, { signal, strict: true })); const buffer = prepared.buffer; if (!buffer) throw exportAudioError(`#${line.id}`); line._levelGain = prepared.gain; window.DublineSceneReview?.processingError(line, false); return buffer; } catch (error) { if (error.name === 'AbortError') throw error; window.DublineSceneReview?.processingError(line, true); throw exportAudioError(`#${line.id} · ${t('review.processing')}`); }
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

function waitForRenderPlayback(snapshot, timeoutMs = 8000, element = video, signal = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearInterval(watchdog); signal?.removeEventListener('abort', aborted);
      if (error) { element.pause(); reject(error); } else resolve();
    };
    const failed = () => { const error = new Error(t('render.playbackFailed')); error.code = 'DUBLINE_EXPORT_PLAYBACK'; return error; };
    const aborted = () => done(new DOMException('Export cancelled', 'AbortError'));
    const watchdog = setInterval(() => {
      try { assertExportScene(snapshot); if (element.error) done(failed()); } catch (error) { done(error); }
    }, 100);
    const timer = setTimeout(() => done(failed()), timeoutMs);
    if (signal?.aborted) { aborted(); return; }
    signal?.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => element.play()).then(() => {
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

  const place = (buffer, gain, when, from = 0, to = buffer ? buffer.duration : 0, destination = limiter, take = null) => {
    if (!buffer || gain <= 0) return;
    to = Math.min(to, buffer.duration);
    if (to <= from) return;
    const skip = Math.max(0, -when);
    if (from + skip >= to) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = gain;
    if (take) window.DublineAudioFx.connectTake(ctx, src, g, take);
    else src.connect(g);
    g.connect(destination);
    src.start(Math.max(0, when), from + skip, to - from - skip);
  };

  if (snapshot.backingUrl && backingBase > 0) {
    onStep(t('render.decodeBackground'));
    place(await decodeExportSource(snapshot.backingUrl, t('studio.backing')), 1, mix.backing.offset, 0, Infinity, backingBus);
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
    if (window.DublineTakeMix.normalize(line).volume === 0) continue;
    const buffer = await requireExportTake(line);
    const { from, to } = takeBounds(line, buffer.duration);
    place(buffer, gains.dub, startOf(line) + from, from, to, limiter, line);
    if (gains.dub > 0) duckIntervals.push([Math.max(0, startOf(line) + from), Math.min(duration, startOf(line) + to)]);
  }

  if (mix.autoDuckEnabled && mix.autoDuckAmount > 0 && duckIntervals.length) {
    window.DublineProjectAudio.automateDucking(backingBus.gain,backingBase,mix.autoDuckAmount,duckIntervals,duration);
    window.DublineProjectAudio.automateDucking(originalBus.gain,originalBase,mix.autoDuckAmount,duckIntervals,duration);
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
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * sampleRate)), sampleRate);
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.connect(ctx.destination);
  for (const line of gain > 0 ? lines : []) {
    if (window.DublineTakeMix.normalize(line).volume === 0) continue;
    const buffer = await requireExportTake(line);
    const { from, to } = takeBounds(line, buffer.duration);
    const when = exportTakeStart(line, snapshot.scene) + from;
    const skip = Math.max(0, -when);
    if (from + skip >= to) continue;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const level = ctx.createGain();
    level.gain.value = gain;
    window.DublineAudioFx.connectTake(ctx, source, level, line);
    level.connect(limiter);
    source.start(Math.max(0, when), from + skip, to - from - skip);
  }
  return ctx.startRendering();
}

window.downloadReaperStems = async function() {
  if (!session || !session.loaded) return alert(t('error.noScene'));
  await confirmHiddenTakes();
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
    const Zip = await DublineLazyScripts.jszip();
    const zip = new Zip();
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

let projectExportBusy = false;
window.saveDublineProject = async function() {
  if (!session?.loaded) return showToast(t('error.noScene'));
  if (!amHost()) return showToast(t('onlyHost'));
  if (recordState !== 'idle' || renderInProgress) return showToast(t('studio.mediaBusy'));
  if (pendingTakeLines.size) return showToast(t('project.pendingTakes'));
  if (projectExportBusy) return;
  const button = document.getElementById('projectExportBtn');
  const status = document.getElementById('projectExportStatus');
  projectExportBusy = true;
  button.disabled = true;
  status.style.display = 'block';
  status.style.color = 'var(--accent-2)';
  const knownBytes = Number(session.videoSize || 0) + Number(session.backingSize || 0);
  status.textContent = t(knownBytes >= 100 * 1024 * 1024 ? 'project.savingLarge' : 'project.saving');
  let snapshot = null,removeProgress=null,cancelButton=null;
  try {
    const destination = window.dublineDesktop?.chooseProjectDestination ? await window.dublineDesktop.chooseProjectDestination({ sessionId: session.activeSessionId, title: session.title }) : null;
    if (destination?.canceled) { status.style.display = 'none'; return; }
    if (destination && !destination.ok) throw new Error(destination.error);
    snapshot = await window.prepareSafeSnapshot('project');
    if (!snapshot) { status.style.display = 'none'; return; }
    if (destination) {
      if(window.dublineDesktop.onProjectSaveProgress){
        cancelButton=document.createElement('button');cancelButton.className='btn-outline';cancelButton.textContent=t('project.cancelSaving');
        status.after(cancelButton);
        cancelButton.onclick=async()=>{cancelButton.disabled=true;await window.dublineDesktop.cancelProjectSave({ticket:destination.ticket}).catch(()=>{});};
        removeProgress=window.dublineDesktop.onProjectSaveProgress(progress=>{
          if(progress.ticket!==destination.ticket)return;
          const key={preparing:'project.preparing',writing:'project.writing',finalizing:'project.finalizing',committing:'project.finalizing'}[progress.stage];
          if(key)status.textContent=t(key,{mb:(progress.bytes/1048576).toFixed(1)});
          if(progress.stage==='committing')cancelButton.disabled=true;
        });
      }
      const saved = await window.dublineDesktop.saveProject({ ticket: destination.ticket, clientId, ...snapshot });
      if(saved.canceled){status.textContent=t('project.cancelled');return;}
      if (!saved.ok) throw new Error(saved.error);
      status.style.color = 'var(--success)'; status.textContent = t('snapshot.saved'); return;
    }
    const response = await fetch('/api/export-project', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: currentRoom, clientId, ...snapshot, download: true })
    });
    if (!response.ok) throw new Error(await readError(response));
    const prepared = await response.json();
    const link = document.createElement('a');
    link.href = prepared.downloadUrl;
    link.download = prepared.filename;
    link.click();
    status.style.color = 'var(--success)';
    status.textContent = t('project.downloadStarted');
  } catch (error) {
    status.style.color = 'var(--danger)';
    status.textContent = error instanceof TypeError ? t('upload.networkFailed') : error.message;
  } finally {
    removeProgress?.();cancelButton?.remove();
    if (snapshot) socket.emit('snapshot_cancel', { token: snapshot.barrierToken });
    projectExportBusy = false;
    button.disabled = !amHost();
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
  let snapshot = null;
  try {
    snapshot = await window.prepareSafeSnapshot('voxalike');
    if (!snapshot) { status.style.display = 'none'; return; }
    const response = await fetch('/api/export-voxalike-pack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: currentRoom, clientId, requestId, ...snapshot })
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
    if (snapshot) socket.emit('snapshot_cancel', { token: snapshot.barrierToken });
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
  const job = { abort: new AbortController(), bytes: 0, percent: 0, check: () => assertExportScene(snapshot) };
  const result = await window.DublineVideoExportEngine.render({ mode: 'fast', format: 'mp4' }, snapshot, progress, job);
  return result.blob;
}

// Direct callers and the export panel share the same bounded real-time renderer.
async function renderRealtime(progress, snapshot = createExportSnapshot(), settings = null, job = null) {
  if (!settings) {
    await DublineVideoExportPanel.open();
    const selected = DublineVideoExportPanel.settings();
    settings = { ...selected, mode: 'fast', fps: null };
  }
  job ||= { abort: new AbortController(), bytes: 0, check: () => assertExportScene(snapshot) };
  return window.DublineVideoExportEngine.realtime(settings, snapshot, progress, job);
}

async function renderOriginalVideo(progress, snapshot, settings = { mode: 'original', source: 'original' }, job = null) {
  job ||= { abort: new AbortController(), check: () => assertExportScene(snapshot) };
  const duration = settings.sourceInfo?.duration || snapshot.scene.videoDuration || video.duration;
  const webm = settings.format === 'webm';
  let output, soundtrack, extension = webm ? 'webm' : 'm4a';
  snapshot.exportSignal = job.abort.signal;
  try {
    if (settings.audioRealtime) {
      const audioJob = { ...job, destination: null, bytes: 0 };
      const result = await DublineVideoExportEngine.realtime({ ...settings, audioOnly: true, fps: null }, snapshot, (percent, text) => progress(Math.min(70, percent * 0.7), text), audioJob);
      soundtrack = result.blob; extension = result.ext;
    } else {
      const mb = await import('/vendor/mediabunny/mediabunny.min.mjs');
      output = new mb.Output({ format: webm ? new mb.WebMOutputFormat() : new mb.Mp4OutputFormat({ fastStart: false }), target: new mb.BufferTarget() });
      job.output = output;
      const source = new mb.AudioBufferSource({ codec: webm ? 'opus' : 'aac', bitrate: DublineVideoExportPolicy.AUDIO_BITRATE });
      output.addAudioTrack(source); await output.start();
      for await (const chunk of DublineVideoExportAudio.chunks(mb, snapshot, duration, text => progress(5, text), job.check)) {
        job.check(); await source.add(chunk.buffer); progress(10 + 60 * chunk.end / duration, t('render.encodeSoundtrack'));
      }
      source.close(); await output.finalize(); soundtrack = new Blob([output.target.buffer], { type: webm ? 'audio/webm' : 'audio/mp4' });
    }
    job.check();
    const form = new FormData();
    form.append('clientId', clientId); form.append('sessionId', snapshot.scene.activeSessionId); form.append('videoUrl', snapshot.videoUrl); form.append('source', settings.source);
    if (settings.mode === 'custom') form.append('options', JSON.stringify({ format: settings.format, codec: settings.codec, width: settings.width, height: settings.height, fps: settings.fps, bitrate: settings.bitrate }));
    form.append('soundtrack', soundtrack, 'soundtrack.' + extension);
    progress(75, t('render.originalMux'));
    const response = await fetch('/api/export-original-video?room=' + encodeURIComponent(currentRoom), { method: 'POST', body: form, signal: job.abort.signal });
    if (!response.ok) throw new Error(await readError(response));
    const prepared = await response.json(); job.check(); return prepared;
  } finally { if (output && output.state !== 'finalized') await output.cancel().catch(() => {}); job.output = null; }
}

// ==========================================

// ==========================================
// DOWNLOAD BUTTONS WITH SIZES
// ==========================================
const downloadVideoBtn = document.getElementById('downloadVideoBtn');

function updateDownloadButtons() {
  const loaded = !!(session && session.loaded);
  const notice=document.getElementById('renderOriginalNotice');
  notice.style.display='none';
  if(!renderInProgress)document.getElementById('startRenderBtn').disabled=recordState !== 'idle' || document.getElementById('videoExportPanel')?.dataset.ready === 'false';
  if (loaded && session.zipUrl) {
    downloadPackBtn.href = session.zipUrl;
    downloadPackBtn.download = `${String(session.title || 'scene').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}.zip`;
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
