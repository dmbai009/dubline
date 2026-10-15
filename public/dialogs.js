// Text entry must work in Electron too, where window.prompt is unsupported.
let pendingTextPrompt = null;
const textPrompt = document.createElement('dialog');
textPrompt.className = 'text-prompt';
textPrompt.setAttribute('aria-labelledby', 'textPromptTitle');
textPrompt.innerHTML = `<form method="dialog" id="textPromptForm">
  <label id="textPromptTitle" for="textPromptInput"></label>
  <input id="textPromptInput" class="text-input" required autocomplete="off">
  <div class="insp-actions"><button type="button" id="textPromptCancel" class="btn-outline">✕</button>
  <button type="submit" class="btn-play" id="textPromptSave"></button></div>
</form>`;
const textPromptContinue = document.createElement('button'); textPromptContinue.type = 'button'; textPromptContinue.id = 'textPromptContinue'; textPromptContinue.className = 'btn-outline'; textPromptContinue.hidden = true;
textPrompt.querySelector('.insp-actions').append(textPromptContinue);
document.body.appendChild(textPrompt);

function closeTextPrompt(value = null) {
  if (!pendingTextPrompt) return false;
  const { resolve, focus } = pendingTextPrompt;
  pendingTextPrompt = null;
  textPrompt.close();
  if (focus && focus.isConnected) focus.focus();
  resolve(value);
  return true;
}

function askDialog(message, initial, maxLength, confirmMode, options = {}) {
  closeTextPrompt();
  textPrompt.dataset.kind = options.decision ? 'decision' : confirmMode ? 'confirm' : 'text';
  document.getElementById('textPromptTitle').textContent = message;
  const input = document.getElementById('textPromptInput');
  input.hidden = confirmMode;
  input.disabled = confirmMode;
  input.required = !confirmMode;
  input.value = initial;
  input.maxLength = maxLength;
  const save = document.getElementById('textPromptSave');
  save.className = options.danger ? 'btn-delete' : 'btn-play';
  save.textContent = t(options.confirmKey || (confirmMode ? 'dialog.confirm' : 'save'));
  document.getElementById('textPromptCancel').textContent = t(options.decision ? 'fx.discardDraft' : 'dialog.cancel');
  textPromptContinue.hidden = !options.decision; textPromptContinue.textContent = t('fx.continueDraft');
  return new Promise(resolve => {
    pendingTextPrompt = { resolve, focus: document.activeElement, confirmMode, decision: !!options.decision };
    textPrompt.showModal();
    if (confirmMode) document.getElementById(options.danger ? 'textPromptCancel' : 'textPromptSave').focus();
    else { input.focus(); input.select(); }
  });
}
window.askText = (message, initial = '', maxLength = 40) => askDialog(message, initial, maxLength, false);
window.askDraftDecision = () => askDialog(t('fx.unsaved'), '', 40, true, { decision: true, confirmKey: 'fx.saveDraft' });
window.askConfirm = (message, options = {}) => {
  const id = window.DublineState?.data.session?.activeSessionId;
  return askDialog(message, '', 40, true, options).then(value => !!value && id === window.DublineState?.data.session?.activeSessionId);
};
document.getElementById('textPromptForm').addEventListener('submit', event => {
  event.preventDefault();
  if (pendingTextPrompt?.confirmMode) return closeTextPrompt(pendingTextPrompt.decision ? 'save' : true);
  const value = document.getElementById('textPromptInput').value.trim();
  if (value) closeTextPrompt(value);
});
document.getElementById('textPromptCancel').onclick = () => closeTextPrompt(pendingTextPrompt?.decision ? 'discard' : null);
textPromptContinue.onclick = () => closeTextPrompt();
textPrompt.addEventListener('cancel', event => { event.preventDefault(); closeTextPrompt(); });

textPrompt.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const controls = [...textPrompt.querySelectorAll('input, button')].filter(control => !control.disabled && !control.hidden);
  const index = controls.indexOf(document.activeElement);
  event.preventDefault();
  controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
});

// All compact native dialogs use the same interface-zoom geometry.
window.observeDialogZoom = dialog => {
  const adjust = () => { const zoom = String((Number(getComputedStyle(document.body).zoom) || 1) * (Number(getComputedStyle(document.documentElement).zoom) || 1)); if (dialog.style.getPropertyValue('--fx-ui-zoom') !== zoom) dialog.style.setProperty('--fx-ui-zoom', zoom); };
  const observer = new ResizeObserver(adjust); observer.observe(dialog); adjust(); return observer;
};
