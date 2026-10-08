// Exercise the production main process, preload and permission policy using an
// isolated profile. Inspector access is test-only; all windows stay hidden.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const { launch, wait } = require('./packaged-test-driver');
const { buildFixturePack, claimAndSelect, recordTake, waitFor, waitUntil } = require('../e2e/helpers');
const { captureScreens } = require('./visual-ui-cleanup');
const root = path.join(__dirname, '..');
async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-ui-native-'));
  let runtime, browser, completed = false;
  try {
    runtime = await launch(require('electron'), profile, '', { appPath: root });
    await waitUntil(async () => { try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${runtime.browserPort}`, defaultViewport: null }); return true; } catch { return false; } });
    let launcher;
    await waitUntil(async () => { launcher = (await browser.pages()).find(page => page.url().includes('electron-launcher.html')); return !!launcher; });
    await launcher.select('#language', 'en');
    await launcher.$eval('[data-mode=porthole]', button => button.click()); await launcher.$eval('#startHost', button => button.click());
    let page;
    await waitUntil(async () => { page = (await browser.pages()).find(candidate => /^http:\/\/127\.0\.0\.1:\d+\//.test(candidate.url())); return !!page; }, 20000);
    page.errors = []; page.on('pageerror', error => page.errors.push(error.message));
    await waitFor(page, () => !!window.dublineDesktop && !!session && document.body.classList.contains('desktop-mode'), 15000);
    await page.evaluate(() => { modalNickInput.value = 'Native UI'; handleNickSubmit(new Event('submit', { cancelable: true })); localStorage.setItem('dubline_help_seen', '1'); closeHelpModal(); });
    await waitFor(page, () => amHost() && myName === 'Native UI');
    await (await page.$('#zipInput')).uploadFile(buildFixturePack()); await waitFor(page, () => session?.loaded && session.lines.length === 4 && video.readyState >= 2, 30000);
    for (const mode of ['edit', 'dub', 'edit', 'dub']) {
      await page.evaluate(mode => setStudioMode(mode), mode); await waitFor(page, mode => session.mode === mode, 5000, mode);
      assert.equal(await page.evaluate(() => !!hostPanel.querySelector('.cast')), mode === 'dub', 'native host actions follow mode without reload');
    }
    await page.evaluate(() => { closeHostingModal(); closeFilesModal(); });
    await page.click('#transportCC');
    const captionState = await page.$eval('#transportCC', button => ({ off: button.classList.contains('subtitles-off'), pressed: button.getAttribute('aria-pressed'), shadow: getComputedStyle(button).boxShadow, hit: document.elementFromPoint(button.getBoundingClientRect().x + 5, button.getBoundingClientRect().y + 5)?.outerHTML.slice(0, 300) }));
    assert.equal(captionState.off && captionState.shadow !== 'none', true, JSON.stringify(captionState));
    await page.click('#transportCC');
    assert.equal(await page.$eval('#transportCC', button => button.getAttribute('aria-pressed')), 'true');
    const destination = path.join(root, 'build', 'ui-cleanup-qa', 'electron');
    const resize = async (width, height) => {
      await runtime.inspector.evaluate(`require('electron').BrowserWindow.getAllWindows().find(window => /^http:/.test(window.webContents.getURL())).setContentSize(${width}, ${height})`);
      await waitFor(page, (width, height) => innerWidth === width && innerHeight === height, 5000, width, height);
    };
    if (!process.argv.includes('--functional-only')) await captureScreens(page, destination, resize);
    for (const theme of ['light', 'graphite']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await waitFor(page, () => {
        const map = document.getElementById('timelineMinimap'), expected = document.createElement('canvas').getContext('2d');
        expected.fillStyle = getComputedStyle(map).getPropertyValue('--panel-2'); expected.fillRect(0, 0, 1, 1);
        return String([...map.getContext('2d').getImageData(Math.floor(map.width / 2), 0, 1, 1).data]) === String([...expected.getImageData(0, 0, 1, 1).data]);
      });
    }
    await page.evaluate(() => { setTimelineZoom(180); video.currentTime = 2; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const overview = await page.evaluate(() => {
      const box = document.getElementById('timelineMinimap').getBoundingClientRect();
      return { x: box.left + (timelineContainer.clientWidth - labelWidth) / pxPerSec / (timelineSeconds() + TIMELINE_TAIL) * box.width, y: box.top + 18, scale: pxPerSec };
    });
    await page.mouse.move(overview.x, overview.y); await page.mouse.down(); await page.mouse.move(overview.x + 40, overview.y, { steps: 8 }); await page.mouse.up();
    assert.equal(await page.evaluate(scale => pxPerSec < scale && video.currentTime === 2, overview.scale), true, 'native minimap edge zoom does not seek');
    await page.evaluate(() => setStudioMode('edit')); await waitFor(page, () => session.mode === 'edit');
    await page.evaluate(() => timelineContainer.focus());
    assert.equal(await page.evaluate(() => getComputedStyle(timelineContainer).outlineStyle === 'none' && getComputedStyle(document.querySelector('.timeline-panel')).boxShadow === 'none'), true);
    if (!process.argv.includes('--functional-only')) await page.screenshot({ path: path.join(destination, 'minimap-graphite.png') });
    await page.evaluate(() => setStudioMode('dub')); await waitFor(page, () => session.mode === 'dub');
    await page.evaluate(() => { openSettingsModal(); openSettingsCategory('user', 'audio'); });
    await page.click('#audioDeviceRefresh');
    await waitFor(page, () => !document.getElementById('audioDeviceRefresh').disabled);
    const audioDevices = await page.evaluate(async () => {
      await DublineAudioDevices.refresh();
      return { ...DublineAudioDevices.getSelection(), inputs: [...document.getElementById('audioInputDevice').options].map(option => ({ id: option.value, name: option.textContent })), outputs: [...document.getElementById('audioOutputDevice').options].map(option => ({ id: option.value, name: option.textContent })) };
    });
    assert.equal(audioDevices.outputSupported, true, 'Electron must support whole-application output selection');
    assert.ok(audioDevices.inputs.length > 1 && audioDevices.inputs.every(device => device.name));
    assert.equal(await page.evaluate(() => DublineAudioDevices.changeOutput('')), true, 'actual native default sink must work');
    const output = audioDevices.outputs.find(device => device.id);
    if (output) assert.equal(await page.evaluate(id => DublineAudioDevices.changeOutput(id), output.id), true, 'actual enumerated native sink must work');
    const input = audioDevices.inputs.find(device => device.id); await page.select('#audioInputDevice', input.id);
    await page.evaluate(() => closeSettingsModal()); await claimAndSelect(page, 1); await recordTake(page, 1);
    await waitFor(page, () => !pendingTakeLines.size);
    await page.reload(); await waitFor(page, () => session?.loaded && document.getElementById('audioInputDevice'));
    assert.equal(await page.$eval('#audioInputDevice', node => node.value), input.id, 'native restart/reload restores microphone selection');
    await page.evaluate(() => { ensurePlayCtx(); adrCues.arm(); }); await page.evaluate(() => DublineAudioDevices.ready());
    await page.evaluate(() => adrCues.stop());
    await page.evaluate(() => i18n.setLanguage('ru'));
    for (const [width, height] of [[1024, 768], [1280, 720], [1920, 1080]]) {
      await resize(width, height);
      for (const expanded of [false, true]) {
        await page.evaluate(expanded => { desktopInviteCollapsed = !expanded; renderDesktopInvite(); }, expanded);
        const overflow = await page.evaluate(() => document.querySelector('header').scrollWidth > document.querySelector('header').clientWidth + 1);
        assert.equal(overflow, false, `native invitation panel ${width} expanded=${expanded}`);
      }
      await runtime.inspector.evaluate("require('electron').BrowserWindow.getAllWindows().find(window => /^http:/.test(window.webContents.getURL())).webContents.setZoomFactor(1.5)");
      await wait(100);
      assert.equal(await page.evaluate(() => document.querySelector('header').scrollWidth > document.querySelector('header').clientWidth + 1), false, `native zoom ${width}`);
      await runtime.inspector.evaluate("require('electron').BrowserWindow.getAllWindows().find(window => /^http:/.test(window.webContents.getURL())).webContents.setZoomFactor(1)");
    }
    await resize(1280, 720); await page.evaluate(() => { desktopInviteCollapsed = true; renderDesktopInvite(); toggleExpandedVideo(); });
    assert.equal(await page.evaluate(() => {
      const speed = document.getElementById('previewRate').getBoundingClientRect(), expand = document.getElementById('transportExpandBtn').getBoundingClientRect(), fullscreen = document.querySelector('[data-studio-action=fullscreen]').getBoundingClientRect();
      return speed.right <= expand.left && expand.right <= fullscreen.left;
    }), true, 'native display actions sit to the right of speed');
    await page.$eval('[data-studio-action=fullscreen]', button => button.click()); await waitFor(page, () => !!document.fullscreenElement);
    assert.equal(await page.evaluate(() => document.getElementById('transportSeek').getBoundingClientRect().width >= document.querySelector('.studio-transport').getBoundingClientRect().width - 32), true);
    await page.evaluate(() => document.exitFullscreen());
    assert.deepEqual(page.errors, []);
    const expectedSelection = await page.evaluate(() => DublineAudioDevices.getSelection());
    const previousOrigin = new URL(page.url()).origin;
    await runtime.inspector.evaluate("require('electron').app.quit()").catch(() => {});
    runtime.inspector.close(); await waitUntil(() => runtime.child.exitCode !== null, 15000); browser.disconnect();
    runtime = await launch(require('electron'), profile, '', { appPath: root });
    await waitUntil(async () => { try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${runtime.browserPort}`, defaultViewport: null }); return true; } catch { return false; } });
    await waitUntil(async () => { launcher = (await browser.pages()).find(candidate => candidate.url().includes('electron-launcher.html')); return !!launcher; });
    await launcher.$eval('[data-mode=porthole]', button => button.click()); await launcher.$eval('#startHost', button => button.click());
    await waitUntil(async () => { page = (await browser.pages()).find(candidate => /^http:\/\/127\.0\.0\.1:\d+\//.test(candidate.url())); return !!page; }, 20000);
    await waitFor(page, () => session?.loaded && document.getElementById('audioInputDevice'), 15000);
    assert.equal(new URL(page.url()).origin, previousOrigin, 'the application retains the local origin across launches');
    assert.deepEqual(await page.evaluate(() => DublineAudioDevices.getSelection()), expectedSelection, 'microphone and output preferences survive an actual application restart');
    await page.evaluate(() => { ensurePlayCtx(); }); await page.evaluate(() => DublineAudioDevices.ready());
    console.log('Native UI PASS: production main/preload, scoped audio permissions, real capture/output selection, actual process restart, RU/EN/UK, 3 native window sizes, 150% zoom, invitation expansion, fullscreen seek.');
    console.log(`Native screenshots: ${destination}`);
    console.log(JSON.stringify(audioDevices)); completed = true;
  } catch (error) { if (runtime) console.error(runtime.log()); throw error; }
  finally {
    if (runtime) {
      await runtime.inspector.evaluate("require('electron').app.quit()").catch(() => {});
      runtime.inspector.close(); await waitUntil(() => runtime.child.exitCode !== null, 15000).catch(() => runtime.child.kill());
    }
    browser?.disconnect();
    if (completed) {
      const resolved = path.resolve(profile), temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
      assert.ok(resolved.startsWith(temporaryRoot) && path.basename(resolved).startsWith('dubline-ui-native-'));
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
