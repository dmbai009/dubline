// Uses the current scene and existing upload/dialog helpers; no media/editor queue.
(() => {
  const controls = document.getElementById('backingSourceControls'), input = document.getElementById('backingSourceInput');
  const upload = document.getElementById('backingUploadBtn'), remove = document.getElementById('backingRemoveBtn');
  let operation = null;
  const base = () => session?.baseBackingUrl ?? (session?.backingTrack >= 0 ? '' : session?.backingUrl || '');
  const fields = () => ({ clientId, sessionId: session?.activeSessionId, baseBackingUrl: base(), backingUrl: session?.backingUrl || '', backingTrack: session?.backingTrack ?? -1 });
  function reason() {
    if (!session?.loaded) return t('error.noScene');
    if (!socket.connected) return t('conn.lost');
    if (!amHost()) return t('onlyHost');
    if (operation) return t('backing.preparing');
    if (recordState !== 'idle' || renderInProgress || customImportRequest) return t('studio.mediaBusy');
    return '';
  }
  window.refreshBackingSource = () => {
    const url = base(), filename = session?.audioMetadata?.backing?.name || decodeURIComponent(url.split('/').pop() || '');
    const name = controls.querySelector('#backingSourceName');
    name.textContent = url ? t('backing.current', { name: filename }) : t('backing.noFile'); name.title = name.textContent;
    upload.textContent = t(url ? 'backing.replace' : 'backing.add');
    const blocked = reason(); upload.disabled = !!blocked; remove.disabled = !!blocked || !url;
    remove.hidden = !url;
    window.setControlHelp?.(upload, blocked); window.setControlHelp?.(remove, blocked || (!url ? t('backing.noFile') : ''));
    controls.querySelector('#backingSourceStatus').textContent = operation ? t('backing.preparing') : '';
    controls.hidden = !session?.loaded;
  };
  window.chooseBackingSource = () => { if (!reason()) input.click(); };
  async function send(endpoint, body, captured) {
    const abort = new AbortController(); operation = { abort, sessionId: captured.sessionId }; refreshBackingSource();
    try {
      const response = await window.DublineNetwork.upload(`/api/backing-source${endpoint}?room=${encodeURIComponent(currentRoom)}`, {
        method: 'POST', body, signal: abort.signal,
        ...(endpoint ? { headers: { 'Content-Type': 'application/json' } } : {})
      });
      if (!response.ok) throw new Error(await readError(response));
      // Authoritative session_updated updates sources; never merge a delayed reply into another scene.
      await response.json();
    } catch (error) { if (error.name !== 'AbortError') showToast(error.message); }
    finally { operation = null; refreshBackingSource(); }
  }
  input.addEventListener('change', () => {
    const file = input.files[0]; input.value = '';
    if (!file || reason()) return;
    if (file.size > 300 * 1024 * 1024) return showToast(t('error.fileTooBig', { max: 300 }));
    const captured = fields(), form = new FormData();
    Object.entries(captured).forEach(([name, value]) => form.append(name, value)); form.append('intershum', file);
    void send('', form, captured);
  });
  window.removeBackingSource = async () => {
    if (reason() || !base()) return;
    const captured = fields();
    if (!await askConfirm(t('backing.removeConfirm'))) return;
    if (reason() || JSON.stringify(fields()) !== JSON.stringify(captured)) return showToast(t('backing.changed'));
    await send('/remove', JSON.stringify(captured), captured);
  };
  const cancelStale = () => {
    if (operation && (!socket.connected || !amHost() || operation.sessionId !== session?.activeSessionId)) operation.abort.abort();
    refreshBackingSource();
  };
  for (const event of ['session_updated', 'room_users_updated', 'disconnect', 'connect']) socket.on(event, cancelStale);
  window.addEventListener('dubline-language-changed', refreshBackingSource);
})();
