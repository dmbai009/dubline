const test = require('node:test');
const assert = require('node:assert/strict');
const { WORKSHOP_URL, createWorkshopLinkHandler } = require('../electron-external-links');
const settle = () => new Promise(resolve => setImmediate(resolve));

test('Workshop opens externally while Electron popups stay blocked', async () => {
  const opened = [];
  const handle = createWorkshopLinkHandler(async url => { opened.push(url); });
  for (const url of [WORKSHOP_URL, WORKSHOP_URL + '/']) {
    assert.deepEqual(handle({ url }), { action: 'deny' });
    await settle();
  }
  assert.deepEqual(opened, [WORKSHOP_URL, WORKSHOP_URL]);
});

test('room popups cannot open arbitrary external sites or protocols', async () => {
  const opened = [];
  const handle = createWorkshopLinkHandler(async url => { opened.push(url); });
  for (const url of [
    'https://example.com/', 'http://voxalike.com/workshop',
    'https://voxalike.com.evil.test/workshop', 'https://voxalike.com@evil.test/workshop',
    'https://user:pass@voxalike.com/workshop', 'https://voxalike.com:444/workshop',
    WORKSHOP_URL + '.evil', WORKSHOP_URL + '/other', WORKSHOP_URL + '?redirect=evil',
    'file:///C:/Windows/System32/cmd.exe', 'javascript:alert(1)', 'steam://run/4963920', ''
  ]) assert.deepEqual(handle({ url }), { action: 'deny' }, url);
  await settle();
  assert.deepEqual(opened, []);
});

test('external browser failures are reported without allowing a popup', async () => {
  for (const rejectAsync of [false, true]) {
    const error = new Error('Browser could not be opened');
    const errors = [];
    const handle = createWorkshopLinkHandler(() => {
      if (rejectAsync) return Promise.reject(error);
      throw error;
    }, failure => errors.push(failure));
    assert.deepEqual(handle({ url: WORKSHOP_URL }), { action: 'deny' });
    await settle();
    assert.deepEqual(errors, [error]);
  }
});
