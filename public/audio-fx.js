// ==========================================
// ОБРАБОТКА ГОЛОСА: декодирование, эффекты, питч-шифтер, поиск тишины
// Всё считается офлайн в браузере — исходный файл дубля на сервере не меняется.
// ==========================================
const VOICE_EFFECTS = {
  none: 'Без эффекта',
  robot: '🤖 Робот',
  radio: '📻 Рация',
  monster: '👹 Монстр'
};

let sharedDecodeCtx = null;

// OfflineAudioContext умеет декодировать без жеста пользователя
function decodeAudio(arrayBuffer) {
  if (!sharedDecodeCtx) sharedDecodeCtx = new OfflineAudioContext(1, 1, 44100);
  return sharedDecodeCtx.decodeAudioData(arrayBuffer);
}

async function fetchAndDecode(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return decodeAudio(await res.arrayBuffer());
}

function toMono(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }
  return mono;
}

// ---------- Автоопределение тишины ----------
// Возвращает границы речи внутри записи { start, end } в секундах или null, если речи не нашлось.
function detectSpeechBounds(buffer, { frameMs = 10, padBefore = 0.08, padAfter = 0.18 } = {}) {
  const data = toMono(buffer);
  const frame = Math.max(1, Math.round(buffer.sampleRate * frameMs / 1000));
  const frames = Math.floor(data.length / frame);
  if (frames < 3) return null;

  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) sum += data[i] * data[i];
    rms[f] = Math.sqrt(sum / frame);
  }

  const sorted = Array.from(rms).sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(frames * 0.1)];
  const peak = sorted[frames - 1];
  if (peak < 0.003) return null; // в записи одна тишина

  // Речь — всё, что заметно громче шума и не тише -26 дБ от пика
  const threshold = Math.max(noiseFloor * 3, peak * 0.05, 0.002);

  // Короткие щелчки не считаем речью: нужно хотя бы 3 кадра подряд над порогом
  const isVoiced = f => rms[f] > threshold && rms[f + 1] > threshold && rms[f + 2] > threshold;
  let first = -1;
  for (let f = 0; f < frames - 2; f++) if (isVoiced(f)) { first = f; break; }
  if (first === -1) return null;
  let last = first;
  for (let f = frames - 3; f >= first; f--) if (isVoiced(f)) { last = f + 2; break; }

  const start = Math.max(0, first * frame / buffer.sampleRate - padBefore);
  const end = Math.min(buffer.duration, (last + 1) * frame / buffer.sampleRate + padAfter);
  return { start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) };
}

// ---------- Питч-шифтер ----------
// WSOLA: растягиваем звук во времени без изменения высоты, затем пересэмплируем обратно к исходной длине.
// В итоге высота голоса меняется, а длительность (и тайминг дубля) остаются прежними.
function wsolaStretch(input, factor, rate) {
  const frame = Math.round(rate * 0.04);
  const synthesisHop = Math.floor(frame / 2);
  const analysisHop = synthesisHop / factor;
  const tolerance = Math.round(rate * 0.012);
  const outLength = Math.ceil(input.length * factor);
  const out = new Float32Array(outLength + frame);
  const win = new Float32Array(frame);
  for (let i = 0; i < frame; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / frame);

  const sample = i => (i >= 0 && i < input.length ? input[i] : 0);
  let prevPos = 0;

  for (let k = 0; k * synthesisHop < outLength; k++) {
    const nominal = Math.round(k * analysisHop);
    let best = nominal;

    if (k > 0) {
      // Ищем кусок, который лучше всего продолжает предыдущий (без провалов фазы)
      const natural = prevPos + synthesisHop;
      let bestScore = -Infinity;
      for (let d = -tolerance; d <= tolerance; d += 2) {
        const cand = nominal + d;
        let score = 0;
        for (let i = 0; i < frame; i += 4) score += sample(cand + i) * sample(natural + i);
        if (score > bestScore) { bestScore = score; best = cand; }
      }
    }

    const outPos = k * synthesisHop;
    for (let i = 0; i < frame; i++) out[outPos + i] += sample(best + i) * win[i];
    prevPos = best;
  }
  return out.subarray(0, outLength);
}

function pitchShiftBuffer(buffer, semitones) {
  const ratio = Math.pow(2, semitones / 12);
  const input = toMono(buffer);
  const stretched = wsolaStretch(input, ratio, buffer.sampleRate);

  const out = new Float32Array(input.length);
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    if (i0 + 1 >= stretched.length) break;
    const frac = pos - i0;
    out[i] = stretched[i0] * (1 - frac) + stretched[i0 + 1] * frac;
  }

  const result = new AudioBuffer({ length: out.length, numberOfChannels: 1, sampleRate: buffer.sampleRate });
  result.copyToChannel(out, 0);
  return result;
}

// ---------- Эффекты ----------
function distortionCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
  }
  return curve;
}

function biquad(ctx, type, frequency, { Q = 0.7, gain = 0 } = {}) {
  const node = ctx.createBiquadFilter();
  node.type = type;
  node.frequency.value = frequency;
  node.Q.value = Q;
  node.gain.value = gain;
  return node;
}

function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1];
}

// Строит граф эффекта от input и возвращает выходной узел
function buildEffect(ctx, input, effect) {
  if (effect === 'robot') {
    // Кольцевая модуляция + короткое металлическое эхо
    const ring = ctx.createGain();
    ring.gain.value = 0;
    const osc = ctx.createOscillator();
    osc.frequency.value = 60;
    osc.connect(ring.gain);
    osc.start();
    input.connect(ring);

    const delay = ctx.createDelay(0.1);
    delay.delayTime.value = 0.011;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.45;
    ring.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);

    const out = ctx.createGain();
    out.gain.value = 1.2;
    ring.connect(out);
    delay.connect(out);
    return out;
  }

  if (effect === 'radio') {
    // Узкая полоса частот, «хрип» и компрессия, как у рации
    const shaper = ctx.createWaveShaper();
    shaper.curve = distortionCurve(25);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -30;
    comp.ratio.value = 8;
    const out = ctx.createGain();
    out.gain.value = 1.3;
    return chain(input, biquad(ctx, 'highpass', 450), biquad(ctx, 'lowpass', 3000),
      biquad(ctx, 'peaking', 1700, { Q: 1, gain: 7 }), shaper, comp, out);
  }

  if (effect === 'monster') {
    // Питч вниз добавляется отдельно, здесь — темный тембр и легкий перегруз
    const shaper = ctx.createWaveShaper();
    shaper.curve = distortionCurve(6);
    const out = ctx.createGain();
    out.gain.value = 1.2;
    return chain(input, biquad(ctx, 'lowshelf', 220, { gain: 8 }), biquad(ctx, 'lowpass', 2600), shaper, out);
  }

  return input;
}

const EFFECT_PITCH = { monster: -6 };

// Применяет эффект и питч к дублю. Длина результата совпадает с исходником.
async function renderVoice(buffer, effect = 'none', pitch = 0) {
  const totalPitch = (pitch || 0) + (EFFECT_PITCH[effect] || 0);
  let working = totalPitch !== 0 ? pitchShiftBuffer(buffer, totalPitch) : buffer;
  if (!effect || effect === 'none' || !VOICE_EFFECTS[effect]) return working;

  const ctx = new OfflineAudioContext(1, working.length, working.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = working;
  buildEffect(ctx, src, effect).connect(ctx.destination);
  src.start();
  return limitPeak(await ctx.startRendering());
}

// Эффекты с перегрузом и эхом могут вылезти за 0 дБ — приводим пик к безопасному уровню
function limitPeak(buffer, maxPeak = 0.95) {
  const data = buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak > maxPeak) {
    const k = maxPeak / peak;
    for (let i = 0; i < data.length; i++) data[i] *= k;
  }
  return buffer;
}
