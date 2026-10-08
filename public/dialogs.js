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
  textPrompt.dataset.kind = confirmMode ? 'confirm' : 'text';
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
  document.getElementById('textPromptCancel').textContent = t('dialog.cancel');
  return new Promise(resolve => {
    pendingTextPrompt = { resolve, focus: document.activeElement, confirmMode };
    textPrompt.showModal();
    if (confirmMode) document.getElementById(options.danger ? 'textPromptCancel' : 'textPromptSave').focus();
    else { input.focus(); input.select(); }
  });
}
window.askText = (message, initial = '', maxLength = 40) => askDialog(message, initial, maxLength, false);
window.askConfirm = (message, options = {}) => {
  const id = window.DublineState?.data.session?.activeSessionId;
  return askDialog(message, '', 40, true, options).then(value => !!value && id === window.DublineState?.data.session?.activeSessionId);
};
document.getElementById('textPromptForm').addEventListener('submit', event => {
  event.preventDefault();
  if (pendingTextPrompt?.confirmMode) return closeTextPrompt(true);
  const value = document.getElementById('textPromptInput').value.trim();
  if (value) closeTextPrompt(value);
});
document.getElementById('textPromptCancel').onclick = () => closeTextPrompt();
textPrompt.addEventListener('cancel', event => { event.preventDefault(); closeTextPrompt(); });

textPrompt.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const controls = [...textPrompt.querySelectorAll('input, button')].filter(control => !control.disabled && !control.hidden);
  const index = controls.indexOf(document.activeElement);
  event.preventDefault();
  controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
});
