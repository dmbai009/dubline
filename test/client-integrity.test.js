const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('public/index.html', 'utf8');
const CLIENT_MODULES = ['player.js', 'recording.js', 'import.js', 'export.js', 'room.js', 'chat.js', 'ui.js'];
const app = CLIENT_MODULES.map(name => fs.readFileSync(`public/${name}`, 'utf8')).join('\n');
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

test('client modules load in dependency order', () => {
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(match => match[1]);
  const positions = ['i18n.js', 'state.js', 'audio-fx.js', 'audio.js', ...CLIENT_MODULES].map(name => scripts.indexOf(name));
  assert.ok(positions.every(position => position >= 0), 'a required client module is missing');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test('state module owns persisted settings and compatibility aliases', () => {
  const values = new Map([
    ['dubline_nick', 'Mira'],
    ['dubline_auto_duck_amount', '0.65'],
    ['dubline_prompter_size', '28']
  ]);
  const context = {
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value)
    },
    crypto: { randomUUID: () => 'client-test-id' }
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync('public/state.js', 'utf8'), context);
  assert.equal(context.DublineState.data.myName, 'Mira');
  assert.equal(context.DublineState.data.clientId, 'client-test-id');
  assert.equal(context.DublineState.data.autoDuckAmount, 0.65);
  context.session = { loaded: true };
  assert.equal(context.DublineState.data.session.loaded, true);
});

test('audio module exposes bounded take timing without leaking playback internals', () => {
  const context = {
    window: {
      DublineAudioFx: {
        effectTailSeconds: effect => effect === 'cave' ? 2 : 0,
        fetchAndDecode: async () => null,
        renderVoice: async buffer => buffer
      }
    },
    console,
    setTimeout,
    clearTimeout,
    Audio: function Audio() {}
  };
  vm.runInNewContext(fs.readFileSync('public/audio.js', 'utf8'), context);
  const controller = context.window.DublineAudio.createController({
    video: { volume: 1 },
    backing: { volume: 1 },
    getSession: () => null,
    getVolumes: () => ({ original: 0, backing: 1, recorded: 1, isMuted: false }),
    getSettings: () => ({ autoDuckEnabled: true, autoDuckAmount: 0.4 }),
    isRenderInProgress: () => false,
    getRecordingLineId: () => null
  });
  assert.deepEqual(
    { ...controller.takeBounds({ effect: 'cave', trimStart: 1, trimEnd: 3 }, 8) },
    { from: 1, to: 5 }
  );
  assert.equal(context.window.rawTakeCache, undefined);
  assert.equal(context.window.playCtx, undefined);
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
