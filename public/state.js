(function initDublineState(global) {
  'use strict';

  const storage = global.localStorage;

  // Persistent device ID used by the server to restore nickname and host rights.
  function getClientId() {
    let id = storage.getItem('dubline_client_id');
    if (!id) {
      id = (global.crypto && global.crypto.randomUUID)
        ? global.crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      storage.setItem('dubline_client_id', id);
    }
    return id;
  }

  const storedAutoDuckAmount = parseFloat(storage.getItem('dubline_auto_duck_amount') ?? '0.4');
  const storedPrompterSize = parseInt(storage.getItem('dubline_prompter_size') || '20', 10);

  const data = {
    session: null,
    selectedLine: null,
    mediaRecorder: null,
    audioChunks: [],
    myName: storage.getItem('dubline_nick') || '',
    clientId: getClientId(),
    roomHost: null,
    hostOnline: false,
    discardTake: false,
    userMicGain: parseFloat(storage.getItem('dubline_mic_gain')) || 1.0,
    noiseSuppression: storage.getItem('dubline_noise_suppression') !== '0',
    autoDuckEnabled: storage.getItem('dubline_auto_duck') !== '0',
    autoDuckAmount: Number.isFinite(storedAutoDuckAmount)
      ? Math.max(0, Math.min(0.8, storedAutoDuckAmount))
      : 0.4,
    prompterEnabled: storage.getItem('dubline_prompter') !== '0',
    prompterSize: Number.isFinite(storedPrompterSize)
      ? Math.max(14, Math.min(36, storedPrompterSize))
      : 20,
    audioCtx: null,
    analyser: null,
    micStream: null,
    isVisualizerRunning: false,
    recordState: 'idle',
    recordStopTimeout: null,
    currentRecordingStartTime: 0,
    recordingLineId: null,
    renderInProgress: false,
    volumes: { original: 0.0, backing: 1.0, recorded: 1.0, isMuted: false }
  };

  // Transitional aliases keep inline handlers and the coordinator script compatible
  // while feature modules move to the explicit DublineState API one by one.
  Object.keys(data).forEach(key => {
    Object.defineProperty(global, key, {
      configurable: false,
      enumerable: false,
      get: () => data[key],
      set: value => { data[key] = value; }
    });
  });

  global.DublineState = Object.freeze({ data });
})(window);
