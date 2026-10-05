// Room-level convenience features: Random Cast, Blind Mode and player activity.
const settingsBlindMode = document.getElementById('settingsBlindMode');
const settingsHideMyTakes = document.getElementById('settingsHideMyTakes');

function renderBlindSettings() {
  if (!session) return;
  settingsBlindMode.checked = !!session.blindMode;
  settingsBlindMode.disabled = !amHost();
  settingsBlindMode.title = amHost() ? '' : t('onlyHost');
  settingsHideMyTakes.checked = (session.blindPlayers || []).includes(myName);
}

settingsBlindMode.addEventListener('change', () => {
  if (!amHost()) return renderBlindSettings();
  socket.emit('set_blind_mode', { enabled: settingsBlindMode.checked });
});

settingsHideMyTakes.addEventListener('change', () => {
  socket.emit('set_blind_preference', { enabled: settingsHideMyTakes.checked });
});

socket.on('session_updated', renderBlindSettings);

window.randomCast = async function() {
  if (!amHost() || !session || session.mode !== 'dub') return;
  if (await askConfirm(t('randomCast.confirm'))) socket.emit('random_cast');
};

window.revealAllTakes = function() {
  if (amHost()) socket.emit('host_reveal_takes');
};

socket.on('player_activity_update', activity => {
  if (!activity || !activity.nick) return;
  if (activity.state === 'idle') playerActivities.delete(activity.nick);
  else playerActivities.set(activity.nick, activity);
  renderLobby();
});

let lastActivityReport = 0;
let lastActivityValue = '';
window.reportPlayerActivity = function(stateName, pct = 0, force = false) {
  const value = `${stateName}:${Math.round(pct)}`;
  const now = performance.now();
  if (!force && value === lastActivityValue) return;
  if (!force && now - lastActivityReport < 400) return;
  lastActivityReport = now;
  lastActivityValue = value;
  socket.emit('player_activity', { state: stateName, pct });
};

renderBlindSettings();
