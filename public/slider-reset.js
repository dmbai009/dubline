// One delegated handler covers dynamic controls. Exactly one canonical event is
// dispatched: emitting both input and change duplicates personal-mix updates.
document.addEventListener('dblclick', event => {
  const control = event.target.closest('input[type="range"]');
  if (!control || control.disabled || control.readOnly) return;
  const reset = control.dataset.resetResolver
    ? window.resolveSliderReset?.(control.dataset.resetResolver, control)
    : control.dataset.resetValue;
  if (reset === undefined || reset === null || !Number.isFinite(Number(reset))) return;
  event.preventDefault();
  control.value = String(Math.min(Number(control.max), Math.max(Number(control.min), Number(reset))));
  control.dispatchEvent(new Event(control.dataset.resetEvent || 'change', { bubbles: true }));
});
