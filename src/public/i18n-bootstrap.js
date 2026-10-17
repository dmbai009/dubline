// Parser-ordered, same-host packs keep the core synchronous on initial entry.
(() => {
  let language = 'en';
  try { language = (window.dublinePreferences || window.dublineDesktop)?.language || localStorage.getItem('dubline_language') || 'en'; } catch { /* private storage */ }
  if (!['en', 'ru', 'uk'].includes(language)) language = 'en';
  document.write('<script src="locale/en.js"></script>' + (language === 'en' ? '' : '<script src="locale/' + language + '.js"></script>'));
})();
