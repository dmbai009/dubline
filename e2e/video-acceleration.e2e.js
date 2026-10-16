const { describe, test, before, after } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor } = require('./helpers');
describe('personal video acceleration', { skip: skipReason, timeout: 180000 }, () => {
  let server, browser, host, guest; const errors = [];
  before(async () => {
    server = await startServer(); browser = await launchBrowser(server.port);
    host = await openPlayer(browser, server.url('acceleration'), 'Host'); await loadFixture(host);
    guest = await openPlayer(browser, server.url('acceleration'), 'Guest'); await waitFor(guest, () => session.loaded);
    host.on('pageerror', e => errors.push(e.message)); guest.on('pageerror', e => errors.push(e.message));
    const directory = fs.mkdtempSync(path.join(server.dirs.data, 'accelerated-export-'));
    await (await host.createCDPSession()).send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: directory });
  });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  async function openCustom() {
    await host.evaluate(() => { closeSettingsModal(); openFilesModal(); switchFilesTab('export'); });
    await waitFor(host, () => videoExportPanel.dataset.ready === 'true');
    await host.click('[name=videoExportMode][value=custom]'); await host.select('#videoExportSource','working'); await waitFor(host, () => !startRenderBtn.disabled);
  }
  test('the compact personal control persists across reloads and rooms without changing a guest or the scene', async () => {
    await host.evaluate(async () => { openSettingsModal(); await switchSettingsTab('user'); await openSettingsCategory('user', 'interface'); });
    await host.select('#settingsVideoAcceleration', 'off');
    assert.equal(await host.evaluate(() => DublineVideoAcceleration.get()), 'off');
    assert.equal(await guest.evaluate(() => DublineVideoAcceleration.get()), 'auto');
    assert.equal(await host.evaluate(() => Object.hasOwn(session, 'acceleration') || Object.hasOwn(session, 'videoAcceleration')), false);
    await host.reload(); await waitFor(host, () => socket.connected && session.loaded);
    assert.equal(await host.evaluate(() => DublineVideoAcceleration.get()), 'off');
    await host.goto(server.url('acceleration-other')); await waitFor(host, () => typeof DublineVideoAcceleration !== 'undefined');
    assert.equal(await host.evaluate(() => DublineVideoAcceleration.get()), 'off');
    await host.goto(server.url('acceleration')); await waitFor(host, () => socket.connected && session.loaded);
  });
  test('off selects software for an actual custom export', async () => {
    await openCustom();
    assert.equal(await host.evaluate(() => DublineVideoExportEngine.realtime({ acceleration:'off' }, {}, ()=>{}, { abort:new AbortController() }).then(()=>false,error=>error.message===t('exportVideo.unsupported'))),true,'off cannot silently use an uncontrolled MediaRecorder video encoder');
    await host.evaluate(() => { window.hwConfigs = []; window.hwConfigure = VideoEncoder.prototype.configure; VideoEncoder.prototype.configure = function(config) { hwConfigs.push(config.hardwareAcceleration); return hwConfigure.call(this, config); }; void startVideoRender(); });
    try {
      await waitFor(host, () => renderStatusText.dataset.state === 'success' || renderStatusText.dataset.state === 'error', 45000);
      assert.equal(await host.$eval('#renderStatusText', n => n.dataset.state), 'success', await host.$eval('#renderStatusText', n => n.textContent));
      const configs = await host.evaluate(() => hwConfigs); assert.ok(configs.length); assert.ok(configs.every(hint => hint === 'prefer-software'), JSON.stringify(configs));
    } finally { await host.evaluate(() => { VideoEncoder.prototype.configure = hwConfigure; }); }
  });
  test('a simulated driver failure retries once on CPU and completes a real export', async () => {
    await host.evaluate(() => DublineVideoAcceleration.set('on')); await openCustom();
    await host.evaluate(async () => {
      const mb = await import('/vendor/mediabunny/mediabunny.min.mjs');
      window.hwPreference = DublineVideoAcceleration.encoderPreference;
      // Exercise the runtime-failure branch on runners without a physical GPU.
      DublineVideoAcceleration.encoderPreference = async () => 'no-preference';
      window.hwAdd = mb.VideoSampleSource.prototype.add; window.hwAttempts = 0;
      mb.VideoSampleSource.prototype.add = async function(...args) { hwAttempts++; if (hwAttempts === 1) throw new DOMException('Simulated GPU device loss', 'OperationError'); return hwAdd.apply(this, args); };
      void startVideoRender();
    });
    try {
      await waitFor(host, () => renderStatusText.dataset.state === 'success' || renderStatusText.dataset.state === 'error', 45000);
      assert.equal(await host.$eval('#renderStatusText', n => n.dataset.state), 'success', await host.$eval('#renderStatusText', n => n.textContent));
      assert.match(await host.$eval('[data-phase=video]', n => n.textContent), /CPU/);
      assert.ok(await host.evaluate(() => hwAttempts > 10));
    } finally { await host.evaluate(async () => { DublineVideoAcceleration.encoderPreference = hwPreference; (await import('/vendor/mediabunny/mediabunny.min.mjs')).VideoSampleSource.prototype.add = hwAdd; }); }
  });
  test('fast copying bypasses hardware selection and no browser errors occurred', async () => {
    await host.click('[name=videoExportMode][value=fast]'); await waitFor(host, () => !startRenderBtn.disabled);
    await host.evaluate(() => { window.hwPreference = DublineVideoAcceleration.encoderPreference; DublineVideoAcceleration.encoderPreference = async () => { throw Error('Copy must not start an encoder'); }; void startVideoRender(); });
    try { await waitFor(host, () => renderStatusText.dataset.state === 'success' || renderStatusText.dataset.state === 'error', 45000); assert.equal(await host.$eval('#renderStatusText', n => n.dataset.state), 'success'); }
    finally { await host.evaluate(() => { DublineVideoAcceleration.encoderPreference = hwPreference; }); }
    assert.deepEqual(errors, []);
  });
  test('scene creation sends the personal mode and actually prepares compatible video', async () => {
    const source = path.join(server.dirs.data, 'hardware-import.mp4');
    const encoded = require('node:child_process').spawnSync(require('ffmpeg-static'), ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=25:duration=2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv444p',source], { encoding:'utf8', windowsHide:true, timeout:15000 });
    assert.equal(encoded.status,0,encoded.stderr);
    await host.evaluate(() => { closeFilesModal(); openFilesModal(); switchFilesTab('video'); DublineVideoAcceleration.set('on'); window.hwImportEvents=[]; socket.on('video_import_progress', event=>hwImportEvents.push(event)); window.hwUpload=DublineNetwork.upload; DublineNetwork.upload=(url,options)=>{window.hwSentMode=options.body.get('acceleration');return hwUpload(url,options);}; });
    await (await host.$('#customVideoInput')).uploadFile(source); await host.click('#customUploadBtn');
    try {
      await waitFor(host,()=>customImportStatus?.completed || customImportStatus?.phase==='error',45000);
      const result=await host.evaluate(()=>({completed:customImportStatus.completed,error:customImportStatus.error,mode:hwSentMode,events:hwImportEvents,original:session.hasOriginalVideo}));
      assert.equal(result.completed,true,result.error);assert.equal(result.mode,'on');assert.equal(result.original,true);
      assert.ok(result.events.some(event=>['gpu','cpu','cpu-fallback'].includes(event.backend)));
      assert.equal(await guest.evaluate(()=>DublineVideoAcceleration.get()),'auto');
      assert.deepEqual(errors,[]);
    } finally { await host.evaluate(()=>{DublineNetwork.upload=hwUpload;}); }
  });
  test('the host custom export uses its personal preference for original-video transcoding', async () => {
    await host.evaluate(()=>{openFilesModal();switchFilesTab('export');window.hwServerProgress=[];socket.on('video_export_progress',event=>hwServerProgress.push(event));});
    await waitFor(host,()=>videoExportPanel.dataset.ready==='true');
    await host.click('[name=videoExportMode][value=custom]');
    await host.select('#videoExportSource','original');
    await waitFor(host,()=>!startRenderBtn.disabled).catch(async error=>{console.log('Hardware original export controls:',await host.evaluate(()=>({method:videoExportMethod.textContent,source:videoExportSource.value,format:videoExportFormat.value,bitrate:videoExportBitrate.value,resolution:videoExportResolution.value,fps:videoExportFps.value,metadata:videoExportMetadata.textContent})));throw error;});
    await host.evaluate(()=>{void startVideoRender();});
    await waitFor(host,()=>renderStatusText.dataset.state==='success'||renderStatusText.dataset.state==='error',45000);
    assert.equal(await host.$eval('#renderStatusText',n=>n.dataset.state),'success',await host.$eval('#renderStatusText',n=>n.textContent));
    const events=await host.evaluate(()=>hwServerProgress);
    assert.ok(events.some(event=>['gpu','cpu','cpu-fallback'].includes(event.backend)));
    assert.ok(events.some(event=>event.done));assert.deepEqual(errors,[]);
  });
});
