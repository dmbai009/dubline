(() => {
  const metrics = DublineNetworkMetrics, meter = metrics.meter(), latency = metrics.latency(), reports = new Map();
  let timer = null, probeAt = -Infinity, probing = false, generation = 0, engine = null, detachEngine = () => {}, rates = { up: 0, down: 0 };
  meter.sample(performance.now());
  const add = (direction, data) => meter.add(direction, metrics.bytes(data));
  function attachEngine() {
    detachEngine(); engine = socket.io.engine;
    if (!engine) return;
    const received = packet => add('down', packet.data);
    // Engine.IO emits flush only after handing this batch to the transport.
    // ResourceTiming explicitly excludes /socket.io/ to avoid counting polling twice.
    const sent = () => engine.writeBuffer.slice(0, engine._prevBufferLen).forEach(packet => add('up', packet.data));
    engine.on('packet', received); engine.on('flush', sent);
    const current = engine;
    detachEngine = () => { current.off('packet', received); current.off('flush', sent); };
  }
  function networkHtml(online) {
    return `<div class="player-network" ${!online || session?.singlePlayer ? 'hidden' : ''}><button type="button" class="network-ping network-unknown" data-network-tooltip aria-label="${esc(t('network.title'))}"><span class="network-dot" aria-hidden="true">●</span> <span data-rtt>—</span><span class="network-unit"> ms</span></button><span class="network-rates"><span data-up>↑ —</span><span data-down>↓ —</span></span></div>`;
  }
  function description(report) {
    return `${t('network.title')}\n${t('network.ping')}: ${report?.rtt == null ? '—' : report.rtt + ' ms'}\n${t('network.up')}: ${metrics.rate(report?.up)}\n${t('network.down')}: ${metrics.rate(report?.down)}\n${t('network.' + metrics.category(report?.rtt))}\n${t('network.scope')}`;
  }
  function refresh() {
    const now = performance.now();
    for (const [nick, report] of reports) if (now - report.received >= metrics.TTL || !lastOnlineUsers.includes(nick)) reports.delete(nick);
    for (const card of lobbyList.querySelectorAll('.player-card')) {
      const nick = card.dataset.lobbyKey.slice(7), block = card.querySelector('.player-network');
      if (!block) continue;
      block.hidden = card.classList.contains('offline') || !!session?.singlePlayer;
      const report = socket.connected ? reports.get(nick) : null, button = block.querySelector('.network-ping');
      button.className = 'network-ping network-' + metrics.category(report?.rtt);
      block.querySelector('[data-rtt]').textContent = report?.rtt == null ? '—' : String(report.rtt);
      block.querySelector('[data-up]').textContent = '↑ ' + metrics.rate(report?.up);
      block.querySelector('[data-down]').textContent = '↓ ' + metrics.rate(report?.down);
      const text = description(report); button.dataset.tooltip = text;
      button.setAttribute('aria-label', `${nick}: ${t('network.title')}`);
      button.setAttribute('aria-describedby', 'dublineTooltip');
    }
    window.refreshDublineTooltip?.();
  }
  function probe(now) {
    if (probing || now - probeAt < 5000) return;
    probing = true; probeAt = now; const epoch = generation;
    socket.timeout(4000).emit('time_sync', Date.now(), error => {
      if (epoch !== generation) return;
      probing = false; if (!error) latency.add(performance.now() - now, performance.now());
    });
  }
  function tick() {
    const now = performance.now(); rates = meter.sample(now);
    if (socket.connected && myName && session && !session.singlePlayer && lastOnlineUsers.includes(myName)) {
      probe(now); const report = { rtt: latency.get(now), ...rates };
      reports.set(myName, { ...report, received: now }); socket.volatile.emit('network_telemetry_update', report);
    }
    refresh();
  }
  function stop() { clearInterval(timer); timer = null; generation++; probing = false; probeAt = -Infinity; latency.reset(); reports.clear(); detachEngine(); refresh(); }
  socket.on('connect', () => { stop(); attachEngine(); timer = setInterval(tick, 1000); });
  socket.on('disconnect', stop);
  socket.on('network_telemetry', data => {
    if (!socket.connected || data?.roomId !== currentRoom || !Array.isArray(data?.players)) return;
    const now = performance.now();
    for (const item of data.players) if (lastOnlineUsers.includes(item.nick) && item.nick !== myName && Number.isFinite(item.age) && item.age < metrics.TTL) reports.set(item.nick, { ...item, received: now - item.age });
    refresh();
  });
  window.addEventListener('dubline-language-changed', refresh);
  window.addEventListener('pagehide', stop);
  // Browser-managed downloads/native IO, opaque cross-origin responses and wire
  // protocol overhead are not observable. Cached responses report zero transfer.
  let observer;
  if (window.PerformanceObserver) {
    try {
      observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) if (entry.initiatorType !== 'xmlhttprequest' && !new URL(entry.name).pathname.startsWith('/socket.io/')) meter.add('down', entry.transferSize || 0);
      });
      observer.observe({ type: 'resource', buffered: true });
      window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
    } catch { /* HTTP timing is optional; Socket.IO, XHR and P2P still work. */ }
  }
  // Count real XHR progress. This replaces fetch only for app-managed uploads;
  // ResourceTiming excludes XHR, so download bytes are counted exactly once.
  function upload(url, options = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); let up = 0, down = 0;
      xhr.open(options.method || 'POST', url); xhr.responseType = 'blob';
      for (const [key, value] of Object.entries(options.headers || {})) xhr.setRequestHeader(key, value);
      xhr.upload.onprogress = event => { meter.add('up', event.loaded - up); up = event.loaded; };
      xhr.onprogress = event => { meter.add('down', event.loaded - down); down = event.loaded; };
      const abort = () => xhr.abort();
      xhr.onloadend = () => options.signal?.removeEventListener('abort', abort);
      xhr.onerror = () => reject(new TypeError('Network request failed'));
      xhr.onabort = () => reject(new DOMException('Request aborted', 'AbortError'));
      xhr.onload = () => resolve(new Response([204, 205, 304].includes(xhr.status) ? null : xhr.response, { status: xhr.status, statusText: xhr.statusText, headers: Object.fromEntries(xhr.getAllResponseHeaders().trim().split(/[\r\n]+/).filter(Boolean).map(line => { const at = line.indexOf(':'); return [line.slice(0, at), line.slice(at + 1).trim()]; })) }));
      if (options.signal?.aborted) return reject(new DOMException('Request aborted', 'AbortError'));
      options.signal?.addEventListener('abort', abort, { once: true }); xhr.send(options.body);
    });
  }
  function channel(channel) {
    if (channel.datasetTelemetry) return channel;
    channel.datasetTelemetry = true;
    const send = channel.send.bind(channel);
    channel.send = data => { send(data); add('up', data); };
    channel.addEventListener('message', event => add('down', event.data));
    return channel;
  }
  window.DublineNetwork = { html: networkHtml, refresh, rtt: () => latency.get(performance.now()), upload, channel,
    stats: () => ({ rtt: latency.get(performance.now()), ...rates, bytes: meter.totals(), scope: 'observed' }) };
})();
