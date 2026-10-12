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
const P2P_HTTP_GRACE = 750;         // host loading never waits for serial peer timeouts
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];

const p2pBox = document.getElementById('p2pBox');
const p2pStatusText = document.getElementById('p2pStatusText');
const p2pProgressBar = document.getElementById('p2pProgressBar');
const settingsP2P = document.getElementById('settingsP2P');

const P2P_CONSENT_KEY = 'dubline_p2p_consent_v1';
let p2pConsent = 'undecided', p2pEnabled = false;
let p2pJoined = false, p2pGeneration = 0;
let integrityProbe = null, integrityUnavailable = false, rtcUnavailable = false;
const mediaIntegritySupported = () => !!window.crypto?.subtle?.digest && !integrityUnavailable;
async function probeMediaIntegrity() {
  if (!mediaIntegritySupported()) return false;
  if (!integrityProbe) integrityProbe = crypto.subtle.digest('SHA-256', new Uint8Array()).then(() => true, () => {
    integrityUnavailable = true; stopP2pPeers(); syncP2pSetting(); announceHave(true); return false;
  });
  return integrityProbe;
}
function readP2pPreference() {
  try {
    const choice = localStorage.getItem(P2P_CONSENT_KEY);
    p2pConsent = ['accepted', 'declined'].includes(choice) ? choice : 'undecided';
    p2pEnabled = p2pConsent === 'accepted' && localStorage.getItem('dubline_p2p') === '1';
  } catch { p2pConsent = 'undecided'; p2pEnabled = false; }
}
readP2pPreference();
const peers = new Map();           // `${role}:${socketId}` -> { pc, channel, pending: [], remoteSet }
let mediaDownload = null;          // current scene video download
let sceneMediaState = { status: 'not_started', videoKey: null, audioKey: null, videoReady: false, error: null, diagnostic: null };
const videoIdentity = scene => JSON.stringify([scene?.activeSessionId, scene?.videoUrl, scene?.videoSize, scene?.videoHash]);
function sceneMediaFiles(scene) {
  const files = [{ url: scene.videoUrl, size: scene.videoSize, hash: scene.videoHash, type: 'video/mp4', role: 'video' }];
  if (scene.backingUrl) files.push({ url: scene.backingUrl, size: scene.backingSize, hash: scene.backingHash, type: audioMediaType(scene.backingUrl), role: 'backing' });
  for (const [role, url] of Object.entries(DublineProjectAudio.sources(scene))) if (url && !files.some(file => file.url === url)) files.push({ url, type: audioMediaType(url), role });
  return files;
}
const explainMediaDiagnostic = data => data ? { ...data, phaseLabel: t('media.transfer.phase.' + data.phase),
  fallbackLabel: data.fallback ? t((['insecure', 'integrity', 'unavailable', 'consent'].includes(data.fallback) ? 'p2p.reason.' : 'media.transfer.fallback.') + data.fallback) : '' } : null;
window.DublineMediaTransfer = Object.freeze({ stats: () => ({ status: sceneMediaState.status, videoReady: sceneMediaState.videoReady,
  source: !localMedia || localMedia.playbackFromHost ? 'host' : localMedia.source === 'disk' ? 'disk' : 'local', currentVideoVerified: !!(localMedia?.videoBlob && heldManifests.get(session?.videoUrl)?.id && verifiedHeldBlobs.get(localMedia.videoBlob) === heldManifests.get(session.videoUrl).id),
  statusLabel: t('media.transfer.state.' + sceneMediaState.status), secureContext: !!window.isSecureContext, p2pActive: !!p2pAllowed(),
  p2pReason: p2pCapability(), p2pReasonLabel: p2pCapability() ? t('p2p.reason.' + p2pCapability()) : '', error: sceneMediaState.error,
  diagnostic: explainMediaDiagnostic(mediaDownload?.diagnostic || sceneMediaState.diagnostic), files: (sceneMediaState.files || []).map(explainMediaDiagnostic) }) });
window.retrySceneMedia = () => loadSceneMedia(true);
window.isSceneVideoPending = () => !!mediaDownload && !sceneMediaState.videoReady && !mediaDownload.watchingHost;
window.sceneMediaPreparation = () => {
  if (!mediaDownload && sceneMediaState.status !== 'failed') return null;
  if (video.readyState < 2) return { key: 'media.preparing', channels: [] };
  return DublineProjectAudio.preparationStatus(session, { original: originalTrackAudio, backing });
};
let p2pStatus = null;              // what to show in the lobby footer
let uploadedBytes = 0;             // how much we have shared with others
let lastAnnounce = '';
const mediaPins = new Map();
const partialFiles = new Map();
const heldManifests = new Map();
const verifiedHeldBlobs = new WeakMap();
function pruneSceneMedia(wanted) {
  for (const url of heldManifests.keys()) if (!wanted.has(url)) heldManifests.delete(url);
  for (const url of partialFiles.keys()) if (!wanted.has(url)) partialFiles.delete(url);
  const retained = new Set([...heldManifests.values()].map(manifest => manifest.id));
  for (const [id, release] of mediaPins) if (!retained.has(id)) { release(); mediaPins.delete(id); }
  for (const [key, peer] of peers) if (peer.mediaUrl && !wanted.has(peer.mediaUrl)) closePeer(key, peer);
}
let announceTimer = null, announceGeneration = 0;
let availabilitySequence = 0;
function scheduleAnnounce() { if (announceTimer === null) announceTimer = setTimeout(() => { announceTimer = null; announceHave(); }, 300); }

const p2pConsentDialog = document.getElementById('p2pConsentDialog');
let p2pConsentRequested = false, p2pConsentFocus = null, p2pExpectedCloses = 0;
let lastP2pAllowed = false;
function p2pCapability() {
  if (!window.isSecureContext) return 'insecure';
  if (!mediaIntegritySupported()) return 'integrity';
  if (rtcUnavailable || typeof window.RTCPeerConnection !== 'function') return 'unavailable';
  if (p2pConsent !== 'accepted' || !p2pEnabled) return 'consent';
  return null;
}
function p2pAllowed() { return !p2pCapability() && !p2pConsentDialog.open && p2pJoined && window.hasSceneMediaAccess() && session && !session.singlePlayer; }
window.DublineP2P = Object.freeze({ allowed: p2pAllowed, capability: p2pCapability });
function currentP2pPeer(peer, key) { return p2pAllowed() && peer?.generation === p2pGeneration && peer.sessionId === session.activeSessionId && peers.get(key) === peer; }
function syncP2pSetting() {
  const reason = p2pCapability(), unavailable = ['insecure', 'integrity', 'unavailable'].includes(reason);
  settingsP2P.checked = p2pConsent === 'accepted' && p2pEnabled && !session?.singlePlayer && !unavailable;
  settingsP2P.disabled = unavailable;
  settingsP2P.title = unavailable ? t('p2p.reason.' + reason) : '';
  window.setControlHelp?.(settingsP2P, settingsP2P.title);
  const allowed = !!p2pAllowed();
  if (allowed !== lastP2pAllowed) { lastP2pAllowed = allowed; window.dispatchEvent(new CustomEvent('dubline-p2p-changed')); }
}
function stopP2pPeers() {
  ++p2pGeneration; ++announceGeneration;
  for (const key of [...peers.keys()]) closePeer(key);
}
function hideP2pConsent() {
  if (!p2pConsentDialog.open) return;
  ++p2pExpectedCloses;
  p2pConsentDialog.close();
  if (p2pConsentFocus?.isConnected) p2pConsentFocus.focus();
}
function maybeShowP2pConsent() {
  syncP2pSetting();
  const blocked = [...document.querySelectorAll('.modal-overlay, dialog[open]')].some(node => node !== p2pConsentDialog &&
    !(p2pConsentRequested && node.id === 'settingsModal') && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
  if (!p2pJoined || !socket.connected || session?.singlePlayer || blocked) {
    if (p2pConsentDialog.open) { ++p2pExpectedCloses; p2pConsentDialog.close(); }
    return;
  }
  if (p2pConsentDialog.open || p2pConsent !== 'undecided' && !p2pConsentRequested) return;
  p2pConsentFocus = document.activeElement;
  document.getElementById('p2pConsentError').hidden = true;
  p2pConsentDialog.showModal();
  document.getElementById('p2pConsentDecline').focus();
}
function decideP2pConsent(accepted) {
  if (accepted && !p2pConsentDialog.open) return;
  stopP2pPeers(); p2pEnabled = false;
  try {
    // Write the setting before consent: interrupted storage must never opt in.
    localStorage.setItem('dubline_p2p', accepted ? '1' : '0');
    localStorage.setItem(P2P_CONSENT_KEY, accepted ? 'accepted' : 'declined');
    if (localStorage.getItem(P2P_CONSENT_KEY) !== (accepted ? 'accepted' : 'declined') || localStorage.getItem('dubline_p2p') !== (accepted ? '1' : '0')) throw new Error('Preference was not stored');
  } catch {
    try { localStorage.removeItem(P2P_CONSENT_KEY); } catch { /* fail closed in this page */ }
    p2pConsent = 'undecided';
    syncP2pSetting();
    if (accepted) { document.getElementById('p2pConsentError').hidden = false; announceHave(true); return; }
    showToast(t('p2p.consent.storageError'));
  }
  p2pConsent = accepted ? 'accepted' : 'declined'; p2pEnabled = accepted;
  p2pConsentRequested = false;
  hideP2pConsent(); syncP2pSetting(); announceHave(true);
}
document.getElementById('p2pConsentAccept').onclick = () => decideP2pConsent(true);
document.getElementById('p2pConsentDecline').onclick = document.getElementById('p2pConsentClose').onclick = () => decideP2pConsent(false);
p2pConsentDialog.addEventListener('cancel', event => { event.preventDefault(); decideP2pConsent(false); });
p2pConsentDialog.addEventListener('close', () => { if (p2pExpectedCloses) --p2pExpectedCloses; else decideP2pConsent(false); });
// Observe only dialog visibility, never timeline or participant DOM updates.
const p2pDialogObserver = new MutationObserver(maybeShowP2pConsent);
document.querySelectorAll('.modal-overlay, dialog.text-prompt').forEach(node => p2pDialogObserver.observe(node, { attributes: true, attributeFilter: ['style', 'hidden', 'open'] }));
syncP2pSetting();
settingsP2P.addEventListener('change', () => {
  const requested = settingsP2P.checked;
  if (requested && p2pConsent !== 'accepted') {
    p2pEnabled = false; syncP2pSetting(); p2pConsentRequested = true; maybeShowP2pConsent(); return;
  }
  stopP2pPeers(); p2pEnabled = false;
  try {
    localStorage.setItem('dubline_p2p', requested ? '1' : '0');
    if (localStorage.getItem('dubline_p2p') !== (requested ? '1' : '0')) throw new Error('Preference was not stored');
    p2pEnabled = requested;
  }
  catch { try { localStorage.removeItem(P2P_CONSENT_KEY); } catch {} p2pConsent = 'undecided'; showToast(t('p2p.consent.storageError')); }
  syncP2pSetting();
  announceHave(true);
});
window.addEventListener('storage', event => {
  if (event.key !== null && ![P2P_CONSENT_KEY, 'dubline_p2p'].includes(event.key)) return;
  stopP2pPeers(); readP2pPreference();
  if (p2pConsent !== 'undecided') { p2pConsentRequested = false; hideP2pConsent(); }
  syncP2pSetting(); announceHave(true);
});
socket.on('session_updated', () => {
  p2pJoined = true;
  if (session?.singlePlayer) { p2pConsentRequested = false; stopP2pPeers(); }
  maybeShowP2pConsent(); announceHave(true);
});
function leaveP2pRoom() { p2pJoined = false; p2pConsentRequested = false; stopP2pPeers(); if (p2pConsentDialog.open) { ++p2pExpectedCloses; p2pConsentDialog.close(); } syncP2pSetting(); }
socket.on('disconnect', leaveP2pRoom); socket.on('join_denied', leaveP2pRoom);

function isOnServerMachine() {
  return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

// ---------- What we have in full ----------
function heldFiles() {
  const files = new Map();
  if (!session || !localMedia || localMedia.forVideoUrl !== session.videoUrl) return files;
  if (localMedia.videoBlob) files.set(session.videoUrl, localMedia.videoBlob);
  if (localMedia.backingBlob && localMedia.backingSourceUrl === session.backingUrl && session.backingUrl) files.set(session.backingUrl, localMedia.backingBlob);
  const allowed = new Set(sceneMediaFiles(session).map(file => file.url));
  for (const [url, asset] of Object.entries(localMedia.assets || {})) if (allowed.has(url)) files.set(url, asset.blob);
  return files;
}

async function announceHave(force = false) {
  if (!socket.connected) return;
  const generation = ++announceGeneration, sessionId = session?.activeSessionId;
  const files = [];
  if (p2pAllowed() && await probeMediaIntegrity() && p2pAllowed()) {
    for (const [url, blob] of heldFiles()) {
      let manifest = heldManifests.get(url);
      if (!manifest) {
        try {
          const response = await fetch(`/api/media-manifest?${new URLSearchParams({ room: currentRoom, sessionId, clientId, url })}`);
          if (!response.ok) continue; manifest = await response.json();
          if (!DublineMediaCache.valid(manifest)) continue;
          if (!p2pAllowed() || generation !== announceGeneration || session?.activeSessionId !== sessionId) return;
          heldManifests.set(url, manifest);
        } catch { continue; }
      }
      if (manifest.size !== blob.size) continue;
      if (verifiedHeldBlobs.get(blob) !== manifest.id) {
        if (await sha256Hex(blob) !== manifest.sha256) continue;
        if (!p2pAllowed() || generation !== announceGeneration || session?.activeSessionId !== sessionId) return;
        verifiedHeldBlobs.set(blob, manifest.id);
      }
      files.push({ url, id: manifest.id, ranges: [[0, manifest.chunks.length - 1]] });
    }
    const wanted = new Set(sceneMediaFiles(session).map(file => file.url));
    for (const [url, partial] of partialFiles) if (wanted.has(url) && !files.some(file => file.url === url)) files.push({ url, id: partial.manifest.id, ranges: DublineTransferUtils.rangesFromIndexes(partial.durable) });
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

function findSeeders(url, signal) {
  if (!p2pAllowed() || signal?.aborted) return Promise.resolve([]);
  const generation = p2pGeneration;
  return new Promise(resolve => {
    const finish = ids => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); resolve(ids); };
    const cancel = () => finish([]);
    const timer = setTimeout(cancel, 3000);
    signal?.addEventListener('abort', cancel, { once: true });
    const reply = ids => {
      finish(p2pAllowed() && !signal?.aborted && generation === p2pGeneration && Array.isArray(ids) ? ids : []);
    };
    const payload = { url, detailed: true, sessionId: session?.activeSessionId };
    if (socket.timeout) socket.timeout(3000).emit('p2p_find', payload, (error, ids) => reply(error ? [] : ids));
    else socket.emit('p2p_find', payload, reply);
  });
}

// ---------- WebRTC signaling through the server ----------
function signal(to, data, sessionId = session?.activeSessionId) {
  if (!p2pAllowed() || sessionId !== session?.activeSessionId) return;
  socket.emit('p2p_signal', { to, data, sessionId });
}

function closePeer(key, expected) {
  const peer = peers.get(key);
  if (!peer || expected && expected !== peer) return;
  peers.delete(key);
  peer.uploadAbort?.abort(); peer.cancel?.();
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
  if (!p2pAllowed() || !data || !from || sessionId !== session?.activeSessionId) return;
  const generation = p2pGeneration;
  if (!await probeMediaIntegrity() || generation !== p2pGeneration || !p2pAllowed() || sessionId !== session?.activeSessionId) return;

  if (data.kind === 'offer') {
    // We are asked to share a file
    if (!window.crypto?.subtle || (!heldFiles().size && !partialFiles.size) || [...peers.keys()].filter(key => key.startsWith('seed:')).length >= P2P_MAX_PEERS) return;
    const key = `seed:${from}`;
    closePeer(key);
    let pc;
    try { pc = new RTCPeerConnection({ iceServers: ICE_SERVERS }); }
    catch { rtcUnavailable = true; stopP2pPeers(); syncP2pSetting(); announceHave(true); return; }
    const peer = { pc, channel: null, pending: [], remoteSet: false, sessionId, generation: p2pGeneration };
    peers.set(key, peer);
    pc.onicecandidate = e => { if (e.candidate && currentP2pPeer(peer, key)) signal(from, { kind: 'candidate', from: 'seed', candidate: e.candidate }, sessionId); };
    pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) closePeer(key, peer); };
    pc.ondatachannel = e => {
      if (!currentP2pPeer(peer, key)) { e.channel.close(); return; }
      peer.channel = window.DublineNetwork.channel(e.channel);
      serveChannel(e.channel, key);
    };
    try {
      await pc.setRemoteDescription(data.sdp);
      if (!currentP2pPeer(peer, key)) return;
      await markRemoteSet(peer);
      const answer = await pc.createAnswer();
      if (!currentP2pPeer(peer, key)) return;
      await pc.setLocalDescription(answer);
      if (currentP2pPeer(peer, key)) signal(from, { kind: 'answer', sdp: pc.localDescription }, sessionId);
    } catch { closePeer(key, peer); }
  } else if (data.kind === 'answer') {
    const key = `leech:${from}`, peer = peers.get(key);
    if (!peer) return;
    try {
      await peer.pc.setRemoteDescription(data.sdp);
      if (currentP2pPeer(peer, key)) await markRemoteSet(peer);
    } catch { closePeer(key, peer); }
  } else if (data.kind === 'candidate') {
    // A candidate from the sharer goes to our downloading connection, and vice versa
    const peer = peers.get(data.from === 'seed' ? `leech:${from}` : `seed:${from}`);
    if (peer) addCandidate(peer, data.candidate);
  }
});

// ---------- Sharing: answer piece requests ----------
function serveChannel(channel, key) {
  const peer = peers.get(key);
  if (!currentP2pPeer(peer, key) || peer.channel !== channel) { channel.close(); return; }
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = 256 * 1024;
  let file = null;
  let partial = null;
  const queue = [];
  let sending = false;
  const uploadAbort = new AbortController();
  peer.uploadAbort = uploadAbort;
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
      while (currentP2pPeer(peer, key) && queue.length && channel.readyState === 'open' && (file || partial)) {
        if (channel.bufferedAmount > 1024 * 1024) { await waitForBuffer(); if (channel.bufferedAmount > 1024 * 1024) continue; }
        if (!currentP2pPeer(peer, key) || channel.readyState !== 'open') break;
        const index = queue.shift();
        const chunk = Math.floor(index / 4);
        if (!file && !partial.durable.has(chunk)) continue;
        const data = file ? new Uint8Array(await file.slice(index * P2P_CHUNK, (index + 1) * P2P_CHUNK).arrayBuffer()) : partial.bytes.get(chunk)?.slice(index % 4 * P2P_CHUNK, (index % 4 + 1) * P2P_CHUNK);
        if (!data) continue;
        const packet = new Uint8Array(4 + data.byteLength);
        new DataView(packet.buffer).setUint32(0, index);
        packet.set(data, 4);
        await window.mediaUploadLimiter?.take(data.byteLength, uploadAbort.signal);
        if (!currentP2pPeer(peer, key) || channel.readyState !== 'open') break;
        channel.send(packet);
        uploadedBytes += data.byteLength;
      }
    } catch (err) {
      closePeer(key, peer);
    } finally {
      sending = false;
      updateP2pStatus();
    }
  }

  channel.onmessage = e => {
    if (!currentP2pPeer(peer, key)) return;
    if (typeof e.data !== 'string' || e.data.length > 4096) return;
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { return; }
    if (msg.t === 'open') {
      peer.mediaUrl = msg.url;
      file = heldFiles().get(msg.url) || null;
      partial = partialFiles.get(msg.url) || null;
      const manifest = heldManifests.get(msg.url) || partial?.manifest;
      if (file && verifiedHeldBlobs.get(file) !== manifest?.id) file = null;
      if (!manifest || manifest.id !== msg.id) { file = null; partial = null; }
      channel.send(JSON.stringify(file || partial ? { t: 'ok', size: file?.size || partial.manifest.size, id: manifest.id,
        ranges: file ? [[0, manifest.chunks.length - 1]] : DublineTransferUtils.rangesFromIndexes(partial.durable) } : { t: 'no' }));
    } else if (msg.t === 'get' && (file || partial) && Number.isInteger(msg.i) && msg.i >= 0 && msg.i < Math.ceil((file?.size || partial.manifest.size) / P2P_CHUNK) && queue.length < 64) {
      queue.push(msg.i);
      pump();
    }
  };
  channel.onclose = () => closePeer(key, peer);
}

// ---------- Downloading: from players, the rest from the host ----------
async function connectToSeeder(peerId, abortSignal) {
  if (!p2pAllowed() || abortSignal?.aborted) return Promise.reject(new Error('P2P disabled'));
  const generation = p2pGeneration;
  if (!await probeMediaIntegrity() || generation !== p2pGeneration || !p2pAllowed() || abortSignal?.aborted) throw new Error('P2P disabled');
  return new Promise((resolve, reject) => {
    const key = `leech:${peerId}`;
    closePeer(key);
    let pc, channel;
    try { pc = new RTCPeerConnection({ iceServers: ICE_SERVERS }); channel = window.DublineNetwork.channel(pc.createDataChannel('dubline', { ordered: true })); }
    catch (error) { pc?.close(); rtcUnavailable = true; stopP2pPeers(); syncP2pSetting(); announceHave(true); reject(error); return; }
    channel.binaryType = 'arraybuffer';
    const peer = { pc, channel, pending: [], remoteSet: false, key, sessionId: session?.activeSessionId, generation: p2pGeneration };
    peers.set(key, peer);

    const fail = (reason) => {
      clearTimeout(timer);
      closePeer(key, peer);
      reject(new Error(reason));
    };
    const timer = setTimeout(() => fail('timeout'), P2P_CONNECT_TIMEOUT);
    const cancel = () => closePeer(key, peer);
    abortSignal?.addEventListener('abort', cancel, { once: true });
    peer.cancel = () => { clearTimeout(timer); abortSignal?.removeEventListener('abort', cancel); reject(new Error('P2P connection closed')); };
    pc.onicecandidate = e => { if (e.candidate && currentP2pPeer(peer, key)) signal(peerId, { kind: 'candidate', from: 'leech', candidate: e.candidate }, peer.sessionId); };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) fail(pc.connectionState); };
    channel.onopen = () => {
      if (!currentP2pPeer(peer, key)) return fail('P2P disabled');
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', cancel);
      peer.downloadSignal = abortSignal;
      resolve(peer);
    };
    pc.createOffer()
      .then(offer => { if (!currentP2pPeer(peer, key)) throw new Error('P2P disabled'); return pc.setLocalDescription(offer); })
      .then(() => { if (currentP2pPeer(peer, key)) signal(peerId, { kind: 'offer', sdp: pc.localDescription }, peer.sessionId); })
      .catch(err => fail(err.message));
  });
}

function runPeer(peer, job) {
  if (!currentP2pPeer(peer, peer.key) || job.manifest.sessionId !== session?.activeSessionId) { closePeer(peer.key, peer); return Promise.resolve(); }
  return new Promise(resolve => {
    const channel = peer.channel;
    const inflight = new Map(); // index -> { timer, startedAt }
    let opened = false;
    let ended = false;

    const finish = () => {
      if (ended) return;
      ended = true;
      peer.downloadSignal?.removeEventListener('abort', finish);
      clearTimeout(openTimer);
      clearInterval(availabilityTimer);
      for (const [index, request] of inflight) {
        clearTimeout(request.timer);
        job.scheduler.finished(peer.key, 0, 0, true);
        if (!job.parts[index]) job.pending.unshift(index);
      }
      inflight.clear();
      closePeer(peer.key, peer);
      resolve();
    };

    const fill = () => {
      if (ended) return;
      if (job.cancelled || !currentP2pPeer(peer, peer.key)) return finish();
      while (opened && job.pending.length) {
        const next = job.scheduler.pick(peer.key, job.pending, video.currentTime || 0, session?.videoDuration);
        if (next === -1) break;
        const [index] = job.pending.splice(next, 1);
        job.scheduler.started(peer.key);
        inflight.set(index, { timer: setTimeout(finish, P2P_CHUNK_TIMEOUT), startedAt: performance.now() });
        try { channel.send(JSON.stringify({ t: 'get', i: index })); } catch { return finish(); }
      }
      if (opened && !inflight.size) finish();
    };

    channel.onmessage = e => {
      if (!currentP2pPeer(peer, peer.key)) return finish();
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
      job.p2pWireBytes += e.data.byteLength - 4;
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
      if (refreshing || ended || job.cancelled || !currentP2pPeer(peer, peer.key)) return;
      refreshing = true;
      try {
        const latest = (await findSeeders(job.url, peer.downloadSignal)).find(entry => entry.socketId === peer.key.slice(6) && entry.id === job.manifest.id);
        if (!ended && latest && job.scheduler.availability(peer.key, latest.ranges)) fill();
      } finally { refreshing = false; }
    }, 1500);
    peer.cancel = finish;
    peer.downloadSignal?.addEventListener('abort', finish, { once: true });
    if (peer.downloadSignal?.aborted) return finish();
    channel.send(JSON.stringify({ t: 'open', url: job.url, id: job.manifest.id }));
  });
}

async function runHttp(job) {
  while (!job.cancelled && job.pending.length) {
    job.pending = job.pending.filter(index => !job.parts[index]);
    if (!job.pending.length) break;
    job.pending.sort((a, b) => a - b);
    const run = [job.pending.shift()];
    while (run.length < HTTP_RUN && job.pending[0] === run[run.length - 1] + 1) run.push(job.pending.shift());
    const from = run[0] * P2P_CHUNK;
    const to = Math.min(job.size, (run[run.length - 1] + 1) * P2P_CHUNK) - 1;
    job.phase('http');
    await DublineTransferUtils.retryMedia(async () => {
      const requestAbort = new AbortController();
      const signal = AbortSignal.any([job.abort.signal, requestAbort.signal]);
      let timedOut = false;
      const timeout = () => { timedOut = true; requestAbort.abort(); };
      const timer = setTimeout(timeout, 15000);
      try {
        const response = await fetch(job.url, { headers: { Range: `bytes=${from}-${to}` }, signal });
        clearTimeout(timer); job.diagnostic.httpStatus = response.status;
        if (response.status === 200) job.stopPeers?.();
        job.diagnostic.range = response.status === 200 ? 'full' : response.status === 206 ? 'partial' : 'error';
        await DublineTransferUtils.readHttpMedia(response, { from, to, size: job.size, signal, onTimeout: timeout,
          onPart: (index, bytes) => job.accept(index, bytes, 'http'),
          onBytes: bytes => { job.httpBytes += bytes; job.received(); } });
      } catch (error) { if (timedOut && !job.cancelled) throw DublineTransferUtils.mediaError('timeout'); throw error; }
      finally { clearTimeout(timer); requestAbort.abort(); }
    }, job.abort.signal, error => { job.diagnostic.retries++; job.diagnostic.httpStatus = error.status ?? job.diagnostic.httpStatus; });
    job.progress();
  }
}

async function mediaManifest(url, abort, diagnostic) {
  diagnostic.phase = 'manifest'; const started = performance.now();
  try {
    return await DublineTransferUtils.retryMedia(async () => {
      try {
        const response = await fetch(`/api/media-manifest?${new URLSearchParams({ room: currentRoom, sessionId: session.activeSessionId, clientId, url })}`,
          { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) });
        diagnostic.httpStatus = response.status;
        if (!response.ok) { await response.body?.cancel(); throw DublineTransferUtils.mediaError('http', response.status); }
        return await response.json();
      } catch (error) {
        if (error.name === 'TimeoutError' && !abort.signal.aborted) throw DublineTransferUtils.mediaError('timeout');
        if (error instanceof SyntaxError) throw DublineTransferUtils.mediaError('manifest'); throw error;
      }
    }, abort.signal, () => diagnostic.retries++);
  } finally { diagnostic.manifestMs += performance.now() - started; }
}

async function sha256Hex(blob) {
  if (!mediaIntegritySupported()) return null;
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function downloadFile({ url, size, hash, type, direct }, onProgress, abort) {
  const sessionId = session.activeSessionId;
  const diagnostic = { phase: 'manifest', startedAt: performance.now(), manifestMs: 0, connectMs: 0, peersFailed: 0, peersCancelled: 0, peersConnected: 0, retries: 0, firstByteMs: null, fallback: p2pCapability(), httpStatus: null, range: null };
  if (mediaDownload) mediaDownload.diagnostic = diagnostic;
  const manifest = await mediaManifest(url, abort, diagnostic);
  if (abort.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (!DublineMediaCache.valid(manifest) || manifest.sessionId !== sessionId || manifest.url !== url || size && manifest.size !== size || hash && manifest.sha256 !== hash) throw DublineTransferUtils.mediaError('manifest');
  size = manifest.size; hash = manifest.sha256;
  await probeMediaIntegrity();
  heldManifests.set(url, manifest);
  if (!mediaPins.has(manifest.id)) mediaPins.set(manifest.id, DublineMediaCache.pin(manifest.id));
  const count = Math.ceil(size / P2P_CHUNK);
  const cached = mediaIntegritySupported() ? await DublineMediaCache.load(manifest) : [];
  if (abort.signal.aborted || session?.activeSessionId !== sessionId) throw new DOMException('Cancelled', 'AbortError');
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
    if (!mediaIntegritySupported()) return true; // HTTP transport only; never cached or advertised as verified.
    if (!await DublineMediaCache.verify(manifest, chunk, bytes)) return false;
    verified.add(chunk);
    if (await DublineMediaCache.put(manifest, chunk, bytes) && !job.cancelled && partialFiles.get(url) === partial) { partial.durable.add(chunk); partial.bytes.set(chunk, bytes); scheduleAnnounce(); }
    return true;
  };
  const job = {
    url, size, manifest,
    diagnostic,
    phase: phase => { diagnostic.phase = phase; diagnostic.phaseLabel = t('media.transfer.phase.' + phase); },
    received: () => { if (diagnostic.firstByteMs === null) diagnostic.firstByteMs = performance.now() - diagnostic.startedAt; },
    scheduler: new DublineTransferUtils.DownloadScheduler(manifest.chunks.length),
    parts,
    pending: Array.from({ length: count }, (_, i) => i).filter(index => !parts[index]),
    p2pBytes: 0, p2pWireBytes: 0, httpBytes: 0, peersUsed: 0, origins: [],
    cachedBytes,
    uniqueBytes: cachedBytes,
    abort,
    get cancelled() { return abort.signal.aborted; },
    progress: () => onProgress(job),
    accept: (index, bytes, origin) => {
      if (job.cancelled) return;
      if (job.parts[index]) return;
      job.received();
      job.parts[index] = bytes; job.uniqueBytes += bytes.byteLength;
      job.origins[index] = origin;
      if (origin === 'p2p') { job.p2pBytes += bytes.byteLength; if (diagnostic.phase !== 'http') job.phase('p2p'); }
      const chunk = Math.floor(index / 4), start = chunk * 4, end = Math.min(count, start + 4);
      if (!verified.has(chunk) && !verification.has(chunk) && Array.from({ length: end - start }, (_, offset) => job.parts[start + offset]).every(Boolean)) {
        const task = verifyChunk(chunk).catch(error => { if (!job.cancelled) job.verifyError = error; return false; }).finally(() => verification.delete(chunk)); verification.set(chunk, task);
      }
      onProgress(job);
      return verification.get(chunk);
    }
  };
  job.progress();
  if (direct && mediaIntegritySupported() && job.pending.length) { try {
    const result = await direct();
    if (result.blob.size !== size || await sha256Hex(result.blob) !== manifest.sha256) throw new Error('Direct media mismatch');
    verifiedHeldBlobs.set(result.blob, manifest.id);
    for (let chunk = 0; chunk < manifest.chunks.length; chunk++) {
      const bytes = new Uint8Array(await result.blob.slice(chunk * manifest.chunkSize, (chunk + 1) * manifest.chunkSize).arrayBuffer());
      await DublineMediaCache.put(manifest, chunk, bytes);
    }
    job.phase('ready'); onProgress({ ...job, uniqueBytes: size }); return { ...result, cachedBytes: 0, diagnostic: { ...diagnostic, verified: true, directBytes: result.directBytes, uniqueBytes: size } };
  } catch (error) { if (abort.signal.aborted) throw error; console.info('[Dubline] Voxalike direct unavailable; using peers / host.'); } }
  const peerAbort = new AbortController(), peerSignal = AbortSignal.any([abort.signal, peerAbort.signal]);
  job.stopPeers = () => peerAbort.abort();
  const peerWork = (async () => {
    if (!p2pAllowed() || !job.pending.length) return;
    job.phase('search');
    const seeders = (await findSeeders(url, peerSignal)).filter(peer => peer.id === manifest.id).slice(0, P2P_MAX_PEERS);
    if (!seeders.length) diagnostic.fallback = diagnostic.fallback || 'noPeers';
    await Promise.all(seeders.map(async peer => {
      const started = performance.now();
      try {
        if (diagnostic.phase !== 'http') job.phase('connecting');
        const connection = await connectToSeeder(peer.socketId, peerSignal);
        diagnostic.connectMs += performance.now() - started; diagnostic.peersConnected++;
        await runPeer(connection, job);
      } catch { diagnostic.connectMs += performance.now() - started; if (peerSignal.aborted) diagnostic.peersCancelled++; else diagnostic.peersFailed++; }
    }));
  })();
  try {
    if (p2pAllowed() && job.pending.length) await Promise.race([peerWork, DublineTransferUtils.delay(P2P_HTTP_GRACE, peerSignal).catch(() => {})]);
    if (job.pending.length) { diagnostic.fallback = diagnostic.fallback || p2pCapability() || 'peerGrace'; await runHttp(job); }
  } finally { peerAbort.abort(); await peerWork; }
  // Complete partial chunks from HTTP; repair corrupt peer chunks at most twice.
  for (let repair = 0; repair < 2; repair++) {
    await Promise.all(verification.values());
    const pending = new Set(job.pending);
    for (let chunk = 0; chunk < manifest.chunks.length; chunk++) {
      if (verified.has(chunk) || await verifyChunk(chunk)) continue;
      const first = chunk * 4, last = Math.min(count, first + 4);
      if (!Array.from({ length: last - first }, (_, index) => job.parts[first + index]).every(Boolean)) continue;
      diagnostic.invalidChunks = (diagnostic.invalidChunks || 0) + 1;
      for (let index = first; index < last; index++) {
        const bytes = job.parts[index]?.byteLength || 0;
        job.uniqueBytes -= bytes; if (job.origins[index] === 'p2p') job.p2pBytes -= bytes;
        job.parts[index] = null; job.origins[index] = null;
        if (!pending.has(index)) { pending.add(index); job.pending.push(index); }
      }
    }
    if (job.cancelled) throw new DOMException('Cancelled', 'AbortError');
    if (job.pending.length) await runHttp(job); else break;
  }
  job.phase('verification');
  await Promise.all(verification.values());
  if (job.verifyError) throw job.verifyError;
  if (mediaIntegritySupported()) for (let chunk = 0; chunk < manifest.chunks.length; chunk++) if (!await verifyChunk(chunk)) throw DublineTransferUtils.mediaError('integrity');
  if (job.cancelled) throw new Error('cancelled');

  const blob = new Blob(job.parts, { type });
  if (blob.size !== size) throw DublineTransferUtils.mediaError('size');
  if (hash) {
    const actual = await sha256Hex(blob);
    if (actual && actual !== hash) throw DublineTransferUtils.mediaError('integrity');
    if (actual) verifiedHeldBlobs.set(blob, manifest.id);
  }
  job.phase('ready'); diagnostic.verified = mediaIntegritySupported(); diagnostic.uniqueBytes = size; diagnostic.p2pBytes = job.p2pBytes; diagnostic.p2pWireBytes = job.p2pWireBytes; diagnostic.httpBytes = job.httpBytes; diagnostic.cachedBytes = cachedBytes;
  return { blob, p2pBytes: job.p2pBytes, httpBytes: job.httpBytes, cachedBytes, peers: job.peersUsed, diagnostic };
}

// ---------- Scene media loading ----------
function setHostSources(preservePlayback = false) {
  const url = preservePlayback ? session.videoUrl : mediaUrl(session.videoUrl);
  if (preservePlayback) swapVideoSource(url);
  else if (video.getAttribute('src') !== url) video.src = url;
  setMediaSource(backing, mediaUrl(session.backingUrl));
}

function cancelMediaDownload(manual = false) {
  if (mediaDownload) {
    mediaDownload.abort.abort();
    window.reportPlayerActivity?.('idle', 100, true);
  }
  mediaDownload = null;
  if (manual || sceneMediaState.status === 'loading') { sceneMediaState.status = 'cancelled'; p2pStatus = { state: 'cancelled' }; updateP2pStatus(); }
}

// Called when the room's scene video changes
async function loadSceneMedia(force = false) {
  if (!session?.loaded) { cancelMediaDownload(); sceneMediaState.status = 'not_started'; p2pStatus = null; updateP2pStatus(); return; }
  const videoKey = videoIdentity(session), desired = sceneMediaFiles(session);
  if (sceneMediaState.videoKey && sceneMediaState.videoKey !== videoKey) {
    cancelMediaDownload();
    if (video.getAttribute('src')) { video.pause(); video.removeAttribute('src'); video.load(); }
    setMediaSource(originalTrackAudio, null); setMediaSource(backing, null);
  }
  const audioKey = JSON.stringify(desired.slice(1).map(file => [file.url, file.size, file.hash]));
  if (!window.hasSceneMediaAccess()) {
    sceneMediaState.status = 'waiting_for_authorization'; p2pStatus = { state: 'authorization' }; updateP2pStatus(); return;
  }
  pruneSceneMedia(new Set(desired.map(file => file.url)));
  if (mediaDownload?.videoKey === videoKey) {
    mediaDownload.audioKey = audioKey;
    if (mediaDownload.asset?.role !== 'video' && mediaDownload.asset && !desired.some(file => file.url === mediaDownload.asset.url)) mediaDownload.asset.abort.abort();
    return;
  }
  if (!force && sceneMediaState.videoKey === videoKey && sceneMediaState.audioKey === audioKey && ['failed', 'cancelled'].includes(sceneMediaState.status)) return;
  const sameVideo = sceneMediaState.videoKey === videoKey;
  const retainedVideo = localMedia?.forVideoUrl === session.videoUrl && localMedia.videoHash === session.videoHash && localMedia.sessionId === session.activeSessionId;
  if (sameVideo && sceneMediaState.audioKey === audioKey && sceneMediaState.status === 'ready' && (retainedVideo || isOnServerMachine())) return;
  const watchingHost = !!((mediaDownload?.sessionId === session.activeSessionId && mediaDownload.videoUrl === session.videoUrl && mediaDownload.watchingHost) ||
    (localMedia?.forVideoUrl === session.videoUrl && localMedia.playbackFromHost));
  cancelMediaDownload();
  if (!sameVideo) {
    for (const release of mediaPins.values()) release(); mediaPins.clear();
    ++announceGeneration; clearTimeout(announceTimer); announceTimer = null;
    stopP2pPeers(); partialFiles.clear(); heldManifests.clear();
  }
  const wanted = new Set(desired.map(file => file.url));
  for (const [key, peer] of peers) if (peer.mediaUrl && !wanted.has(peer.mediaUrl)) closePeer(key, peer);
  p2pStatus = null;
  const current = session;
  const hasLocal = localMedia && localMedia.forVideoUrl === current.videoUrl && localMedia.source === 'disk';
  sceneMediaState = { status: 'loading', videoKey, audioKey, videoReady: !!retainedVideo, error: null, diagnostic: null, files: [] };

  // Already have it from disk, or we are on the server itself, or P2P is off: play as usual
  if (hasLocal || isOnServerMachine() || !current.videoSize || !current.videoUrl) {
    sceneMediaState.status = 'ready'; sceneMediaState.videoReady = true;
    setHostSources();
    updateP2pStatus();
    announceHave();
    window.reportPlayerActivity?.('idle', 100, true);
    window.updateMediaTransfer?.({ downloading: false }); return;
  }

  // Download it all (from players, the rest from the host), then play locally and share it ourselves
  const abort = new AbortController();
  const download = { abort, videoKey, audioKey, videoUrl: current.videoUrl, sessionId: current.activeSessionId, watchingHost };
  mediaDownload = download;
  window.reportPlayerActivity?.('downloading', 0, true);
  let files = desired;
  const descriptors = new Map(files.map(file => [file.url, file]));
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
          if (mediaDownload !== download || abort.signal.aborted) throw new Error('cancelled');
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
        } catch (error) { if (mediaDownload === download && !abort.signal.aborted) { p2pStatus = { state: 'fallback' }; updateP2pStatus(); } throw error; }
      };
    }
  }
  let totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
  let doneBytes = 0;
  const totals = { p2p: 0, http: 0, direct: 0 };
  const assets = retainedVideo ? Object.fromEntries(Object.entries(localMedia.assets || {}).filter(([url]) => wanted.has(url)).map(([url, asset]) => [url, asset.blob])) : {};
  if (retainedVideo) assets[current.videoUrl] = localMedia.videoBlob;
  let lastProgressUi = 0, lastTransferBytes = 0, lastTransferAt = performance.now();

  try {
    while (!abort.signal.aborted) {
      files = sceneMediaFiles(session).map(file => {
        if (!descriptors.has(file.url)) descriptors.set(file.url, file);
        return descriptors.get(file.url);
      });
      const file = files.find(file => !assets[file.url]);
      if (!file) break;
      doneBytes = files.reduce((sum, value) => sum + (assets[value.url]?.size || 0), 0);
      totalSize = files.reduce((sum, value) => sum + (assets[value.url]?.size || value.size || 0), 0);
      const assetAbort = new AbortController(), cancel = () => assetAbort.abort();
      abort.signal.addEventListener('abort', cancel, { once: true });
      download.asset = { url: file.url, role: file.role, abort: assetAbort };
      let result;
      try { result = await downloadFile(file, job => {
        if (mediaDownload !== download) return;
        file.size = job.size; download.diagnostic = { ...job.diagnostic, role: file.role, uniqueBytes: job.uniqueBytes, p2pBytes: job.p2pBytes, httpBytes: job.httpBytes, cachedBytes: job.cachedBytes };
        totalSize = files.reduce((sum, value) => sum + (assets[value.url]?.size || value.size || 0), 0);
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
        window.updateMediaTransfer?.({ downloading: true, videoReady: sceneMediaState.videoReady, pct: p2pStatus.pct, buckets, downloadRate });
        updateP2pStatus();
        window.reportPlayerActivity?.('downloading', p2pStatus.pct);
      }, assetAbort); }
      catch (error) {
        if (assetAbort.signal.aborted && !abort.signal.aborted && !sceneMediaFiles(session).some(value => value.url === file.url)) continue;
        throw error;
      } finally { abort.signal.removeEventListener('abort', cancel); download.asset = null; }
      if (mediaDownload !== download || abort.signal.aborted || session.activeSessionId !== download.sessionId) return;
      assets[file.url] = result.blob;
      doneBytes += file.size;
      totals.direct += result.directBytes || 0;
      totals.p2p += result.p2pBytes;
      totals.http += result.httpBytes;
      sceneMediaState.diagnostic = { ...result.diagnostic, role: file.role };
      sceneMediaState.files = [...sceneMediaState.files.filter(value => value.role !== file.role), sceneMediaState.diagnostic].slice(-3);
      socket.emit('p2p_report', { sessionId: download.sessionId, url: file.url, p2pBytes: result.p2pBytes, httpBytes: result.httpBytes, peers: result.peers });
      if (assets[current.videoUrl]) {
        const wanted = new Set(sceneMediaFiles(session).map(value => value.url));
        for (const url of Object.keys(assets)) if (!wanted.has(url)) delete assets[url];
        setLocalMedia({ video: assets[current.videoUrl], backing: assets[session.backingUrl] || null, assets, source: 'p2p', videoSourceUrl: current.videoUrl,
          backingSourceUrl: session.backingUrl, activatePlayback: !download.watchingHost, cancelDownload: false });
        partialFiles.delete(file.url); sceneMediaState.videoReady = true;
        applyAudioTracks();
      }
    }
    if (mediaDownload !== download || session.videoUrl !== download.videoUrl || session.activeSessionId !== download.sessionId) return;
    mediaDownload = null;
    const wanted = new Set(sceneMediaFiles(session).map(value => value.url));
    for (const url of Object.keys(assets)) if (!wanted.has(url)) delete assets[url];
    setLocalMedia({ video: assets[current.videoUrl], backing: assets[session.backingUrl] || null, assets, source: 'p2p', videoSourceUrl: current.videoUrl,
      backingSourceUrl: session.backingUrl, activatePlayback: !download.watchingHost, cancelDownload: false });
    applyAudioTracks(); sceneMediaState.status = 'ready'; sceneMediaState.audioKey = download.audioKey;
    window.updateMediaTransfer?.({ downloading: false, fallback: false, pct: 100, buckets: new Array(96).fill(100) });
    p2pStatus = { state: 'done', direct: totals.direct, p2p: totals.p2p, http: totals.http, size: totalSize };
  } catch (err) {
    if (mediaDownload !== download) return; // cancelled: already loading something else
    mediaDownload = null;
    console.warn('[Dubline] Could not preload the video, watching from the host:', err.message);
    sceneMediaState.status = abort.signal.aborted ? 'cancelled' : 'failed';
    sceneMediaState.error = { code: err.code || (err instanceof TypeError ? 'network' : 'integrity'), status: err.status ?? null };
    sceneMediaState.diagnostic = download.diagnostic;
    p2pStatus = { state: 'failed', error: sceneMediaState.error };
    window.updateMediaTransfer?.({ downloading: false, videoReady: sceneMediaState.videoReady, fallback: !sceneMediaState.videoReady });
    if (!sceneMediaState.videoReady && ![403, 409].includes(err.status)) setHostSources(download.watchingHost);
  }
  updateP2pStatus();
  window.reportPlayerActivity?.('idle', 100, true);
}

window.watchFromHostNow = function() {
  if (!session?.loaded) return;
  if (mediaDownload) mediaDownload.watchingHost = true;
  if (localMedia?.forVideoUrl === session.videoUrl) localMedia.playbackFromHost = true;
  setHostSources(true);
  applyAudioTracks();
  updateP2pStatus();
};
window.isWatchingHostMedia = () => !!(mediaDownload?.watchingHost || localMedia?.playbackFromHost);

function updateP2pStatus() {
  const lines = [];
  let pct = null;
  let showWatchNow = false;

  if (p2pStatus?.state === 'authorization') lines.push(t('media.transfer.authorization'));
  else if (p2pStatus?.state === 'cancelled') lines.push(t('media.transfer.state.cancelled'));
  else if (p2pStatus?.state === 'direct' || p2pStatus?.state === 'fallback') { lines.push(t(p2pStatus.state === 'direct' ? 'workshop.direct' : 'workshop.fallback')); }
  else if (p2pStatus && p2pStatus.state === 'fetching') {
    lines.push(t('p2p.fetching', { pct: p2pStatus.pct, p2p: formatSize(p2pStatus.p2p) || '0', http: formatSize(p2pStatus.http) || '0' }));
    pct = p2pStatus.pct;
    showWatchNow = !mediaDownload?.watchingHost;
  } else if (p2pStatus && p2pStatus.state === 'done') {
    const share = p2pStatus.size ? Math.round((p2pStatus.p2p / p2pStatus.size) * 100) : 0;
    lines.push(t('p2p.done', { size: formatSize(p2pStatus.size), pct: share }));
  } else if (p2pStatus && p2pStatus.state === 'failed') {
    const status = p2pStatus.error?.status, code = p2pStatus.error?.code;
    const key = [403, 404, 409, 416, 429].includes(status) ? String(status) : status >= 500 ? 'server' : status && code === 'http' ? 'http' : ['range', 'truncated', 'size', 'integrity', 'manifest', 'timeout'].includes(code) ? code : 'network';
    lines.push(t('media.transfer.error.' + key, { status }));
  }
  if (uploadedBytes > 0) lines.push(t('p2p.uploaded', { size: formatSize(uploadedBytes) }));

  p2pBox.style.display = lines.length ? 'flex' : 'none';
  p2pStatusText.innerHTML = lines.map(esc).join('<br>')
    + (showWatchNow ? `<br><button class="btn-outline" style="margin-top:6px;padding:3px 10px;font-size:11px;" onclick="watchFromHostNow()">${t('p2p.watchNow')}</button>` : '')
    + (p2pStatus?.state === 'failed' ? `<br><button class="btn-outline" onclick="retrySceneMedia()">${t('media.transfer.retry')}</button>` : '');
  p2pProgressBar.parentElement.style.display = pct === null ? 'none' : '';
  if (pct !== null) p2pProgressBar.style.width = `${pct}%`;
}

socket.on('connect', () => announceHave(true));
window.addEventListener('dubline-language-changed', () => { syncP2pSetting(); updateP2pStatus(); });
setInterval(() => { if (socket.connected) announceHave(true); }, 10000);
