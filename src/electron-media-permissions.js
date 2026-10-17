'use strict';
const allowedPermissions = new Set(['media', 'fullscreen', 'speaker-selection']);
function roomPermissionAllowed(webContents, permission, requester, expected) {
  try {
    return allowedPermissions.has(permission) && !!expected && new URL(webContents.getURL()).origin === expected && new URL(requester).origin === expected;
  } catch { return false; }
}
function installRoomPermissions(session, getExpectedOrigin) {
  session.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    callback(roomPermissionAllowed(webContents, permission, details.requestingUrl || webContents?.getURL(), getExpectedOrigin()));
  });
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details = {}) =>
    roomPermissionAllowed(webContents, permission, details.requestingUrl || requestingOrigin, getExpectedOrigin()));
}
module.exports = { roomPermissionAllowed, installRoomPermissions };
