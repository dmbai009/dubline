const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('public/index.html', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');

test('every inline HTML handler has a client implementation', () => {
  const handlers = [...html.matchAll(/on(?:click|change|input|submit)\s*=\s*["']\s*([A-Za-z_$][\w$]*)/g)].map(match => match[1]);
  for (const name of new Set(handlers)) {
    const definition = new RegExp(`(?:function\\s+${name}\\s*\\(|window\\.${name}\\s*=)`);
    assert.match(app, definition, `${name} is referenced by HTML but not implemented`);
  }
});

test('static DOM references exist and legacy modal IDs are gone', () => {
  const dynamicIds = new Set(['gainDisplay', 'pitchVal', 'recBtn', 'visualizerCanvas']);
  const ids = [...app.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
  for (const id of new Set(ids)) {
    if (dynamicIds.has(id)) continue;
    assert.match(html, new RegExp(`id=["']${id}["']`), `#${id} is referenced by JS but absent from HTML`);
  }
  for (const legacy of ['nickInput', 'libraryModal', 'renderModal']) assert.doesNotMatch(app, new RegExp(`getElementById\\(['"]${legacy}`));
});

test('all interface translation keys exist in English, Russian and Ukrainian', () => {
  const context = {
    window: { dispatchEvent() {} },
    document: { documentElement: {}, querySelectorAll: () => [] },
    navigator: { language: 'en' },
    localStorage: { getItem: () => null, setItem() {} },
    CustomEvent: function CustomEvent() {}
  };
  vm.runInNewContext(fs.readFileSync('public/i18n.js', 'utf8'), context);
  const { messages } = context.window.DublineI18n;
  const markupKeys = [...html.matchAll(/data-i18n(?:-placeholder|-title)?=["']([^"']+)["']/g)].map(match => match[1]);
  const appKeys = [...app.matchAll(/\bt\(['`]([^'`${}]+)['`]/g)].map(match => match[1]);
  const serverKeys = [...server.matchAll(/addSystemMessage\([^,]+,\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
  const dynamicKeys = ['effect.none', 'effect.robot', 'effect.radio', 'effect.monster',
    'effect.thoughts', 'effect.cave', 'effect.behindDoor', 'effect.megaphone'];
  for (const key of new Set([...markupKeys, ...appKeys, ...serverKeys, ...dynamicKeys])) {
    for (const language of ['en', 'ru', 'uk']) assert.ok(messages[language][key], `${language}.${key} is missing`);
  }
  const englishKeys = Object.keys(messages.en).sort();
  assert.deepEqual(Object.keys(messages.ru).sort(), englishKeys);
  assert.deepEqual(Object.keys(messages.uk).sort(), englishKeys);
});

test('client and server expose the same non-destructive voice effects', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync('public/audio-fx.js', 'utf8'), context);
  const clientEffects = Object.keys(context.window.DublineAudioFx.VOICE_EFFECTS).sort();
  const whitelist = server.match(/const VOICE_EFFECTS = \[([^\]]+)\]/);
  assert.ok(whitelist, 'server effect whitelist is missing');
  const serverEffects = [...whitelist[1].matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]).sort();
  assert.deepEqual(clientEffects, serverEffects);
  assert.ok(context.window.DublineAudioFx.effectTailSeconds('behindDoor') > 0);
  assert.ok(context.window.DublineAudioFx.effectTailSeconds('thoughts') >= 0.5);
  assert.ok(context.window.DublineAudioFx.effectTailSeconds('cave') >= 1.5);
});
