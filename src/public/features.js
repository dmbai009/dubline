// Room-level convenience features: Random Cast, Blind Mode and player activity.
const settingsBlindMode = document.getElementById('settingsBlindMode');
const settingsHideMyTakes = document.getElementById('settingsHideMyTakes');

function renderBlindSettings() {
  if (!session) return;
  settingsBlindMode.checked = !!session.blindMode;
  settingsBlindMode.disabled = !canModerate();
  settingsBlindMode.title = canModerate() ? '' : t('moderator.only');
  settingsHideMyTakes.checked = (session.blindPlayers || []).includes(myName);
}

settingsBlindMode.addEventListener('change', () => {
  if (!canModerate()) return renderBlindSettings();
  socket.emit('set_blind_mode', { enabled: settingsBlindMode.checked, sessionId: session?.activeSessionId });
});

settingsHideMyTakes.addEventListener('change', () => {
  socket.emit('set_blind_preference', { enabled: settingsHideMyTakes.checked, sessionId: session?.activeSessionId });
});

socket.on('session_updated', renderBlindSettings);

window.randomCast = async function() {
  if (!canModerate() || !session || session.mode !== 'dub') return;
  const sessionId = session.activeSessionId;
  if (await askConfirm(t('randomCast.confirm')) && session?.activeSessionId === sessionId && canModerate()) socket.emit('random_cast', { sessionId });
};

window.revealAllTakes = function() {
  if (canModerate()) socket.emit('host_reveal_takes', { sessionId: session?.activeSessionId });
};

let lastActivityReport = 0;
let lastActivityValue = '';
window.reportPlayerActivity = function(stateName, pct = 0, force = false) {
  const value = `${stateName}:${Math.round(pct)}`;
  const now = performance.now();
  if (!force && value === lastActivityValue) return;
  if (!force && now - lastActivityReport < 400) return;
  lastActivityReport = now;
  lastActivityValue = value;
  window.updateMediaTransfer?.({ downloading: stateName === 'downloading', pct });
};

renderBlindSettings();
