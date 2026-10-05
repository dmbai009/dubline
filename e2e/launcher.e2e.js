const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { skipReason, launchBrowser, waitFor } = require('./helpers');

describe('desktop launcher', { skip: skipReason }, () => {
  let browser;
  let page;

  before(async () => {
    browser = await launchBrowser(0);
    page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 780 });
    await page.evaluateOnNewDocument(() => {
      window.__launcherAction = null;
      window.dublineLauncher = {
        detectTools: async () => ({
          porthole: { installed: true, running: true },
          radmin: { installed: true, running: true, ip: '26.10.20.30' },
          hamachi: { installed: false, running: false, ip: '' }
        }),
        startHost: async mode => { window.__launcherAction = { type: 'host', mode }; return { ok: true, port: 38500 }; },
        startSingle: async () => { window.__launcherAction = { type:'single' }; return { ok:true }; },
        openProjectFile: async mode => { window.__launcherAction = { type:'open', mode }; return window.__fileError ? { ok:false, error:'Invalid project' } : { ok:true, canceled:!!window.__cancelFile }; },
        joinGuest: async address => { window.__launcherAction = { type: 'guest', address }; return { ok: true }; },
        openNetworkTool: async tool => { window.__launcherAction = { type: 'tool', tool }; return true; },
        getUpdateStatus: async () => ({ state: 'available', currentVersion: '1.1.0', version: '1.2.0', url: 'https://github.com/dmbai009/dubline/releases/tag/v1.2.0', dismissed: false }),
        openUpdate: async () => { window.__launcherAction = { type: 'update' }; return true; },
        openProject: async () => { window.__launcherAction = { type: 'project' }; return true; },
        dismissUpdate: async () => true,
        onUpdateStatus: () => () => {}
      };
    });
    await page.goto(pathToFileURL(path.resolve('electron-launcher.html')).href, { waitUntil: 'domcontentloaded' });
    await waitFor(page, () => document.querySelectorAll('.mode').length === 3);
  });

  after(async () => { if (browser) await browser.close(); });

  test('Single Player and project-open entries choose runtime mode and report errors', async () => {
    await page.click('#startSingle'); await waitFor(page, () => window.__launcherAction?.type === 'single');
    await page.click('#openProjectFile'); await waitFor(page, () => window.__launcherAction?.type === 'open');
    assert.equal(await page.evaluate(() => window.__launcherAction.mode),'single');
    await page.select('#projectOpenMode','multiplayer'); await page.$eval('[data-mode=porthole]', node => node.click());
    await page.click('#openProjectFile'); assert.equal(await page.evaluate(() => window.__launcherAction.mode),'porthole');
    await page.evaluate(() => window.__fileError = true); await page.click('#openProjectFile');
    await waitFor(page, () => document.getElementById('projectError').textContent.includes('Invalid project'));
    assert.equal(await page.$eval('#openProjectFile', node => node.disabled),false);
    await page.evaluate(() => { window.__fileError = false; window.__cancelFile = true; }); await page.click('#openProjectFile');
    assert.equal(await page.$eval('#projectError', node => node.textContent),'');
  });
  test('chooses a detected fallback and starts hosting', async () => {
    const layout = await page.evaluate(() => {
      const grid = document.getElementById('modes').getBoundingClientRect();
      const cards = [...document.querySelectorAll('.mode')].map(node => node.getBoundingClientRect());
      return { gridLeft:grid.left, gridRight:grid.right, firstLeft:cards[0].left, lastRight:cards.at(-1).right };
    });
    assert.ok(Math.abs(layout.gridLeft - layout.firstLeft) < 1);
    assert.ok(Math.abs(layout.gridRight - layout.lastRight) < 1);
    await waitFor(page, () => document.querySelector('[data-mode="vpn"] .badge')?.classList.contains('good'));
    await page.$eval('[data-mode="vpn"]', button => button.click());
    await page.$eval('#startHost', button => button.click());
    await waitFor(page, () => window.__launcherAction?.type === 'host');
    assert.deepEqual(await page.evaluate(() => window.__launcherAction), { type: 'host', mode: 'vpn' });
  });

  test('accepts a private address in guest mode', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.$eval('#guestTab', button => button.click());
    await page.$eval('#guestAddress', input => { input.value = '26.10.20.30:38500'; });
    await page.$eval('#joinGuest', button => button.click());
    await waitFor(page, () => window.__launcherAction?.type === 'guest');
    assert.deepEqual(await page.evaluate(() => window.__launcherAction), { type: 'guest', address: '26.10.20.30:38500' });
  });

  test('shows a dismissible manual GitHub update notice', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitFor(page, () => document.getElementById('updateBanner').classList.contains('show'));
    assert.match(await page.$eval('#updateVersion', node => node.textContent), /1\.2\.0/);
    assert.equal(await page.$eval('#launcherVersion', node => node.textContent), 'Dubline v1.1.0');
    await page.$eval('#updateDownload', button => button.click());
    await waitFor(page, () => window.__launcherAction?.type === 'update');
    await page.$eval('#updateLater', button => button.click());
    assert.equal(await page.$eval('#updateBanner', node => node.classList.contains('show')), false);
    await page.$eval('#projectLink', button => button.click());
    await waitFor(page, () => window.__launcherAction?.type === 'project');
  });
});

// Keep storage controls in the standard browser regression command.
require('./storage.e2e');
