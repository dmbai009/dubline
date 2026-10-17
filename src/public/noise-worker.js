import { processPCM } from './rnnoise-dsp.mjs';
let busy = false;
self.onmessage = async ({ data }) => {
  if (busy) return;
  busy = true;
  try {
    const result = await processPCM(data.channels, data.sampleRate);
    self.postMessage({ id: data.id, result }, result.channels.map(channel => channel.buffer));
  } catch (error) { self.postMessage({ id: data.id, error: error.message }); }
  finally { busy = false; }
};
