// Windowed offline mix: reuse take processing and shared duck curves without a scene-length PCM buffer.
(() => {
  const RATE = 48000, WINDOW = 8, WARMUP = 2;
  let decodeContext;
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  async function resample(buffer) {
    if (buffer.sampleRate === RATE) return buffer;
    // decodeAudioData uses the same high-quality resampler as the existing full mix.
    // Float WAV avoids adding a quantization step to the decoded samples.
    const channels = buffer.numberOfChannels, bytes = new ArrayBuffer(44 + buffer.length * channels * 4), view = new DataView(bytes);
    const text = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true);
    view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels * 4, true); view.setUint16(32, channels * 4, true); view.setUint16(34, 32, true);
    text(36, 'data'); view.setUint32(40, bytes.byteLength - 44, true);
    const data = new Float32Array(bytes, 44), planes = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
    for (let i = 0; i < buffer.length; i++) for (let c = 0; c < channels; c++) data[i * channels + c] = planes[c][i];
    decodeContext ||= new OfflineAudioContext(1, 1, RATE);
    return decodeContext.decodeAudioData(bytes);
  }
  async function prepare(snapshot, duration, progress, check, { concurrency = 2 } = {}) {
    const eligible = (snapshot.gains.dub > 0 ? snapshot.takes : []).filter(line => DublineTakeMix.normalize(line).volume > 0), takes = [];
    const report = snapshot.exportReport || (() => {}); let completed = 0;
    report('takes', { current: 0, total: eligible.length, unit: 'count' });
    // Only two independent existing decode/offline pipelines may run at once.
    // RNNoise keeps its own bounded worker/queue; no unbounded Promise.all over a scene.
    const width = Math.max(1, Math.min(2, Math.floor(concurrency) || 1));
    for (let offset = 0; offset < eligible.length; offset += width) {
      check();
      const batch = await Promise.allSettled(eligible.slice(offset, offset + width).map(async line => {
        check(); progress(t('render.takes', { current: completed + 1, total: eligible.length }));
        report('takes', { current: completed, total: eligible.length, unit: 'count', detail: '#' + lineNumber(line) });
        const buffer = await (snapshot.exportOperations ? snapshot.exportOperations.run('take-process',()=>requireExportTake(line,snapshot.exportSignal)) : requireExportTake(line,snapshot.exportSignal)); check();
        const bounds = takeBounds(line, buffer.duration); completed++;
        report('takes', { current: completed, total: eligible.length, unit: 'count' });
        return { line, ...bounds, start: exportTakeStart(line, snapshot.scene) };
      }));
      const failed = batch.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
      takes.push(...batch.map(result => result.value)); // Retain metadata, never the scene's PCM buffers.
    }
    report('takes', { current: completed, total: eligible.length, unit: 'count', detail: '', state: 'done' });
    const intervals = takes.map(take => [Math.max(0, take.start + take.from), Math.min(duration, take.start + take.to)]);
    const mix = snapshot.gains.mix;
    const curves = {};
    for (const name of ['original', 'backing']) {
      const events = [[0, snapshot.gains[name]]];
      if (mix.autoDuckEnabled && mix.autoDuckAmount > 0) {
        DublineProjectAudio.automateDucking({ setValueAtTime: (value, at) => events.push([at, value]), linearRampToValueAtTime: (value, at) => events.push([at, value]) }, snapshot.gains[name], mix.autoDuckAmount, intervals, duration);
      }
      curves[name] = events;
    }
    return { takes, curves };
  }
  function automate(param, events, begin, end) {
    let value = events[0][1];
    for (let i = 0; i < events.length; i++) {
      const [at, level] = events[i];
      if (at > begin) {
        const previous = events[i - 1];
        if (previous && at > previous[0]) value = previous[1] + (level - previous[1]) * (begin - previous[0]) / (at - previous[0]);
        break;
      }
      value = level;
    }
    param.setValueAtTime(value, 0);
    for (const [at, level] of events) if (at > begin && at <= end) param.linearRampToValueAtTime(level, at - begin);
  }
  async function* chunks(mb, snapshot, duration, progress, check) {
    const operations=snapshot.exportOperations;
    const wait=(name,fn,data)=>operations ? operations.run(name,fn,data) : fn();
    const range = DublineVideoExportPolicy.range(snapshot.exportRange, duration) || { start: 0, end: duration };
    const outputDuration = range.end - range.start;
    const prepared = await prepare(snapshot, duration, progress, check), sources = [];
    const report = snapshot.exportReport || (() => {}); report('audio', { current: 0, total: outputDuration });
    try {
      for (const name of ['original', 'backing']) {
        const url = snapshot[name + 'Url'];
        if (!url || snapshot.gains[name] <= 0) continue;
        const local = url === snapshot.videoUrl || url === mediaUrl(snapshot.videoUrl) ? snapshot.videoBlob : snapshot.assets?.[url]?.blob;
        const source = local ? new mb.BlobSource(local) : new mb.UrlSource(url, { fetchFn: DublineExportOperations.fetchSource(snapshot.exportSignal) });
        const input = new mb.Input({ source, formats: mb.ALL_FORMATS }); sources.push({ name, input, release:operations?.own(()=>input.dispose()) });
        const track = await wait('audio-metadata',()=>input.getPrimaryAudioTrack());
        if (!track || !await wait('audio-decoder-check',()=>track.canDecode())) throw exportAudioError(t(name === 'backing' ? 'studio.backing' : 'studio.original'));
        sources.at(-1).sink = new mb.AudioBufferSink(track);
      }
      // Keep the same window/resampler/limiter phase as a full export, then crop.
      for (let position = Math.floor(range.start / WINDOW) * WINDOW; position < range.end; position += WINDOW) {
        check();
        const begin = Math.max(0, position - WARMUP), end = Math.min(duration, position + WINDOW);
        const context = new OfflineAudioContext(2, Math.max(1, Math.round((end - begin) * RATE)), RATE);
        const limiter = context.createDynamicsCompressor();
        limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.1; limiter.connect(context.destination);
        const place = (buffer, gain, at, from, to, destination, take) => {
          const start = Math.max(at + from, begin), stop = Math.min(at + to, end);
          if (stop <= start) return;
          const source = context.createBufferSource(), level = context.createGain(); source.buffer = buffer; level.gain.value = gain;
          if (take) DublineAudioFx.connectTake(context, source, level, take); else source.connect(level);
          level.connect(destination); source.start(start - begin, start - at, stop - start);
        };
        for (const source of sources) {
          const bus = context.createGain(); bus.connect(limiter); automate(bus.gain, prepared.curves[source.name], begin, end);
          const offset = snapshot.gains.mix[source.name].offset;
          if (end <= offset) continue;
          const packets = [];
          // Include codec pre-roll before zero (e.g. AAC's negative priming packet),
          // then crop its samples when placing the audible timeline region.
          try { for await (const packet of (operations ? operations.iterate(source.sink.buffers(Math.max(-0.1, begin - offset - 0.1), end - offset + 0.1),'audio-decode') : source.sink.buffers(Math.max(-0.1, begin - offset - 0.1), end - offset + 0.1))) { check(); packets.push(packet); } }
          catch (error) { if (error.name === 'AbortError'||error.code==='export-timeout') throw error; throw exportAudioError(t(source.name === 'backing' ? 'studio.backing' : 'studio.original')); }
          if (packets.length) {
            const rate = packets[0].buffer.sampleRate, channels = packets[0].buffer.numberOfChannels;
            // Align the chunk to both sample grids, keeping resampler phase continuous.
            const block = rate / gcd(rate, RATE), firstIndex = Math.floor(Math.max(Math.round(packets[0].timestamp * rate), Math.round(Math.max(0, begin - offset - 0.1) * rate)) / block) * block;
            const first = firstIndex / rate, last = Math.min(end - offset + 0.1, Math.max(...packets.map(packet => packet.timestamp + packet.buffer.duration)));
            const joined = context.createBuffer(channels, Math.max(1, Math.round((last - first) * rate)), rate);
            for (const packet of packets) {
              if (packet.buffer.sampleRate !== rate || packet.buffer.numberOfChannels !== channels) throw exportAudioError(t('exportVideo.source'));
              const at = Math.round(packet.timestamp * rate) - firstIndex;
              if (at >= joined.length || at + packet.buffer.length <= 0) continue;
              for (let channel = 0; channel < channels; channel++) joined.copyToChannel(packet.buffer.getChannelData(channel).subarray(Math.max(0, -at), joined.length - at), channel, Math.max(0, at));
            }
            // A single continuous source preserves resampler state across decoded packets.
            const converted = await wait('audio-resample',()=>resample(joined),{timestamp:position}); check();
            place(converted, 1, first + offset, 0, converted.duration, bus);
          }
        }
        for (const take of prepared.takes) if (take.start + take.to > begin && take.start + take.from < end) {
          check(); const buffer = await wait('take-process',()=>requireExportTake(take.line,snapshot.exportSignal));
          place(buffer, snapshot.gains.dub, take.start, take.from, take.to, limiter, take.line);
        }
        check(); progress(t('render.mix')); report('audio', { current: Math.max(0, position - range.start), total: outputDuration });
        const buffer = await wait('audio-mix',()=>context.startRendering(),{timestamp:position,end}); check();
        const stop = Math.min(end, range.end), start = Math.max(position, range.start);
        report('audio', { current: stop - range.start, total: outputDuration, state: stop >= range.end ? 'done' : 'running' });
        yield { buffer: sliceAudioBuffer(buffer, Math.round(start * RATE) - Math.round(begin * RATE), Math.round(stop * RATE) - Math.round(begin * RATE)), end: stop - range.start };
      }
    } finally { for (const source of sources) {source.input.dispose();source.release?.();} }
  }
  window.DublineVideoExportAudio = Object.freeze({ chunks, prepare, automate, RATE, WINDOW, WARMUP });
})();
