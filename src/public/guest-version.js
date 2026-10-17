(function(root) {
  const valid = value => typeof value === 'string' && value.length <= 80 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
  function clientVersion(userAgent) {
    // Electron's default User-Agent already includes Dubline/<app version> in
    // older releases, so they can display this host-served warning as well.
    if (!/\bElectron\//i.test(userAgent || '')) return '';
    const version = /(?:^|\s)Dubline\/([^\s]+)/i.exec(userAgent || '')?.[1];
    return valid(version) ? version : '';
  }
  function mismatch(userAgent, hostVersion) {
    const guest = clientVersion(userAgent);
    return guest && valid(hostVersion) && guest !== hostVersion ? { guest, host: hostVersion } : null;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { clientVersion, mismatch };
  if (typeof document === 'undefined' || typeof socket === 'undefined' || root.dublineDesktop) return;
  const guest = clientVersion(navigator.userAgent);
  if (!guest) return;
  const banner = document.createElement('aside'), copy = document.createElement('div'), title = document.createElement('strong'), text = document.createElement('span'), close = document.createElement('button');
  banner.id = 'guestVersionWarning'; banner.className = 'app-update-banner guest-version-warning';
  banner.setAttribute('role', 'status'); banner.setAttribute('aria-live', 'polite');
  copy.className = 'app-update-copy'; close.className = 'modal-close-icon'; close.type = 'button'; close.textContent = '×';
  copy.append(title, text); banner.append(copy, close); document.body.append(banner);
  let host = '', dismissed = '';
  const pair = () => guest + '/' + host;
  function render() {
    const different = mismatch(navigator.userAgent, host);
    banner.classList.toggle('show', !!different && dismissed !== pair());
    title.textContent = root.DublineI18n.t('guestVersion.title');
    text.textContent = root.DublineI18n.t('guestVersion.message', { guest, host });
    close.title = root.DublineI18n.t('close'); close.setAttribute('aria-label', close.title);
  }
  close.onclick = () => { dismissed = pair(); render(); };
  socket.on('host_version', data => { if (valid(data?.version)) { host = data.version; render(); } });
  socket.on('disconnect', () => { host = ''; render(); });
  root.addEventListener('dubline-language-changed', render);
})(typeof window === 'undefined' ? globalThis : window);
