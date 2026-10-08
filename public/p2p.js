// ==========================================
// P2P
// Players send each other the scene video directly (WebRTC DataChannel).
// The server only introduces players; whatever is missing is fetched from the host over HTTP.
// ==========================================
const P2P_CHUNK = 64 * 1024;
const P2P_MAX_PEERS = 3;
const P2P_CONNECT_TIMEOUT = 6000;
const P2P_CHUNK_TIMEOUT = 8000;
const HTTP_RUN = 16;               // pieces per HTTP Range request (1 MB)
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];

const p2pBox = document.getElementById('p2pBox');
const p2pStatusText = document.getElementById('p2pStatusText');
const p2pProgressBar = document.getElementById('p2pProgressBar');
const settingsP2P = document.getElementById('settingsP2P');

let p2pEnabled = localStorage.getItem('dubline_p2p') !== '0';
const peers = new Map();           // `${role}:${socketId}` -> { pc, channel, pending: [], remoteSet }
let mediaDownload = null;          // current scene video download
let p2pStatus = null;              // what to show in the lobby footer
let uploadedBytes = 0;             // how much we have shared with others
let lastAnnounce = '';
const mediaPins = new Map();
const partialFiles = new Map();
const heldManifests = new Map();
let announceTimer = null, announceGeneration = 0;
let availabilitySequence = 0;
function scheduleAnnounce() { if (announceTimer === null) announceTimer = setTimeout(() => { announceTimer = null; announceHave(); }, 300); }

settingsP2P.checked = p2pEnabled;
settingsP2P.addEventListener('change', () => {
  p2pEnabled = settingsP2P.checked;
  localStorage.setItem('dubline_p2p', p2pEnabled ? '1' : '0');
  if (!p2pEnabled) for (const key of [...peers.keys()]) closePeer(key);
  announceHave(true);
});

function isOnServerMachine() {
  return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

// ---------- What we have in full ----------
function heldFiles() {
  const files = new Map();
  if (!session || !localMedia || localMedia.forVideoUrl !== session.videoUrl) return files;
  if (localMedia.videoBlob) files.set(session.videoUrl, localMedia.videoBlob);
  if (localMedia.backingBlob && localMedia.backingSourceUrl === session.backingUrl && session.backingUrl) files.set(session.backingUrl, localMedia.backingBlob);
  for (const [url, asset] of Object.entries(localMedia.assets || {})) files.set(url, asset.blob);
  return files;
}

async function announceHave(force = false) {
  if (!socket.connected) return;
  const generation = ++announceGeneration, sessionId = session?.activeSessionId;
  const files = [];
  if (p2pEnabled && window.crypto?.subtle) {
    for (const [url, blob] of heldFiles()) {
      let manifest = heldManifests.get(url);
      if (!manifest) {
        try {
          const response = await fetch(`/api/media-manifest?${new URLSearchParams({ room: currentRoom, sessionId, clientId, url })}`);
          if (!response.ok) continue; manifest = await response.json();
          if (!DublineMediaCache.valid(manifest) || manifest.size !== blob.size || await sha256Hex(blob) !== manifest.sha256) continue;
          heldManifests.set(url, manifest);
        } catch { continue; }
      }
      files.push({ url, id: manifest.id, ranges: [[0, manifest.chunks.length - 1]] });
    }
    for (const [url, partial] of partialFiles) if (!files.some(file => file.url === url)) files.push({ url, id: partial.manifest.id, ranges: DublineTransferUtils.rangesFromIndexes(partial.durable) });
  }
  if (generation !== announceGeneration || session?.activeSessionId !== sessionId) return;
  const key = JSON.stringify([socket.id, sessionId, files]);
  if (!force && key === lastAnnounce) return;
  lastAnnounce = key;
  socket.emit('p2p_have', { sessionId, files, sequence: ++availabilitySequence });
}

socket.on('p2p_seeders', (summary) => {
  seedingNicks.clear();
  const videoUrl = session && session.videoUrl;
  (summary[videoUrl] || []).forEach(nick => seedingNicks.add(nick));
  renderLobby();
});

function findSeeders(url) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve([]), 3000);
    socket.emit('p2p_find', { url, detailed: true, sessionId: session?.activeSessionId }, ids => {
      clearTimeout(timer);
      resolve(Array.isArray(ids) ? ids : []);
    });
  });
}

// ---------- WebRTC signaling through the server ----------
function signal(to, data, sessionId = session?.activeSessionId) {
  if (sessionId !== session?.activeSessionId) return;
  socket.emit('p2p_signal', { to, data, sessionId });
}

function closePeer(key) {
  const peer = peers.get(key);
  if (!peer) return;
  peers.delete(key);
  try { peer.channel && peer.channel.close(); } catch (e) {}
  try { peer.pc.close(); } catch (e) {}
}

async function addCandidate(peer, candidate) {
  if (!peer.remoteSet) { if (peer.pending.length < 64) peer.pending.push(candidate); return; }
  try { await peer.pc.addIceCandidate(candidate); } catch (e) {}
}

async function markRemoteSet(peer) {
  peer.remoteSet = true;
  for (const candidate of peer.pending.splice(0)) {
    try { await peer.pc.addIceCandidate(candidate); } catch (e) {}
  }
}

socket.on('p2p_signal', async ({ from, data, sessionId }) => {
  if (!data || !from || sessionId !== session?.activeSessionId) return;

  if (data.kind === 'offer') {
    // We are asked to share a file
    if (!p2pEnabled || !window.crypto?.subtle || (!heldFiles().size && !partialFiles.size) || [...peers.keys()].filter(key => key.startsWith('seed:')).length >= P2P_MAX_PEERS) return;
    const key = `seed:${from}`;
    closePeer(key);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = { pc, channel: null, pending: [], remoteSet: false, sessionId };
    peers.set(key, peer);
    pc.onicecandidate = e => { if (e.candidate) signal(from, { kind: 'candidate', from: 'seed', candidate: e.candidate }, sessionId); };
    pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) closePeer(key); };
    pc.ondatachannel = e => {
      peer.channel = window.DublineNetwork.channel(e.channel);
      serveChannel(e.channel, key);
    };
    await pc.setRemoteDescription(data.sdp);
    await markRemoteSet(peer);
    await pc.setLocalDescription(await pc.createAnswer());
    signal(from, { kind: 'answer', sdp: pc.localDescription }, sessionId);
  } else if (data.kind === 'answer') {
    const peer = peers.get(`leech:${from}`);
    if (!peer) return;
    await peer.pc.setRemoteDescription(data.sdp);
    await markRemoteSet(peer);
  } else if (data.kind === 'candidate') {
    // A candidate from the sharer goes to our downloading connection, and vice versa
    const peer = peers.get(data.from === 'seed' ? `leech:${from}` : `seed:${from}`);
    if (peer) addCandidate(peer, data.candidate);
  }
});

// ---------- Sharing: answer piece requests ----------
function serveChannel(channel, key) {
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = 256 * 1024;
  let file = null;
  let partial = null;
  const queue = [];
  let sending = false;
  const uploadAbort = new AbortController();
  channel.addEventListener('close', () => uploadAbort.abort(), { once: true });

  const waitForBuffer = () => new Promise(resolve => {
    const done = () => { clearTimeout(timer); channel.removeEventListener('bufferedamountlow', done); channel.removeEventListener('close', done); resolve(); };
    const timer = setTimeout(done, 1000);
    channel.addEventListener('bufferedamountlow', done, { once: true }); channel.addEventListener('close', done, { once: true });
  });

async function pump() {
    if (sending) return;
    sending = true;
    try {
      while (queue.length && channel.readyState === 'open' && (file || partial)) {
        if (channel.bufferedAmount > 1024 * 1024) { await waitForBuffer(); if (channel.bufferedAmount > 1024 * 1024) continue; }
        if (channel.readyState !== 'open') break;
        const index = queue.shift();
        const chunk = Math.floor(index / 4);
        if (!file && !partial.durable.has(chunk)) continue;
        const data = file ? new Uint8Array(await file.slice(index * P2P_CHUNK, (index + 1) * P2P_CHUNK).arrayBuffer()) : partial.bytes.get(chunk)?.slice(index % 4 * P2P_CHUNK, (index % 4 + 1) * P2P_CHUNK);
        if (!data) continue;
        const packet = new Uint8Array(4 + data.byteLength);
        new DataView(packet.buffer).setUint32(0, index);
        packet.set(data, 4);
        await window.mediaUploadLimiter?.take(data.byteLength, uploadAbort.signal);
        if (channel.readyState !== 'open') break;
        channel.send(packet);
        uploadedBytes += data.byteLength;
      }
    } catch (err) {
      closePeer(key);
    } finally {
      sending = false;
      updateP2pStatus();
    }
  }

  channel.onmessage = e => {
    if (typeof e.data !== 'string' || e.data.length > 4096) return;
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { return; }
    if (msg.t === 'open') {
      file = heldFiles().get(msg.url) || null;
      partial = partialFiles.get(msg.url) || null;
      const manifest = heldManifests.get(msg.url) || partial?.manifest;
      if (!manifest || manifest.id !== msg.id) { file = null; partial = null; }
      channel.send(JSON.stringify(file || partial ? { t: 'ok', size: file?.size || partial.manifest.size, id: manifest.id,
        ranges: file ? [[0, manifest.chunks.length - 1]] : DublineTransferUtils.rangesFromIndexes(partial.durable) } : { t: 'no' }));
    } else if (msg.t === 'get' && (file || partial) && Number.isInteger(msg.i) && msg.i >= 0 && msg.i < Math.ceil((file?.size || partial.manifest.size) / P2P_CHUNK) && queue.length < 64) {
      queue.push(msg.i);
      pump();
    }
  };
  channel.onclose = () => closePeer(key);
}

// ---------- Downloading: from players, the rest from the host ----------
function connectToSeeder(peerId) {
  return new Promise((resolve, reject) => {
    const key = `leech:${peerId}`;
    closePeer(key);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const channel = window.DublineNetwork.channel(pc.createDataChannel('dubline', { ordered: true }));
    channel.binaryType = 'arraybuffer';
    const peer = { pc, channel, pending: [], remoteSet: false, key, sessionId: session?.activeSessionId };
    peers.set(key, peer);

    const fail = (reason) => {
      clearTimeout(timer);
      closePeer(key);
      reject(new Error(reason));
    };
    const timer = setTimeout(() => fail('timeout'), P2P_CONNECT_TIMEOUT);
    pc.onicecandidate = e => { if (e.candidate) signal(peerId, { kind: 'candidate', from: 'leech', candidate: e.candidate }, peer.sessionId); };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) fail(pc.connectionState); };
    channel.onopen = () => {
      clearTimeout(timer);
      resolve(peer);
    };
    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => signal(peerId, { kind: 'offer', sdp: pc.localDescription }, peer.sessionId))
      .catch(err => fail(err.message));
  });
}

function runPeer(peer, job) {
  return new Promise(resolve => {
    const channel = peer.channel;
    const inflight = new Map(); // index -> { timer, startedAt }
    let opened = false;
    let ended = false;

    const finish = () => {
      if (ended) return;
      ended = true;
      clearTimeout(openTimer);
      clearInterval(availabilityTimer);
      for (const [index, request] of inflight) {
        clearTimeout(request.timer);
        job.scheduler.finished(peer.key, 0, 0, true);
        if (!job.parts[index]) job.pending.unshift(index);
      }
      inflight.clear();
      closePeer(peer.key);
      resolve();
    };

    const fill = () => {
      if (ended) return;
      if (job.cancelled) return finish();
      while (opened && job.pending.length) {
        const next = job.scheduler.pick(peer.key, job.pending, video.currentTime || 0, session?.videoDuration);
        if (next === -1) break;
        const [index] = job.pending.splice(next, 1);
        job.scheduler.started(peer.key);
        inflight.set(index, { timer: setTimeout(finish, P2P_CHUNK_TIMEOUT), startedAt: performance.now() });
        channel.send(JSON.stringify({ t: 'get', i: index }));
      }
      if (opened && !inflight.size) finish();
    };

    channel.onmessage = e => {
      if (typeof e.data === 'string') {
        let msg;
        try { msg = JSON.parse(e.data); } catch (err) { return finish(); }
        if (msg.t === 'ok' && msg.size === job.size && msg.id === job.manifest.id && DublineTransferUtils.validRanges(msg.ranges, job.manifest.chunks.length)) {
          peer.available = msg.ranges;
          job.scheduler.availability(peer.key, msg.ranges);
          opened = true;
          job.peersUsed++;
          fill();
        } else {
          finish();
        }
        return;
      }
      if (!(e.data instanceof ArrayBuffer) || e.data.byteLength < 4 || e.data.byteLength > P2P_CHUNK + 4) return finish();
      const index = new DataView(e.data).getUint32(0);
      if (index >= job.parts.length || e.data.byteLength - 4 !== Math.min(P2P_CHUNK, job.size - index * P2P_CHUNK)) return finish();
      const request = inflight.get(index);
      if (!request) return;
      clearTimeout(request.timer);
      inflight.delete(index);
      job.scheduler.finished(peer.key, e.data.byteLength - 4, performance.now() - request.startedAt);
      if (!job.parts[index]) {
        job.accept(index, e.data.slice(4), 'p2p');
      }
      fill();
    };
    channel.onclose = finish;

    const openTimer = setTimeout(() => { if (!opened) finish(); }, 4000);
    let refreshing = false;
    const availabilityTimer = setInterval(async () => {
      if (refreshing || ended || job.cancelled) return;
      refreshing = true;
      try {
        const latest = (await findSeeders(job.url)).find(entry => entry.socketId === peer.key.slice(6) && entry.id === job.manifest.id);
        if (!ended && latest && job.scheduler.availability(peer.key, latest.ranges)) fill();
      } finally { refreshing = false; }
    }, 1500);
    channel.send(JSON.stringify({ t: 'open', url: job.url, id: job.manifest.id }));
  });
}

async function runHttp(job) {
  while (!job.cancelled && job.pending.length) {
    job.pending.sort((a, b) => a - b);
    const run = [job.pending.shift()];
    while (run.length < HTTP_RUN && job.pending[0] === run[run.length - 1] + 1) run.push(job.pending.shift());
    const from = run[0] * P2P_CHUNK;
    const to = Math.min(job.size, (run[run.length - 1] + 1) * P2P_CHUNK) - 1;
    const res = await fetch(job.url, { headers: { Range: `bytes=${from}-${to}` }, signal: job.abort.signal });
    if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
    let buffer = await res.arrayBuffer();
    if (res.status === 200) buffer = buffer.slice(from, to + 1); // the server ignored Range
    if (buffer.byteLength !== to - from + 1) throw new Error('HTTP Range size mismatch');
    run.forEach((index, k) => {
      if (!job.parts[index]) job.accept(index, buffer.slice(k * P2P_CHUNK, (k + 1) * P2P_CHUNK), 'http');
    });
    job.httpBytes += buffer.byteLength;
    job.progress();
  }
}

async function sha256Hex(blob) {
  if (!window.crypto || !crypto.subtle) return null; // can't verify without HTTPS
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function downloadFile({ url, size, hash, type, direct }, onProgress, abort) {
  const sessionId = session.activeSessionId;
  const response = await fetch(`/api/media-manifest?${new URLSearchParams({ room: currentRoom, sessionId, clientId, url })}`, { signal: abort.signal });
  if (!response.ok) throw new Error('Media manifest unavailable');
  const manifest = await response.json();
  if (!DublineMediaCache.valid(manifest) || manifest.sessionId !== sessionId || manifest.url !== url || manifest.size !== size || hash && manifest.sha256 !== hash) throw new Error('Media manifest mismatch');
  if (!mediaPins.has(manifest.id)) mediaPins.set(manifest.id, DublineMediaCache.pin(manifest.id));
  const count = Math.ceil(size / P2P_CHUNK);
  const cached = await DublineMediaCache.load(manifest);
  heldManifests.set(url, manifest);
  const partial = { manifest, durable: new Set(), bytes: new Map() }; partialFiles.set(url, partial);
  const parts = new Array(count);
  let cachedBytes = 0;
  for (let chunk = 0; chunk < cached.length; chunk++) if (cached[chunk]) {
    const bytes = cached[chunk]; cachedBytes += bytes.byteLength;
    partial.durable.add(chunk); partial.bytes.set(chunk, bytes);
    for (let offset = 0; offset < bytes.byteLength; offset += P2P_CHUNK) parts[chunk * 4 + offset / P2P_CHUNK] = bytes.slice(offset, offset + P2P_CHUNK).buffer;
  }
  const verified = new Set(cached.flatMap((bytes, index) => bytes ? [index] : []));
  const verification = new Map();
  const verifyChunk = async chunk => {
    if (verified.has(chunk)) return true;
    const first = chunk * 4, last = Math.min(count, first + 4);
    if (Array.from({ length: last - first }, (_, index) => job.parts[first + index]).some(part => !part)) return false;
    const bytes = new Uint8Array(await new Blob(job.parts.slice(first, last)).arrayBuffer());
    if (!await DublineMediaCache.verify(manifest, chunk, bytes)) return false;
    verified.add(chunk);
    if (await DublineMediaCache.put(manifest, chunk, bytes)) { partial.durable.add(chunk); partial.bytes.set(chunk, bytes); scheduleAnnounce(); }
    return true;
  };
  const job = {
    url, size, manifest,
    scheduler: new DublineTransferUtils.DownloadScheduler(manifest.chunks.length),
    parts,
    pending: Array.from({ length: count }, (_, i) => i).filter(index => !parts[index]),
    p2pBytes: 0, httpBytes: 0, peersUsed: 0,
    cachedBytes,
    uniqueBytes: cachedBytes,
    abort,
    get cancelled() { return abort.signal.aborted; },
    progress: () => onProgress(job),
    accept: (index, bytes, origin) => {
      if (job.parts[index]) return;
      job.parts[index] = bytes; job.uniqueBytes += bytes.byteLength;
      if (origin === 'p2p') job.p2pBytes += bytes.byteLength;
      const chunk = Math.floor(index / 4), start = chunk * 4, end = Math.min(count, start + 4);
      if (!verified.has(chunk) && !verification.has(chunk) && Array.from({ length: end - start }, (_, offset) => job.parts[start + offset]).every(Boolean)) {
        const task = verifyChunk(chunk).finally(() => verification.delete(chunk)); verification.set(chunk, task);
      }
      onProgress(job);
    }
  };
  job.progress();
  if (direct && job.pending.length) { try {
    const result = await direct();
    if (result.blob.size !== size || await sha256Hex(result.blob) !== manifest.sha256) throw new Error('Direct media mismatch');
    for (let chunk = 0; chunk < manifest.chunks.length; chunk++) {
      const bytes = new Uint8Array(await result.blob.slice(chunk * manifest.chunkSize, (chunk + 1) * manifest.chunkSize).arrayBuffer());
      await DublineMediaCache.put(manifest, chunk, bytes);
    }
    onProgress({ ...job, uniqueBytes: size }); return { ...result, cachedBytes: 0 };
  } catch (error) { if (abort.signal.aborted) throw error; console.info('[Dubline] Voxalike direct unavailable; using peers / host.'); } }
  const seeders = p2pEnabled && window.crypto?.subtle && window.RTCPeerConnection && job.pending.length ? (await findSeeders(url)).slice(0, P2P_MAX_PEERS) : [];
  await Promise.all(seeders.filter(peer => peer.id === manifest.id).map(peer => connectToSeeder(peer.socketId).then(connection => runPeer(connection, job)).catch(() => {})));
  await Promise.all(verification.values());
  // Corrupt peers cannot poison the cache or prevent recovery from canonical HTTP.
  for (let chunk = 0; chunk < manifest.chunks.length; chunk++) {
    if (verified.has(chunk)) continue;
    if (await verifyChunk(chunk)) continue;
    for (let index = chunk * 4; index < Math.min(count, (chunk + 1) * 4); index++) { job.uniqueBytes -= job.parts[index]?.byteLength || 0; job.parts[index] = null; if (!job.pending.includes(index)) job.pending.push(index); }
  }
  if (job.cancelled) throw new Error('cancelled');
  if (job.pending.length) await runHttp(job);
  await Promise.all(verification.values());
  if (window.crypto?.subtle) for (let chunk = 0; chunk < manifest.chunks.length; chunk++) if (!await verifyChunk(chunk)) throw new Error('Chunk verification failed');
  if (job.cancelled) throw new Error('cancelled');

  const blob = new Blob(job.parts, { type });
  if (blob.size !== size) throw new Error('size mismatch');
  if (hash) {
    const actual = await sha256Hex(blob);
    if (actual && actual !== hash) throw new Error('hash mismatch');
  }
  return { blob, p2pBytes: job.p2pBytes, httpBytes: job.httpBytes, cachedBytes, peers: job.peersUsed };
}

// ---------- Scene media loading ----------
function setHostSources() {
  video.src = mediaUrl(session.videoUrl);
  backing.src = mediaUrl(session.backingUrl);
}

function cancelMediaDownload() {
  if (mediaDownload) {
    mediaDownload.abort.abort();
    window.reportPlayerActivity?.('idle', 100, true);
  }
  mediaDownload = null;
}

// Called when the room's scene video changes
async function loadSceneMedia() {
  cancelMediaDownload();
  for (const release of mediaPins.values()) release(); mediaPins.clear();
  ++announceGeneration; clearTimeout(announceTimer); announceTimer = null;
  for (const key of [...peers.keys()]) closePeer(key);
  partialFiles.clear(); heldManifests.clear();
  p2pStatus = null;
  const current = session;
  const hasLocal = localMedia && localMedia.forVideoUrl === current.videoUrl && localMedia.source === 'disk';

  // Already have it from disk, or we are on the server itself, or P2P is off: play as usual
  if (hasLocal || isOnServerMachine() || !current.videoSize || !current.videoUrl) {
    setHostSources();
    updateP2pStatus();
    announceHave();
    window.reportPlayerActivity?.('idle', 100, true);
    window.updateMediaTransfer?.({ downloading: false }); return;
  }

  // Download it all (from players, the rest from the host), then play locally and share it ourselves
  const abort = new AbortController();
  const download = { abort, videoUrl: current.videoUrl };
  mediaDownload = download;
  window.reportPlayerActivity?.('downloading', 0, true);
  const files = [{ url: current.videoUrl, size: current.videoSize, hash: current.videoHash, type: 'video/mp4', role: 'video' }];
  if (current.backingUrl && current.backingSize) {
    files.push({ url: current.backingUrl, size: current.backingSize, hash: current.backingHash, type: 'audio/mpeg', role: 'backing' });
  }
  for (const [role, url] of Object.entries(DublineProjectAudio.sources(current))) {
    if (!url || files.some(file => file.url === url)) continue;
    try {
      const response = await fetch(`/api/media-manifest?${new URLSearchParams({ room: currentRoom, sessionId: current.activeSessionId, clientId, url })}`, { signal: abort.signal });
      if (!response.ok) throw new Error('Audio manifest unavailable');
      const manifest = await response.json();
      if (!DublineMediaCache.valid(manifest) || manifest.sessionId !== current.activeSessionId) throw new Error('Audio manifest mismatch');
      files.push({ url, size: manifest.size, hash: manifest.sha256, type: 'audio/mpeg', role });
    } catch (error) { if (abort.signal.aborted) return; console.info('[DubLine] Audio source will stream from host:', error.message); }
  }
  const direct = current.workshopSource;
  let archive;
  if (direct && window.crypto?.subtle && /^[a-f0-9]{64}$/.test(direct.archiveHash)) {
    for (const file of files) {
      const entry = file.role === 'video' ? direct.videoEntry : direct.backingEntry;
      if (!entry || decodeURIComponent(file.url.split('/').pop()) !== entry || !file.hash) continue;
      file.direct = async () => {
        if (!archive) archive = (async () => {
          const url = new URL(direct.downloadUrl);
          if (url.protocol !== 'https:' || !['voxalike.com', 'www.voxalike.com'].includes(url.hostname) || url.username || url.password || url.port || !/^\/workshop\/[a-z0-9_/-]+\/download$/.test(url.pathname)) throw new Error('Invalid Voxalike URL');
          p2pStatus = { state: 'direct' }; updateP2pStatus();
          const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) });
          if (!response.ok || !response.body) throw new Error('Voxalike download failed');
          if (response.url && !['voxalike.com', 'www.voxalike.com'].includes(new URL(response.url).hostname)) throw new Error('Unsupported redirect');
          const parts = []; let total = 0;
          const reader = response.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read(); if (done) break;
              total += value.byteLength;
              if (total > direct.archiveSize || total > 300 * 1024 * 1024) throw new Error('Voxalike archive too large');
              parts.push(value);
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          const blob = new Blob(parts);
          if (blob.size !== direct.archiveSize || await sha256Hex(blob) !== direct.archiveHash) throw new Error('Voxalike archive changed');
          return (await DublineLazyScripts.jszip()).loadAsync(await blob.arrayBuffer());
        })();
        try {
          const zip = await archive;
          const matches = Object.values(zip.files).filter(item => !item.dir && item.name.split(/[\\/]/).pop() === entry);
          const item = matches.at(-1);
          if (!item || item._data?.uncompressedSize !== file.size) throw new Error('Voxalike asset mismatch');
          const blob = new Blob([await item.async('arraybuffer')], { type: file.type });
          if (blob.size !== file.size || await sha256Hex(blob) !== file.hash) throw new Error('Voxalike asset changed');
          return { blob, p2pBytes: 0, httpBytes: 0, directBytes: blob.size, peers: 0 };
        } catch (error) { p2pStatus = { state: 'fallback' }; updateP2pStatus(); throw error; }
      };
    }
  }
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  let doneBytes = 0;
  const totals = { p2p: 0, http: 0, direct: 0 };
  const results = {};
  const assets = {};
  let lastProgressUi = 0, lastTransferBytes = 0, lastTransferAt = performance.now();

  try {
    for (const file of files) {
      const result = await downloadFile(file, job => {
        if (mediaDownload !== download) return;
        p2pStatus = {
          state: 'fetching',
          pct: Math.min(100, Math.round(((doneBytes + job.uniqueBytes) / totalSize) * 100)),
          p2p: totals.p2p + job.p2pBytes,
          http: totals.http + job.httpBytes
        };
        const now = performance.now();
        if (now - lastProgressUi < 1000 && p2pStatus.pct < 100) return;
        lastProgressUi = now;
        const bytes = doneBytes + job.uniqueBytes, downloadRate = Math.max(0, bytes - lastTransferBytes) / Math.max(.001, (now - lastTransferAt) / 1000);
        lastTransferBytes = bytes; lastTransferAt = now;
        const buckets = Array.from({ length: 96 }, (_, index) => {
          const from = index / 96 * totalSize, to = (index + 1) / 96 * totalSize;
          let received = Math.max(0, Math.min(to, doneBytes) - from);
          for (let part = Math.max(0, Math.floor((from - doneBytes) / P2P_CHUNK)); part < job.parts.length && doneBytes + part * P2P_CHUNK < to; part++) {
            if (job.parts[part]) received += Math.max(0, Math.min(to, doneBytes + (part + 1) * P2P_CHUNK, doneBytes + file.size) - Math.max(from, doneBytes + part * P2P_CHUNK));
          }
          return Math.max(0, Math.min(100, Math.round(received / (to - from) * 100)));
        });
        window.updateMediaTransfer?.({ downloading: true, pct: p2pStatus.pct, buckets, downloadRate });
        updateP2pStatus();
        window.reportPlayerActivity?.('downloading', p2pStatus.pct);
      }, abort);
      results[file.role] = result.blob;
      assets[file.url] = result.blob;
      doneBytes += file.size;
      totals.direct += result.directBytes || 0;
      totals.p2p += result.p2pBytes;
      totals.http += result.httpBytes;
      socket.emit('p2p_report', { url: file.url, p2pBytes: result.p2pBytes, httpBytes: result.httpBytes, peers: result.peers });
    }
    if (mediaDownload !== download || session.videoUrl !== download.videoUrl) return;
    mediaDownload = null;
    setLocalMedia({ video: results.video, backing: results.backing || null, assets, source: 'p2p', videoSourceUrl: current.videoUrl, backingSourceUrl: current.backingUrl });
    window.updateMediaTransfer?.({ downloading: false, fallback: false, pct: 100, buckets: new Array(96).fill(100) });
    p2pStatus = { state: 'done', direct: totals.direct, p2p: totals.p2p, http: totals.http, size: totalSize };
  } catch (err) {
    if (mediaDownload !== download) return; // cancelled: already loading something else
    mediaDownload = null;
    console.warn('[Dubline] Could not preload the video, watching from the host:', err.message);
    p2pStatus = { state: 'failed' };
    window.updateMediaTransfer?.({ downloading: false, fallback: true });
    setHostSources();
  }
  updateP2pStatus();
  window.reportPlayerActivity?.('idle', 100, true);
}

window.watchFromHostNow = function() {
  cancelMediaDownload();
  p2pStatus = null;
  setHostSources();
  updateP2pStatus();
};

function updateP2pStatus() {
  const lines = [];
  let pct = null;
  let showWatchNow = false;

  if (p2pStatus?.state === 'direct' || p2pStatus?.state === 'fallback') { lines.push(t(p2pStatus.state === 'direct' ? 'workshop.direct' : 'workshop.fallback')); }
  else if (p2pStatus && p2pStatus.state === 'fetching') {
    lines.push(t('p2p.fetching', { pct: p2pStatus.pct, p2p: formatSize(p2pStatus.p2p) || '0', http: formatSize(p2pStatus.http) || '0' }));
    pct = p2pStatus.pct;
    showWatchNow = true;
  } else if (p2pStatus && p2pStatus.state === 'done') {
    const share = p2pStatus.size ? Math.round((p2pStatus.p2p / p2pStatus.size) * 100) : 0;
    lines.push(t('p2p.done', { size: formatSize(p2pStatus.size), pct: share }));
  } else if (p2pStatus && p2pStatus.state === 'failed') {
    lines.push(t('p2p.failed'));
  }
  if (uploadedBytes > 0) lines.push(t('p2p.uploaded', { size: formatSize(uploadedBytes) }));

  p2pBox.style.display = lines.length ? 'flex' : 'none';
  p2pStatusText.innerHTML = lines.map(esc).join('<br>')
    + (showWatchNow ? `<br><button class="btn-outline" style="margin-top:6px;padding:3px 10px;font-size:11px;" onclick="watchFromHostNow()">${t('p2p.watchNow')}</button>` : '');
  p2pProgressBar.parentElement.style.display = pct === null ? 'none' : '';
  if (pct !== null) p2pProgressBar.style.width = `${pct}%`;
}

socket.on('connect', () => announceHave(true));
setInterval(() => { if (socket.connected) announceHave(true); }, 10000);
