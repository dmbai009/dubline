// Shared small tooltip surface. Disabled controls keep their native semantics;
// their focusable help wrapper is created only while an explanation is needed.
(() => {
  const tip = document.createElement('div'); tip.id = 'dublineTooltip'; tip.className = 'dubline-tooltip'; tip.role = 'tooltip'; tip.hidden = true; document.body.appendChild(tip);
  let target = null;
  function hide() { tip.hidden = true; target = null; }
  function paint() {
    if (!target?.isConnected || !target.dataset.tooltip || window.activeEditorGesture) return hide();
    tip.textContent = target.dataset.tooltip; tip.hidden = false;
    const box = target.getBoundingClientRect(), width = tip.offsetWidth, height = tip.offsetHeight;
    tip.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, box.right + 8))}px`;
    tip.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, box.top))}px`;
  }
  function show(event) { const next = event.target.closest?.('[data-tooltip]'); if (next) { target = next; paint(); } }
  document.addEventListener('pointerover', show);
  document.addEventListener('focusin', show);
  document.addEventListener('pointerout', event => { if (target && !target.contains(event.relatedTarget)) hide(); });
  document.addEventListener('focusout', hide);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  window.addEventListener('blur', hide); window.addEventListener('resize', hide);
  window.addEventListener('scroll', hide, true);
  document.addEventListener('fullscreenchange', () => { hide(); (document.fullscreenElement || document.body).appendChild(tip); });
  window.refreshDublineTooltip = paint;
  window.hideDublineTooltip = hide;
  window.setControlHelp = (control, reason) => {
    if (!control) return;
    let wrapper = control.parentElement?.matches('.control-help, .control-help-anchor') ? control.parentElement : null;
    if (reason) {
      // Existing slider handlers use their label to find the value output.
      // Make that label the help anchor instead of inserting a new parent.
      if (!wrapper && control.parentElement?.tagName === 'LABEL') {
        wrapper = control.parentElement; wrapper.classList.add('control-help-anchor');
      }
      if (!wrapper) {
        const focused = document.activeElement === control, selection = focused && ['TEXTAREA', 'INPUT'].includes(control.tagName) ? [control.selectionStart, control.selectionEnd] : null;
        wrapper = document.createElement('span'); wrapper.className = 'control-help'; control.before(wrapper);
        if (wrapper.moveBefore) wrapper.moveBefore(control, null);
        else {
          wrapper.appendChild(control);
          if (focused) { control.focus({ preventScroll: true }); if (selection?.[0] != null) control.setSelectionRange(...selection); }
        }
      }
      wrapper.tabIndex = 0; wrapper.dataset.tooltip = reason; wrapper.setAttribute('role', 'group'); wrapper.setAttribute('aria-label', reason); wrapper.setAttribute('aria-describedby', tip.id);
      control.setAttribute('aria-description', reason);
    } else {
      control.removeAttribute('aria-description');
      if (wrapper) { delete wrapper.dataset.tooltip; wrapper.removeAttribute('tabindex'); wrapper.removeAttribute('role'); wrapper.removeAttribute('aria-label'); wrapper.removeAttribute('aria-describedby'); }
    }
    if (target === wrapper) paint();
  };
})();
