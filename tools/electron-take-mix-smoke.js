// Reuse the real Single Player/save/open/Multiplayer smoke with clip settings enabled.
process.env.DUBLINE_NATIVE_CLIP_MIX_TEST = '1';
require('./electron-project-smoke');
