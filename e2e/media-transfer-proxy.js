// Test-only forwarding to the same room, with controlled response faults and rate.
const http = require('node:http'), https = require('node:https'), net = require('node:net');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
async function mediaProxy(targetPort, { tls = false, rule = () => ({}) } = {}) {
  const sockets = new Set(), timers = new Set(); let certificateDir;
  const stats = { requests: 0, bytes: 0, videoRequests: 0, videoBytes: 0, managedVideoRequests: 0, managedVideoBytes: 0, completed: 0, aborted: 0, firstByteAt: null, observations: [] };
  const later = (callback, ms) => { const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms); timers.add(timer); return timer; };
  const handle = (req, res) => {
    const media = /^bytes=\d+-\d+$/.test(req.headers.range || '') && (!req.headers['sec-fetch-dest'] || req.headers['sec-fetch-dest'] === 'empty');
    const isVideo = new URL(req.url, 'http://host').pathname.endsWith('dub_video.mp4');
    const observation = { kind: isVideo ? 'video' : 'audio', destination: req.headers['sec-fetch-dest'], range: req.headers.range || '', at: performance.now(), bytes: 0 };
    if (isVideo) { stats.videoRequests++; if (media) stats.managedVideoRequests++; }
    if (media) { stats.requests++; stats.observations.push(observation); if (stats.observations.length > 2048) stats.observations.shift(); }
    const plan = rule(req, observation, stats) || {};
    if (plan.status) { res.writeHead(plan.status); res.end(); return; }
    const headers = { ...req.headers, host: `127.0.0.1:${targetPort}` };
    if (plan.ignoreRange) delete headers.range;
    let response, timer, complete = false;
    const upstream = http.request({ hostname: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers }, incoming => {
      response = incoming; incoming.pause(); const outHeaders = { ...incoming.headers };
      // Deliver the complete planned prefix before closing an intentionally
      // short body. A timed socket.destroy() can discard queued TLS records,
      // making the observed prefix depend on runner/network scheduling.
      if (plan.truncateAfter) outHeaders.connection = 'close';
      if (plan.badRange && incoming.statusCode === 206) outHeaders['content-range'] = 'bytes 9-10/11';
      const start = () => { if (!res.destroyed) { res.writeHead(incoming.statusCode, outHeaders); incoming.resume(); } };
      if (plan.delayHeaders) timer = later(start, plan.delayHeaders); else start();
      incoming.on('data', bytes => {
        incoming.pause();
        if (res.destroyed) return;
        if (plan.truncateAfter && observation.bytes + bytes.length >= plan.truncateAfter) {
          const piece = bytes.subarray(0, Math.max(0, plan.truncateAfter - observation.bytes));
          res.write(piece); observation.bytes += piece.length; if (media) stats.bytes += piece.length;
          if (isVideo) { stats.videoBytes += piece.length; if (media) stats.managedVideoBytes += piece.length; }
          // The fault is triggered after the consumer has read the planned
          // prefix. HTTP/TLS flushing alone cannot guarantee that: a network
          // error may discard bytes still queued inside the browser's stream.
          Promise.resolve(plan.beforeTruncate?.()).then(() => res.end(), () => res.destroy());
          return;
        }
        observation.bytes += bytes.length;
        if (media) { stats.bytes += bytes.length; stats.firstByteAt ??= performance.now(); }
        if (isVideo) { stats.videoBytes += bytes.length; if (media) stats.managedVideoBytes += bytes.length; }
        const flowing = res.write(bytes);
        const resume = () => { timer = later(() => incoming.resume(), plan.rate ? bytes.length / plan.rate * 1000 : 0); };
        if (flowing) resume(); else res.once('drain', resume);
      });
      incoming.on('end', () => { complete = true; if (media) stats.completed++; res.end(); });
      incoming.on('error', () => res.destroy());
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
    res.on('close', () => {
      if (timer) { clearTimeout(timer); timers.delete(timer); }
      upstream.destroy(); response?.destroy(); if (media && !complete) stats.aborted++;
    });
  };
  let server, spki;
  if (tls) {
    certificateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-media-proxy-'));
    const key = path.join(certificateDir, 'key.pem'), cert = path.join(certificateDir, 'cert.pem');
    const openssl = ['C:/Program Files/Git/usr/bin/openssl.exe', '/usr/bin/openssl'].find(file => fs.existsSync(file)) || 'openssl';
    const result = spawnSync(openssl, ['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=dubline.test', '-keyout', key, '-out', cert], { windowsHide: true });
    if (result.status !== 0) throw Error('OpenSSL is required for the local HTTPS media test');
    const certificate = fs.readFileSync(cert), publicKey = new crypto.X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' });
    spki = crypto.createHash('sha256').update(publicKey).digest('base64');
    // Bound speculative Chrome connections that never send a TLS ClientHello.
    server = https.createServer({ key: fs.readFileSync(key), cert: certificate, handshakeTimeout: 5000 }, handle);
  } else server = http.createServer(handle);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('secureConnection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(targetPort, '127.0.0.1'); sockets.add(upstream);
    upstream.on('connect', () => {
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    upstream.on('close', () => { sockets.delete(upstream); socket.destroy(); }); socket.on('close', () => upstream.destroy());
  });
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  const port = server.address().port;
  return { port, spki, stats, url: room => `${tls ? 'https' : 'http'}://dubline.test:${port}/?room=${encodeURIComponent(room)}`,
    async close() {
      for (const timer of timers) clearTimeout(timer); timers.clear();
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections(); server.closeIdleConnections();
      await new Promise(resolve => server.close(resolve));
      if (certificateDir) {
        if (path.dirname(path.resolve(certificateDir)) !== path.resolve(os.tmpdir()) || !path.basename(certificateDir).startsWith('dubline-media-proxy-')) throw Error('Unsafe test certificate cleanup');
        fs.rmSync(certificateDir, { recursive: true, force: true });
      }
    }
  };
}
module.exports = { mediaProxy };
