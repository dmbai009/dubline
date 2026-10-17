(() => {
  const messages = window.DublineLocales || { en: {} };
  messages.en = messages.en || {};
  const preferences = window.dublinePreferences || window.dublineDesktop;
  let language;
  try { language = preferences?.language || localStorage.getItem('dubline_language'); } catch {}
  if (!messages[language]) language = 'en';
  let generation = 0;
  const missing = new Set();
  function t(key, params = {}) {
    const template = messages[language]?.[key] || messages.en[key] || key;
    if (template === key && !missing.has(key)) { missing.add(key); console.warn('[Dubline] Missing translation:', key); }
    return template.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? ('{' + name + '}'));
  }
  function languageName(code) {
    if (!code || code === 'und') return '';
    try { const name = new Intl.DisplayNames([language], { type: 'language' }).of(code); return name.charAt(0).toUpperCase() + name.slice(1); } catch { return code; }
  }
  function apply(root = document) {
    document.documentElement.lang = language;
    root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  }
  function activate(next) {
    language = next;
    try { localStorage.setItem('dubline_language', language); } catch {}
    preferences?.setLanguage?.(language).catch(() => {});
    apply(); window.dispatchEvent(new CustomEvent('dubline-language-changed', { detail: language }));
    return true;
  }
  function setLanguage(next) {
    const attempt = ++generation;
    if (!['en', 'ru', 'uk'].includes(next)) return Promise.resolve(false);
    if (messages[next]) return Promise.resolve(activate(next));
    return window.DublineLazyScripts.load('/locale/' + next + '.js').then(() => {
      if (attempt !== generation || !messages[next]) return false;
      return activate(next);
    }).catch(() => { if (attempt === generation) { apply(); window.dispatchEvent(new CustomEvent('dubline-language-changed', { detail: language })); } return false; });
  }
  window.DublineI18n = { t, apply, setLanguage, getLanguage: () => language, languageName, messages, missing };
  preferences?.setLanguage?.(language).catch(() => {});
})();
