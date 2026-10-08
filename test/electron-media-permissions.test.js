const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installRoomPermissions, roomPermissionAllowed } = require('../electron-media-permissions');
test('media, fullscreen and speaker selection are confined to the exact active room origin', () => {
  const expected = 'http://127.0.0.1:3000', contents = { getURL: () => expected + '/?room=main' };
  for (const permission of ['media', 'fullscreen', 'speaker-selection']) {
    assert.equal(roomPermissionAllowed(contents, permission, expected + '/frame', expected), true);
    for (const requester of ['http://127.0.0.1:3001', 'https://evil.test', 'file:///tmp/page', 'invalid', undefined]) assert.equal(roomPermissionAllowed(contents, permission, requester, expected), false);
    assert.equal(roomPermissionAllowed({ getURL: () => 'https://evil.test' }, permission, expected, expected), false);
    assert.equal(roomPermissionAllowed(null, permission, expected, expected), false);
  }
  for (const permission of ['notifications', 'display-capture', 'geolocation', 'unknown']) assert.equal(roomPermissionAllowed(contents, permission, expected, expected), false);
});
test('request and check handlers follow host/guest origin changes and reject foreign subframes', () => {
  let expected = 'http://127.0.0.1:3000', request, check;
  installRoomPermissions({ setPermissionRequestHandler: handler => { request = handler; }, setPermissionCheckHandler: handler => { check = handler; } }, () => expected);
  const contents = { getURL: () => expected };
  let accepted;
  request(contents, 'speaker-selection', value => { accepted = value; }, { requestingUrl: expected }); assert.equal(accepted, true);
  assert.equal(check(contents, 'speaker-selection', expected), true);
  assert.equal(check(contents, 'media', expected, { requestingUrl: 'https://foreign.test' }), false);
  expected = 'https://guest-room.test';
  assert.equal(check(contents, 'speaker-selection', expected), true);
  request(contents, 'media', value => { accepted = value; }, { requestingUrl: 'http://127.0.0.1:3000' }); assert.equal(accepted, false);
});
