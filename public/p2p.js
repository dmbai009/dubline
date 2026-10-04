// ==========================================
// P2P
// Players send each other the scene video directly (WebRTC DataChannel).
// The server only introduces players; whatever is missing is fetched from the host over HTTP.
// ==========================================
const P2P_CHUNK = 64 * 1024;
const P2P_MAX_PEERS = 3;
const P2P_PIPELINE = 8;            // how many pieces to request from one player at once
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

settingsP2P.checked = p2pEnabled;
settingsP2P.addEventListener('change', () => {
  p2pEnabled = settingsP2P.checked;
  localStorage.setItem('dubline_p2p', p2pEnabled ? '1' : '0');
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
  return files;
}

function announceHave(force = false) {
  if (!socket.connected) return;
  const urls = p2pEnabled ? [...heldFiles().keys()] : [];
  const key = `${socket.id}|${urls.join('|')}`;
  if (!force && key === lastAnnounce) return;
  lastAnnounce = key;
  socket.emit('p2p_have', { urls });
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
    socket.emit('p2p_find', { url }, ids => {
      clearTimeout(timer);
      resolve(Array.isArray(ids) ? ids : []);
    });
  });
}

// ---------- WebRTC signaling through the server ----------
function signal(to, data) {
  socket.emit('p2p_signal', { to, data });
}

function closePeer(key) {
  const peer = peers.get(key);
  if (!peer) return;
  peers.delete(key);
  try { peer.channel && peer.channel.close(); } catch (e) {}
  try { peer.pc.close(); } catch (e) {}
}

async function addCandidate(peer, candidate) {
  if (!peer.remoteSet) return peer.pending.push(candidate);
  try { await peer.pc.addIceCandidate(candidate); } catch (e) {}
}

async function markRemoteSet(peer) {
  peer.remoteSet = true;
  for (const candidate of peer.pending.splice(0)) {
    try { await peer.pc.addIceCandidate(candidate); } catch (e) {}
  }
}

socket.on('p2p_signal', async ({ from, data }) => {
  if (!data || !from) return;

  if (data.kind === 'offer') {
    // We are asked to share a file
    if (!p2pEnabled || !heldFiles().size) return;
    const key = `seed:${from}`;
    closePeer(key);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = { pc, channel: null, pending: [], remoteSet: false };
    peers.set(key, peer);
    pc.onicecandidate = e => { if (e.candidate) signal(from, { kind: 'candidate', from: 'seed', candidate: e.candidate }); };
    pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) closePeer(key); };
    pc.ondatachannel = e => {
      peer.channel = e.channel;
      serveChannel(e.channel, key);
    };
    await pc.setRemoteDescription(data.sdp);
    await markRemoteSet(peer);
    await pc.setLocalDescription(await pc.createAnswer());
    signal(from, { kind: 'answer', sdp: pc.localDescription });
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
  const queue = [];
  let sending = false;

  const waitForBuffer = () => new Promise(resolve => {
    channel.addEventListener('bufferedamountlow', resolve, { once: true });
  });

  async function pump() {
    if (sending) return;
    sending = true;
    try {
      while (queue.length && channel.readyState === 'open' && file) {
        if (channel.bufferedAmount > 1024 * 1024) await waitForBuffer();
        const index = queue.shift();
        const data = new Uint8Array(await file.slice(index * P2P_CHUNK, (index + 1) * P2P_CHUNK).arrayBuffer());
        const packet = new Uint8Array(4 + data.byteLength);
        new DataView(packet.buffer).setUint32(0, index);
        packet.set(data, 4);
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
    if (typeof e.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { return; }
    if (msg.t === 'open') {
      file = heldFiles().get(msg.url) || null;
      channel.send(JSON.stringify(file ? { t: 'ok', size: file.size } : { t: 'no' }));
    } else if (msg.t === 'get' && file && Number.isInteger(msg.i)) {
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
    const channel = pc.createDataChannel('dubline', { ordered: true });
    channel.binaryType = 'arraybuffer';
    const peer = { pc, channel, pending: [], remoteSet: false, key };
    peers.set(key, peer);

    const fail = (reason) => {
      clearTimeout(timer);
      closePeer(key);
      reject(new Error(reason));
    };
    const timer = setTimeout(() => fail('timeout'), P2P_CONNECT_TIMEOUT);
    pc.onicecandidate = e => { if (e.candidate) signal(peerId, { kind: 'candidate', from: 'leech', candidate: e.candidate }); };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) fail(pc.connectionState); };
    channel.onopen = () => {
      clearTimeout(timer);
      resolve(peer);
    };
    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => signal(peerId, { kind: 'offer', sdp: pc.localDescription }))
      .catch(err => fail(err.message));
  });
}

function runPeer(peer, job) {
  return new Promise(resolve => {
    const channel = peer.channel;
    const inflight = new Map(); // index -> timer
    let opened = false;
    let ended = false;

    const finish = () => {
      if (ended) return;
      ended = true;
      clearTimeout(openTimer);
      for (const [index, timer] of inflight) {
        clearTimeout(timer);
        if (!job.parts[index]) job.pending.unshift(index);
      }
      inflight.clear();
      closePeer(peer.key);
      resolve();
    };

    const fill = () => {
      if (ended) return;
      if (job.cancelled) return finish();
      while (opened && inflight.size < P2P_PIPELINE && job.pending.length) {
        const index = job.pending.shift();
        inflight.set(index, setTimeout(finish, P2P_CHUNK_TIMEOUT));
        channel.send(JSON.stringify({ t: 'get', i: index }));
      }
      if (opened && !inflight.size && !job.pending.length) finish();
    };

    channel.onmessage = e => {
      if (typeof e.data === 'string') {
        let msg;
        try { msg = JSON.parse(e.data); } catch (err) { return finish(); }
        if (msg.t === 'ok' && msg.size === job.size) {
          opened = true;
          job.peersUsed++;
          fill();
        } else {
          finish();
        }
        return;
      }
      const index = new DataView(e.data).getUint32(0);
      const timer = inflight.get(index);
      if (timer === undefined) return;
      clearTimeout(timer);
      inflight.delete(index);
      if (!job.parts[index]) {
        job.parts[index] = e.data.slice(4);
        job.p2pBytes += e.data.byteLength - 4;
        job.progress();
      }
      fill();
    };
    channel.onclose = finish;

    const openTimer = setTimeout(() => { if (!opened) finish(); }, 4000);
    channel.send(JSON.stringify({ t: 'open', url: job.url }));
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
    run.forEach((index, k) => {
      if (!job.parts[index]) job.parts[index] = buffer.slice(k * P2P_CHUNK, (k + 1) * P2P_CHUNK);
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

async function downloadFile({ url, size, hash, type }, onProgress, abort) {
  const count = Math.ceil(size / P2P_CHUNK);
  const job = {
    url, size,
    parts: new Array(count),
    pending: Array.from({ length: count }, (_, i) => i),
    p2pBytes: 0, httpBytes: 0, peersUsed: 0,
    abort,
    get cancelled() { return abort.signal.aborted; },
    progress: () => onProgress(job)
  };

  const seeders = (await findSeeders(url)).slice(0, P2P_MAX_PEERS);
  await Promise.all(seeders.map(id => connectToSeeder(id).then(peer => runPeer(peer, job)).catch(() => {})));
  if (job.cancelled) throw new Error('cancelled');
  if (job.pending.length) await runHttp(job);
  if (job.cancelled) throw new Error('cancelled');

  const blob = new Blob(job.parts, { type });
  if (blob.size !== size) throw new Error('size mismatch');
  if (hash) {
    const actual = await sha256Hex(blob);
    if (actual && actual !== hash) throw new Error('hash mismatch');
  }
  return { blob, p2pBytes: job.p2pBytes, httpBytes: job.httpBytes, peers: job.peersUsed };
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
  p2pStatus = null;
  const current = session;
  const hasLocal = localMedia && localMedia.forVideoUrl === current.videoUrl;

  // Already have it from disk, or we are on the server itself, or P2P is off: play as usual
  if (hasLocal || isOnServerMachine() || !p2pEnabled || !window.RTCPeerConnection || !current.videoSize || !current.videoUrl) {
    setHostSources();
    updateP2pStatus();
    announceHave();
    window.reportPlayerActivity?.('idle', 100, true);
    return;
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
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  let doneBytes = 0;
  const totals = { p2p: 0, http: 0 };
  const results = {};

  try {
    for (const file of files) {
      const result = await downloadFile(file, job => {
        if (mediaDownload !== download) return;
        p2pStatus = {
          state: 'fetching',
          pct: Math.min(100, Math.round(((doneBytes + job.p2pBytes + job.httpBytes) / totalSize) * 100)),
          p2p: totals.p2p + job.p2pBytes,
          http: totals.http + job.httpBytes
        };
        updateP2pStatus();
        window.reportPlayerActivity?.('downloading', p2pStatus.pct);
      }, abort);
      results[file.role] = result.blob;
      doneBytes += file.size;
      totals.p2p += result.p2pBytes;
      totals.http += result.httpBytes;
      socket.emit('p2p_report', { url: file.url, p2pBytes: result.p2pBytes, httpBytes: result.httpBytes, peers: result.peers });
    }
    if (mediaDownload !== download || session.videoUrl !== download.videoUrl) return;
    mediaDownload = null;
    setLocalMedia({ video: results.video, backing: results.backing || null, source: 'p2p', videoSourceUrl: current.videoUrl, backingSourceUrl: current.backingUrl });
    p2pStatus = { state: 'done', p2p: totals.p2p, http: totals.http, size: totalSize };
  } catch (err) {
    if (mediaDownload !== download) return; // cancelled: already loading something else
    mediaDownload = null;
    console.warn('[Dubline] Could not preload the video, watching from the host:', err.message);
    p2pStatus = { state: 'failed' };
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

  if (p2pStatus && p2pStatus.state === 'fetching') {
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
