(() => {
  const direct = new Map(), samples = new Map(), receiveRates = new Map(), earlyCandidates = new Map();
  let actors = new Map(), scene = null, sequence = 0, hz = 15, latest = null, timer = null, frame = null, subscription = '';
  let jumpExpiry = null;
  let visible = true; try { visible = localStorage.getItem('dubline_cursors') !== '0'; } catch { /* private profile */ }
  const layer = document.createElement('div'); layer.id = 'collaboratorCursors'; layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:29;'; document.body.append(layer);
  const personal = document.createElement('label'); personal.className = 'setting-card';
  personal.innerHTML = '<div class="setting-card-row"><span class="setting-label" data-i18n="cursor.show"></span><label class="switch-ui"><input id="settingsCollaboratorCursors" type="checkbox"><span class="switch-slider"></span></label></div>';
  const toggle = personal.querySelector('input'); toggle.checked = visible; window.addSettingsCard('user', 'interface', personal); toggle.setAttribute('aria-label', t('cursor.show')); window.addEventListener('dubline-language-changed', () => toggle.setAttribute('aria-label', t('cursor.show')));
  const shared = document.createElement('label'); shared.className = 'setting-card';
  shared.innerHTML = '<span data-i18n="cursor.hz"></span><input class="text-input" type="number" min="5" max="30" step="1" value="15">';
  const rate = shared.querySelector('input'); window.addSettingsCard('player', 'room', shared); i18n.apply();
  function close(id) { const peer = direct.get(id); if (!peer) return; direct.delete(id); clearTimeout(peer.timer); try { peer.channel?.close(); peer.pc.close(); } catch { /* closed */ } }
  function clear() { for (const id of [...direct.keys()]) close(id); samples.clear(); receiveRates.clear(); earlyCandidates.clear(); layer.replaceChildren(); latest = null; subscription = ''; clearTimeout(jumpExpiry); window.refreshCollaboratorJumpButtons?.(); }
  function rowFor(packet) {
    if (packet.rowType === 'role') return [...document.querySelectorAll('.track-row[data-character]')].find(row => row.dataset.character === packet.rowKey);
    if (packet.rowType === 'audio') return document.querySelector(`.studio-audio-row[data-audio-channel="${packet.rowKey}"]`);
    return timeline.querySelector('.ruler-row');
  }
  function receive(id, data) {
    if (!visible || !actors.has(id) || id === socket.id || session?.mode !== 'edit') return;
    const packet = DublineCursorModel.normalize(data, session.activeSessionId, session.trackOrder);
    if (!packet) return;
    const now = performance.now(), rate = receiveRates.get(id) || { at: now, tokens: 4 };
    rate.tokens = Math.min(4, rate.tokens + (now - rate.at) * Math.min(30, hz) / 1000); rate.at = now;
    receiveRates.set(id, rate);
    if (packet.active && rate.tokens < 1) return;
    if (packet.active) rate.tokens--;
    const previous = samples.get(id); if (previous && packet.seq <= previous.packet.seq) return;
    if (!packet.active) { previous?.element?.remove(); samples.set(id, { packet, at: performance.now(), element: previous?.element }); refreshCollaboratorJumpButtons(); return; }
    let element = previous?.element;
    if (!element || !element.isConnected) {
      element = document.createElement('span'); element.className = 'collaborator-cursor';
      element.style.cssText = 'position:absolute;font-size:11px;padding:2px 4px;border-radius:3px;white-space:nowrap;'; layer.append(element);
    }
    element.style.background = playerColor(actors.get(id).nick); element.textContent = '↖ ' + actors.get(id).nick;
    samples.set(id, { packet, at: performance.now(), element, time: previous?.time ?? packet.time, relativeY: previous?.relativeY ?? packet.relativeY });
    refreshCollaboratorJumpButtons();
    paint();
  }
  function paint() {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null; if (document.hidden) return;
      const bounds = timelineContainer.getBoundingClientRect(), origin = timeline.getBoundingClientRect(); let animating = false;
      for (const sample of samples.values()) {
        const row = rowFor(sample.packet), rect = row?.getBoundingClientRect();
        if (!sample.element) continue;
        const hidden = !visible || session?.mode !== 'edit' || !sample.packet.active || performance.now() - sample.at > 1600 || !rect?.height || getComputedStyle(row).display === 'none';
        sample.element.hidden = hidden; if (hidden) continue;
        sample.time += (sample.packet.time - sample.time) * .35; sample.relativeY += (sample.packet.relativeY - sample.relativeY) * .35;
        const x = origin.left + labelWidth + sample.time * pxPerSec, y = rect.top + sample.relativeY * rect.height;
        sample.element.hidden = x < bounds.left + labelWidth || x > bounds.right || y < bounds.top || y > bounds.bottom;
        sample.element.style.transform = `translate(${x}px,${y}px)`; animating = true;
      }
      if (animating) paint();
    });
  }
  function signal(id, data) { if (scene === session?.activeSessionId) socket.emit('cursor_signal', { to: id, sessionId: scene, signal: data }); }
  function attach(peer, channel, id) {
    if (channel.label !== 'dubline-presence') { channel.close(); return; }
    peer.channel = window.DublineNetwork.channel(channel);
    channel.onopen = () => clearTimeout(peer.timer);
    channel.onclose = () => close(id);
    channel.onmessage = event => { if (typeof event.data !== 'string' || event.data.length > 2048) return; try { receive(id, JSON.parse(event.data)); } catch { /* malformed volatile sample */ } };
  }
  function create(id, offer) {
    if (direct.has(id) || direct.size >= 8 || typeof RTCPeerConnection === 'undefined') return null;
    const early = earlyCandidates.get(id); earlyCandidates.delete(id);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS }), peer = { pc, candidates: early && early.at > performance.now() - 6000 ? early.candidates : [], remote: false, sessionId: scene };
    direct.set(id, peer); peer.timer = setTimeout(() => close(id), 6000);
    pc.onicecandidate = event => { if (event.candidate && peer.sessionId === scene) signal(id, { kind: 'candidate', candidate: event.candidate }); };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) close(id); };
    pc.ondatachannel = event => attach(peer, event.channel, id);
    if (offer) {
      attach(peer, pc.createDataChannel('dubline-presence', { ordered: false, maxRetransmits: 0 }), id);
      pc.createOffer().then(description => pc.setLocalDescription(description)).then(() => signal(id, { kind: 'offer', sdp: pc.localDescription })).catch(() => close(id));
    }
    return peer;
  }
  socket.on('cursor_signal', async data => {
    if (data.sessionId !== scene || !actors.has(data.actorId) || session?.mode !== 'edit') return;
    const id = data.actorId, message = data.signal;
    try {
      const peer = direct.get(id) || (message.kind === 'offer' ? create(id, false) : null);
      if (!peer) {
        if (message.kind === 'candidate' && earlyCandidates.size < 8) {
          const early = earlyCandidates.get(id) || { at: performance.now(), candidates: [] };
          if (early.candidates.length < 64) early.candidates.push(message.candidate);
          earlyCandidates.set(id, early);
        }
        return;
      }
      if (message.kind === 'candidate') {
        if (peer.remote) await peer.pc.addIceCandidate(message.candidate); else if (peer.candidates.length < 64) peer.candidates.push(message.candidate);
      } else {
        await peer.pc.setRemoteDescription(message.sdp); peer.remote = true;
        for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate).catch(() => {});
        if (message.kind === 'offer') { await peer.pc.setLocalDescription(await peer.pc.createAnswer()); signal(id, { kind: 'answer', sdp: peer.pc.localDescription }); }
      }
    } catch { close(id); }
  });
  function connectPeers() {
    if (session?.mode !== 'edit' || session.singlePlayer) return;
    for (const id of actors.keys()) if (id > socket.id && direct.size < 8) create(id, true);
  }
  socket.on('cursor_roster', data => {
    if (!Array.isArray(data?.actors) || data.sessionId !== session?.activeSessionId) return;
    if (scene !== data.sessionId) { clear(); scene = data.sessionId; }
    actors = new Map(data.actors.filter(actor => actor.actorId !== socket.id).map(actor => [actor.actorId, actor]));
    for (const id of [...direct.keys()]) if (!actors.has(id)) close(id);
    for (const [id, sample] of samples) if (!actors.has(id)) { sample.element?.remove(); samples.delete(id); receiveRates.delete(id); earlyCandidates.delete(id); }
    hz = Math.max(5, Math.min(30, Number(data.hz) || 15)); rate.value = hz; rate.disabled = !amHost(); connectPeers();
    refreshCollaboratorJumpButtons();
  });
  socket.on('cursor_packet', data => receive(data.actorId, data.packet));
  function publish(packet) {
    if (!socket.connected || session?.mode !== 'edit' || session.singlePlayer) return;
    const data = { ...packet, sessionId: session.activeSessionId, seq: ++sequence }, text = JSON.stringify(data), fallback = [];
    for (const [id, actor] of actors) if (actor.receive) {
      const channel = direct.get(id)?.channel;
      if (channel?.readyState === 'open') { if (channel.bufferedAmount < 32768) try { channel.send(text); } catch { close(id); fallback.push(id); } }
      else fallback.push(id);
    }
    if (fallback.length) socket.volatile.emit('cursor_fallback', { to: fallback.slice(0, 64), packet: data });
  }
  function flush() { timer = null; if (latest) { publish(latest); latest = null; } }
  timelineContainer.addEventListener('pointermove', event => {
    if (session?.mode !== 'edit' || document.querySelector('.modal-overlay[style*="display: flex"]')) return;
    const row = event.target.closest('.track-row[data-character],.studio-audio-row,.ruler-row'); if (!row) { hide(); return; }
    const rect = row.getBoundingClientRect(), origin = timeline.getBoundingClientRect();
    if (event.clientX < timelineContainer.getBoundingClientRect().left + labelWidth) { hide(); return; }
    latest = { active: true, time: Math.max(0, Math.min(43200, (event.clientX - origin.left - labelWidth) / pxPerSec)), rowType: row.dataset.character ? 'role' : row.dataset.audioChannel ? 'audio' : 'ruler', rowKey: row.dataset.character || row.dataset.audioChannel || 'ruler', relativeY: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))) };
    if (timer === null) timer = setTimeout(flush, 1000 / hz);
  });
  const hide = () => { clearTimeout(timer); timer = null; latest = null; publish({ active: false }); };
  timelineContainer.addEventListener('pointerleave', hide); window.addEventListener('blur', hide);
  document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); else paint(); });
  timelineContainer.addEventListener('scroll', paint, { passive: true }); window.addEventListener('resize', paint);
  toggle.onchange = () => { visible = toggle.checked; try { localStorage.setItem('dubline_cursors', visible ? '1' : '0'); } catch { /* private profile */ } subscription = ''; subscribe(); paint(); };
  rate.onchange = () => { const value = Number(rate.value); if (amHost() && Number.isInteger(value) && value >= 5 && value <= 30) socket.emit('cursor_set_hz', { hz: value }); else rate.value = hz; };
  function subscribe() {
    if (!socket.connected || !myName || !session) return;
    const key = JSON.stringify([socket.id, session.activeSessionId, visible]); if (key === subscription) return;
    subscription = key; socket.emit('cursor_subscribe', { enabled: visible });
  }
  socket.on('session_updated', () => { if (scene !== session?.activeSessionId || session?.mode !== 'edit') { hide(); clear(); scene = session?.activeSessionId; } subscribe(); rate.disabled = !amHost(); });
  socket.on('room_users_updated', subscribe); socket.on('connect', subscribe); socket.on('disconnect', () => { clear(); actors.clear(); });
  setInterval(connectPeers, 10000); subscribe();
  function jumpSample(nick) {
    if (!socket.connected || session?.mode !== 'edit' || session.singlePlayer || scene !== session.activeSessionId) return null;
    for (const [id, actor] of actors) {
      const sample = samples.get(id);
      if (actor.nick === nick && sample?.packet.active && sample.packet.sessionId === scene && performance.now() - sample.at < 1600 && rowFor(sample.packet)?.getClientRects().length) return sample;
    }
    return null;
  }
  window.canJumpToCollaborator = nick => !!jumpSample(nick);
  window.refreshCollaboratorJumpButtons = function() {
    clearTimeout(jumpExpiry);
    for (const button of document.querySelectorAll('[data-jump-collaborator]')) {
      const available = !!jumpSample(button.dataset.jumpCollaborator);
      if (button.disabled === available) button.disabled = !available;
      const title = t(available ? 'cursor.jump' : 'cursor.unavailable');
      if (button.title !== title) { button.title = title; button.setAttribute('aria-description', title); }
    }
    const expires = [...samples.values()].filter(sample => sample.packet.active && sample.at + 1600 > performance.now()).map(sample => sample.at + 1600);
    if (expires.length) jumpExpiry = setTimeout(refreshCollaboratorJumpButtons, Math.max(16, Math.min(...expires) - performance.now() + 1));
  };
  window.jumpToCollaborator = nick => {
    const sample = jumpSample(nick);
    if (!sample) { refreshCollaboratorJumpButtons(); return false; }
    timelineContainer.scrollLeft = Math.max(0, sample.packet.time * pxPerSec - (timelineContainer.clientWidth - labelWidth) / 2);
    rowFor(sample.packet)?.scrollIntoView({ block: 'nearest' });
    return true;
  };
  window.DublineCursorPresence = { stats: () => ({ connections: direct.size, open: [...direct.values()].filter(peer => peer.channel?.readyState === 'open').length, actors: actors.size, hz }), samples, publish };
})();
