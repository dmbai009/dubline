// Move existing nodes, retaining their listeners and the personal/shared boundary.
(() => {
  const groups = new Map();
  function setup(scope, categories) {
    const root = document.getElementById(scope === 'user' ? 'tabContentUser' : 'tabContentPlayer');
    const cards = [...root.children];
    const nav = document.createElement('div'); nav.className = 'settings-categories';
    nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', t('settings.categories'));
    const panels = new Map();
    for (const category of categories) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn-outline';
      button.id = `settings-${scope}-${category}-tab`; button.dataset.i18n = `settings.category.${category}`;
      button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', `settings-${scope}-${category}`);
      const panel = document.createElement('div'); panel.className = 'settings-category'; panel.id = `settings-${scope}-${category}`;
      panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id);
      button.onclick = () => select(scope, category);
      button.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = categories.indexOf(category);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? categories.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + categories.length) % categories.length;
        select(scope, categories[next]); nav.children[next].focus();
      };
      nav.append(button); panels.set(category, panel);
    }
    root.prepend(nav); for (const panel of panels.values()) root.append(panel);
    groups.set(scope, { root, nav, panels });
    for (const card of cards) {
      if (card.querySelector('[data-i18n="desktop.about.title"]')) { card.id = 'desktopAboutCard'; root.append(card); continue; }
      let category = scope === 'user' ? 'audio' : 'room';
      if (card.querySelector('#settingsLanguage, #settingsTheme, #settingsPrompter, [data-i18n="layout.reset"], #settingsNickInput')) category = 'interface';
      if (card.querySelector('#settingsP2P, #desktopStorageChange, #desktopClearDataBtn')) category = 'storage';
      if (scope === 'player' && card.querySelector('#settingsAutoDuck')) category = 'audio';
      panels.get(category).append(card);
    }
    select(scope, categories[0]);
  }
  function select(scope, category) {
    const group = groups.get(scope); if (!group?.panels.has(category)) return;
    for (const [key, panel] of group.panels) panel.hidden = key !== category;
    for (const button of group.nav.children) {
      const active = button.getAttribute('aria-controls') === `settings-${scope}-${category}`;
      button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
    }
  }
  setup('user', ['audio', 'interface', 'storage']); setup('player', ['room', 'audio']);
  window.openSettingsCategory = select;
  window.addSettingsCard = (scope, category, card) => { groups.get(scope).panels.get(category).append(card); i18n.apply(card); };
  function accessibility() {
    for (const group of groups.values()) group.nav.setAttribute('aria-label', t('settings.categories'));
    document.querySelectorAll('#settingsModal .switch-ui input').forEach(input => {
      const key = input.closest('.setting-card-row')?.querySelector('[data-i18n]')?.dataset.i18n;
      if (key) input.setAttribute('aria-label', t(key));
    });
  }
  i18n.apply(); accessibility(); window.addEventListener('dubline-language-changed', accessibility);
})();
