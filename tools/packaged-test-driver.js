// Test-only CDP access to actual packaged executables; no production debug IPC.
const { spawn } = require('node:child_process');
const net = require('node:net');
const { once } = require('node:events');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const result = server.address().port; await new Promise(resolve => server.close(resolve)); return result;
}
class Inspector {
  constructor(socket) {
    this.socket = socket; this.serial = 0; this.pending = new Map(); this.events = new Map();
    socket.addEventListener('message', event => {
      const value = JSON.parse(event.data);
      if (value.id) {
        const request = this.pending.get(value.id); if (!request) return;
        this.pending.delete(value.id); clearTimeout(request.timer);
        value.error ? request.reject(Error(JSON.stringify(value.error))) : request.resolve(value.result);
      } else if (value.method) {
        const waiting = this.events.get(value.method); this.events.delete(value.method); waiting?.forEach(resolve => resolve(value.params));
      }
    });
  }
  call(method, params = {}) {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`Inspector timed out: ${method}`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  event(name) { return new Promise(resolve => { const entries = this.events.get(name) || []; entries.push(resolve); this.events.set(name, entries); }); }
  async evaluate(expression) {
    const scoped = `(()=>{ const require = globalThis.__dublineTestRequire; return eval(${JSON.stringify(expression)}); })()`;
    const result = await this.call('Runtime.evaluate', { expression: scoped, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  }
  close() { this.socket.close(); }
  static async connect(portNumber) {
    const deadline = Date.now() + 30000; let endpoint;
    while (Date.now() < deadline) {
      try { endpoint = (await (await fetch(`http://127.0.0.1:${portNumber}/json/list`)).json())[0]?.webSocketDebuggerUrl; if (endpoint) break; } catch (_) {}
      await wait(50);
    }
    if (!endpoint) throw Error('Packaged main inspector did not start.');
    const socket = new WebSocket(endpoint); await once(socket, 'open'); return new Inspector(socket);
  }
}
async function launch(executable, profile, beforeStart = '') {
  const inspectorPort = await port(), browserPort = await port();
  const env = { ...process.env, DUBLINE_USER_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [`--inspect-brk=${inspectorPort}`, `--remote-debugging-port=${browserPort}`, '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log = (log + data).slice(-32768); });
  const inspector = await Inspector.connect(inspectorPort);
  const paused = inspector.event('Debugger.paused'); await inspector.call('Debugger.enable'); await inspector.call('Runtime.runIfWaitingForDebugger');
  const frame = (await paused).callFrames[0];
  const prepared = await inspector.call('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId,
    expression: `(()=>{ globalThis.__dublineTestRequire = require; globalThis.__dublineTestUpdater = () => updateAdapter; globalThis.__dublineTestServerPid = () => serverChild?.pid; const e = require('electron'); e.BrowserWindow.prototype.show = function() {}; e.dialog.showErrorBox = (title,message) => console.error('Native startup error:',title,message); e.app.on('browser-window-created', (_, window) => window.webContents.setBackgroundThrottling(false)); ${beforeStart}; return 'prepared'; })()`, returnByValue: true });
  if (prepared.exceptionDetails) { child.kill(); throw Error(JSON.stringify(prepared.exceptionDetails)); }
  await inspector.call('Debugger.resume');
  return { child, inspector, browserPort, log: () => log };
}
module.exports = { Inspector, launch, wait, port };
