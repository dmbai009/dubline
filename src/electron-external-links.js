const WORKSHOP_URL = 'https://voxalike.com/workshop';

// Room windows keep popups blocked; this fixed link opens in the system browser.
function createWorkshopLinkHandler(openExternal, reportError = console.error) {
  return ({ url }) => {
    if (url === WORKSHOP_URL || url === WORKSHOP_URL + '/') {
      Promise.resolve().then(() => openExternal(WORKSHOP_URL)).catch(reportError);
    }
    return { action: 'deny' };
  };
}

module.exports = { WORKSHOP_URL, createWorkshopLinkHandler };
