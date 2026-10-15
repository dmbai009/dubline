// Native selects remain the data/event interface; one shared popup serves every control.
(() => {
  const controls = new Map(); let opened = null, active = -1, query = '', typeTimer = null, typeText = '';
  const popupSize = new ResizeObserver(() => { if (opened) position(); });
  const popup = document.createElement('div'); popup.className = 'dub-select-popup'; popup.id = 'dubSelectPopup'; popup.setAttribute('popover', 'manual'); popup.hidden = true;
  const search = document.createElement('input'); search.type = 'search'; search.className = 'text-input dub-select-search';
  const list = document.createElement('div'); list.role = 'listbox'; list.id = 'dubSelectOptions'; popup.append(search, list); document.body.append(popup);
  function label(select) { return select.getAttribute('aria-label') || [...select.labels].map(item => item.querySelector('span:not(.switch-slider)')?.textContent.trim() || [...item.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent.trim()).join(' ')).join(' ') || select.title || select.selectedOptions[0]?.textContent || ''; }
  function sync(select) {
    const item = controls.get(select); if (!item) return;
    const text = select.selectedOptions[0]?.textContent || '';
    if (item.text.textContent !== text) item.text.textContent = text;
    if (item.button.disabled !== select.disabled) item.button.disabled = select.disabled;
    item.button.setAttribute('aria-label', label(select)); item.button.title = select.title;
    if (item.button.hidden !== select.hidden) item.button.hidden = select.hidden;
    item.button.style.display = select.style.display === 'none' ? 'none' : '';
    if (opened === select) { if (select.disabled || !select.isConnected || select.hidden) close(false); else if (item.popupKey !== optionKey(select)) paint(); }
  }
  function close(focus = false) {
    const previous = opened; opened = null;
    popupSize.disconnect();
    if (popup.hidePopover && popup.matches(':popover-open')) popup.hidePopover(); popup.hidden = true;
    const button = controls.get(previous)?.button; button?.setAttribute('aria-expanded', 'false'); button?.removeAttribute('aria-activedescendant');
    if (focus && button?.isConnected) button.focus({ preventScroll: true });
  }
  const options = () => opened ? [...opened.options].map((option, index) => ({ option, index })).filter(({ option }) => !option.hidden && (!query || option.textContent.toLocaleLowerCase().includes(query))) : [];
  const unavailable = option => option.disabled || option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled;
  const optionKey = select => JSON.stringify([...select.options].map(option => [option.textContent, option.value, option.selected, option.hidden, !!unavailable(option), option.dataset.disabledReason || option.title]));
  function position() {
    if (!opened) return;
    const anchor = controls.get(opened)?.button; if (!anchor?.isConnected || !anchor.getClientRects().length) return close(false);
    const box = anchor.getBoundingClientRect(), scale = popup.getBoundingClientRect().width / popup.offsetWidth || 1;
    const width = Math.min(Math.max(box.width, 180 * scale), innerWidth - 16);
    popup.style.width = width / scale + 'px';
    const below = innerHeight - box.bottom - 8, above = box.top - 8;
    const upwards = below < Math.min(popup.scrollHeight * scale, 240 * scale) && above > below;
    popup.style.maxHeight = Math.max(60, Math.min(340 * scale, upwards ? above : below)) / scale + 'px';
    popup.style.left = Math.max(8, Math.min(box.left, innerWidth - width - 8)) / scale + 'px';
    const height = popup.getBoundingClientRect().height, desiredTop = upwards ? box.top - height - 4 : box.bottom + 4;
    popup.style.top = Math.max(8, Math.min(desiredTop, innerHeight - height - 8)) / scale + 'px';
  }
  function paint() {
    if (!opened) return;
    controls.get(opened).popupKey = optionKey(opened);
    const entries = options(), enabled = entries.filter(({ option }) => !unavailable(option));
    if (!enabled.some(item => item.index === active)) active = enabled.find(item => item.index === opened.selectedIndex)?.index ?? enabled[0]?.index ?? -1;
    list.replaceChildren();
    for (const { option, index } of entries) {
      const row = document.createElement('div'); row.id = 'dubOption' + index; row.role = 'option'; row.dataset.index = index;
      row.textContent = option.textContent; const reason = option.dataset.disabledReason || option.title; if (unavailable(option) && reason) { const help = document.createElement('small'); help.textContent = reason; row.append(help); row.dataset.tooltip = reason; row.setAttribute('aria-description', reason); } row.setAttribute('aria-selected', String(option.selected)); row.setAttribute('aria-disabled', String(!!unavailable(option))); row.className = index === active ? 'dub-select-active' : '';
      row.onpointermove = () => { if (!unavailable(option) && active !== index) { active = index; mark(); } };
      row.onpointerdown = event => event.preventDefault(); row.onclick = () => choose(index); list.append(row);
    }
    controls.get(opened).button.setAttribute('aria-activedescendant', 'dubOption' + active); search.setAttribute('aria-activedescendant', 'dubOption' + active); position();
  }
  function mark() {
    for (const row of list.children) row.classList.toggle('dub-select-active', Number(row.dataset.index) === active);
    const id = 'dubOption' + active; controls.get(opened)?.button.setAttribute('aria-activedescendant', id); search.setAttribute('aria-activedescendant', id);
    document.getElementById(id)?.scrollIntoView({ block: 'nearest' });
  }
  function choose(index) {
    const select = opened, option = select?.options[index]; if (!option || unavailable(option)) return;
    const previousIndex = select.selectedIndex; select.selectedIndex = index; close(true); sync(select);
    if (index !== previousIndex) { select.dispatchEvent(new Event('input', { bubbles: true })); select.dispatchEvent(new Event('change', { bubbles: true })); }
  }
  function open(select) {
    if (select.disabled) return; if (opened === select) return close(true); close(); controls.get(select).button.scrollIntoView({ block: 'nearest', inline: 'nearest' }); opened = select; query = ''; search.value = '';
    (select.closest('dialog[open], [data-dropdown-surface]') || document.fullscreenElement || document.body).append(popup);
    search.hidden = select.options.length < 10; search.placeholder = t('dropdown.search'); search.setAttribute('aria-label', t('dropdown.search')); search.setAttribute('aria-controls', list.id); search.role = 'combobox'; search.setAttribute('aria-expanded', 'true');
    popup.hidden = false; if (popup.showPopover) popup.showPopover(); active = select.selectedIndex;
    controls.get(select).button.setAttribute('aria-expanded', 'true'); paint(); mark(); if (!search.hidden) search.focus(); else controls.get(select).button.focus({ preventScroll: true });
    popupSize.observe(controls.get(select).button); popupSize.observe(popup); const dialog = select.closest('dialog[open]'); if (dialog) popupSize.observe(dialog);
  }
  function key(event) {
    if (!opened) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') close(true);
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); const rows = options().filter(({ option }) => !unavailable(option)), at = rows.findIndex(item => item.index === active);
      active = rows[event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.index ?? -1; mark();
    } else if (event.key === 'Enter' || event.key === ' ' && event.target !== search) { event.preventDefault(); event.stopPropagation(); choose(active); }
    else if (search.hidden && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); clearTimeout(typeTimer); typeText += event.key.toLocaleLowerCase(); typeTimer = setTimeout(() => { typeText = ''; }, 700);
      const match = options().find(({ option }) => !unavailable(option) && option.textContent.toLocaleLowerCase().startsWith(typeText)); if (match) { active = match.index; mark(); }
    }
  }
  search.oninput = () => { query = search.value.toLocaleLowerCase().trim(); paint(); }; search.onkeydown = key;
  function attach(select) {
    if (controls.has(select) || select.multiple || select.size > 1) return;
    const button = document.createElement('button'), text = document.createElement('span'), arrow = document.createElement('span');
    button.type = 'button'; button.className = 'dub-select-button'; button.role = 'combobox'; button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', list.id);
    button.tabIndex = select.tabIndex; arrow.textContent = '⌄'; arrow.setAttribute('aria-hidden', 'true'); button.append(text, arrow); select.after(button);
    controls.set(select, { button, text }); select.classList.add('dub-select-source'); select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
    button.onclick = () => open(select); button.onkeydown = event => {
      if (opened === select) key(event);
      else if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); open(select); }
    };
    select.addEventListener('focus', () => button.focus()); select.addEventListener('change', () => sync(select)); sync(select);
  }
  let scheduled = false;
  function refresh() {
    if (scheduled) return; scheduled = true;
    queueMicrotask(() => { scheduled = false; for (const [select, item] of controls) if (!select.isConnected) { if (opened === select) close(); item.button.remove(); controls.delete(select); }
      for (const select of document.querySelectorAll('select')) { attach(select); sync(select); }
    });
  }
  const observer = new MutationObserver(records => { if (records.some(record => !record.target.parentElement?.closest('.dub-select-popup, .dub-select-button') && !record.target.closest?.('.dub-select-popup, .dub-select-button'))) refresh(); }); observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'selected', 'label', 'value', 'hidden', 'title', 'aria-label', 'data-disabled-reason'] });
  // Programmatic selection without a change event still updates the visible label.
  for (const property of ['value', 'selectedIndex']) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, property);
    Object.defineProperty(HTMLSelectElement.prototype, property, { ...descriptor, set(value) { descriptor.set.call(this, value); if (controls.has(this)) queueMicrotask(() => sync(this)); } });
  }
  const selectedDescriptor = Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, 'selected');
  Object.defineProperty(HTMLOptionElement.prototype, 'selected', { ...selectedDescriptor, set(value) { selectedDescriptor.set.call(this, value); const select = this.closest('select'); if (controls.has(select)) queueMicrotask(() => sync(select)); } });
  document.addEventListener('pointerdown', event => { if (opened && !popup.contains(event.target) && !controls.get(opened)?.button.contains(event.target)) close(); }, true);
  document.addEventListener('focusin', event => { if (opened && !popup.contains(event.target) && event.target !== controls.get(opened)?.button) close(); });
  window.addEventListener('resize', position); window.addEventListener('scroll', event => { if (!popup.contains(event.target)) position(); }, true);
  window.addEventListener('dubline-language-changed', () => { close(); refresh(); });
  window.addEventListener('pagehide', () => { close(); observer.disconnect(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'selected', 'label', 'value', 'hidden', 'title', 'aria-label', 'data-disabled-reason'] }); refresh(); } });
  window.DublineDropdown = { refresh, close, button: select => controls.get(select)?.button };
  refresh();
})();
