// Desktop-only invitation controls, exercised with a safe mock of the Electron preload bridge.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, launchBrowser, startServer, waitFor } = require('./helpers');

describe('desktop invitation', { skip: skipReason }, () => {
  let server;
  let browser;
  let page;

  before(async () => {
    server = await startServer();
    browser = await launchBrowser(server.port);
    page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      window.__desktopClipboard = '';
      window.__desktopStatus = {
        isDesktop: true,
        room: 'desktop',
        pin: '7K9A',
        state: 'ready',
        mode: 'cloudflare',
        port: 38500,
        publicUrl: 'https://quiet.trycloudflare.com',
        tools: {}
      };
      window.dublineDesktop = {
        getStatus: async () => ({ ...window.__desktopStatus }),
        setHostingMode: async mode => {
          window.__desktopStatus = {
            ...window.__desktopStatus,
            mode,
            provider: mode === 'vpn' ? 'radmin' : '',
            state: 'waitingGuest',
            publicUrl: mode === 'vpn' ? 'http://26.10.20.30:38500' : `http://localhost:38500`
          };
          return { ...window.__desktopStatus };
        },
        retryHosting: async () => ({ ...window.__desktopStatus }),
        openNetworkTool: async () => true,
        copyText: async value => {
          window.__desktopClipboard = String(value);
          return true;
        },
        clearAllData: async () => true,
        onTunnelStatus: () => () => {},
        getUpdateStatus: async () => ({ state: 'available', currentVersion: '1.1.0', version: '1.2.0', url: 'https://github.com/dmbai009/dubline/releases/tag/v1.2.0', dismissed: false }),
        openUpdate: async () => { window.__updateOpened = true; return true; },
        openProject: async () => { window.__projectOpened = true; return true; },
        dismissUpdate: async () => true,
        onUpdateStatus: () => () => {}
      };
    });
    await page.goto(server.url('desktop'), { waitUntil: 'domcontentloaded' });
    await waitFor(page, () => document.body.classList.contains('desktop-mode')
      && !document.getElementById('desktopCopyAllBtn').disabled);
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await server.cleanup();
  });

  test('starts collapsed and copies the hidden PIN together with the link', async () => {
    const initial = await page.evaluate(() => ({
      collapsed: document.getElementById('desktopInvitePanel').classList.contains('collapsed'),
      details: getComputedStyle(document.querySelector('.desktop-invite-details')).display,
      pin: document.getElementById('desktopPinCode').textContent
    }));
    assert.equal(initial.collapsed, true);
    assert.equal(initial.details, 'none');
    assert.equal(initial.pin, '••••');

    await page.$eval('#desktopCopyAllBtn', button => button.click());
    const copied = await page.evaluate(() => window.__desktopClipboard);
    assert.match(copied, /https:\/\/quiet\.trycloudflare\.com\/\?room=desktop/);
    assert.match(copied, /7K9A/);
    assert.equal(await page.$eval('#desktopPinCode', element => element.textContent), '••••');

    await page.$eval('.desktop-invite-toggle', button => button.click());
    assert.equal(await page.$eval('.desktop-invite-details', element => getComputedStyle(element).display), 'flex');
  });

  test('switches the connection method without leaving the room', async () => {
    await page.evaluate(() => openHostingModal());
    await page.$eval('[data-hosting-mode="vpn"]', button => button.click());
    await waitFor(page, () => document.querySelector('[data-hosting-mode="vpn"]').classList.contains('active'));
    const result = await page.evaluate(() => ({
      modal: getComputedStyle(document.getElementById('hostingModal')).display,
      mode: document.getElementById('desktopHostingModeTitle').textContent,
      port: document.getElementById('desktopHostingPort').textContent,
      url: document.getElementById('desktopInviteUrl').value
    }));
    assert.equal(result.modal, 'flex');
    assert.equal(result.mode, 'Radmin VPN');
    assert.equal(result.port, '38500');
    assert.match(result.url, /^http:\/\/26\.10\.20\.30:38500\/\?room=desktop$/);
  });

  test('keeps the update notice optional and non-blocking', async () => {
    await waitFor(page, () => document.getElementById('appUpdateBanner').classList.contains('show'));
    assert.match(await page.$eval('#appUpdateVersion', node => node.textContent), /1\.2\.0/);
    assert.equal(await page.$eval('#desktopAboutVersion', node => node.textContent), 'Dubline v1.1.0');
    await page.evaluate(() => openAppUpdate());
    await waitFor(page, () => window.__updateOpened === true);
    await page.evaluate(() => dismissAppUpdate());
    assert.equal(await page.$eval('#appUpdateBanner', node => node.classList.contains('show')), false);
    await page.evaluate(() => openProjectPage());
    await waitFor(page, () => window.__projectOpened === true);
  });
});
