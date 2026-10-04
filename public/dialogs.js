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

window.askText = function(message, initial = '', maxLength = 40) {
  closeTextPrompt();
  document.getElementById('textPromptTitle').textContent = message;
  const input = document.getElementById('textPromptInput');
  input.value = initial;
  input.maxLength = maxLength;
  document.getElementById('textPromptSave').textContent = t('save');
  document.getElementById('textPromptCancel').setAttribute('aria-label', t('close'));
  return new Promise(resolve => {
    pendingTextPrompt = { resolve, focus: document.activeElement };
    textPrompt.showModal();
    input.focus();
    input.select();
  });
};
document.getElementById('textPromptForm').addEventListener('submit', event => {
  event.preventDefault();
  const value = document.getElementById('textPromptInput').value.trim();
  if (value) closeTextPrompt(value);
});
document.getElementById('textPromptCancel').onclick = () => closeTextPrompt();
textPrompt.addEventListener('cancel', event => { event.preventDefault(); closeTextPrompt(); });
