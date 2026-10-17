importScripts('/speech-model.js');
self.onmessage = ({ data }) => {
  try { const start = performance.now(), result = DublineSpeechModel[data.kind](data.channels, data.rate, data.bounds); self.postMessage({ id: data.id, result, milliseconds: performance.now() - start }); }
  catch (error) { self.postMessage({ id: data.id, error: error.message }); }
};
