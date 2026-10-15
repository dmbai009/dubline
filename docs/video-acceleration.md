# Personal video acceleration

Personal settings → Interface → Hardware acceleration stores `auto`, `on` or
`off` under `dubline_video_acceleration` in local storage. The default is auto.
The choice follows the device's existing settings origin across rooms and is
captured when a new operation starts. It is not a room/session field, socket
mutation or portable-project setting.

Auto prefers GPU video processing for jobs at least 30 seconds long and at least
640×360; smaller jobs avoid hardware initialization. On requests hardware even
for small jobs. Off requests software encoders and decoders. These preferences
apply to custom video export, including host-side original-video transcoding,
and to optimized/compatible working copies during scene creation. Stream copy,
audio processing, RNNoise and ordinary playback retain their existing paths.

## Native video processing

FFmpeg enumerates encoders and actually encodes two test frames before selecting
NVENC, QSV, AMF or VideoToolbox. Probe results are cached for ten minutes. A failed
hardware encode restarts its private staged output once with libx264; cancellation
never retries. Unknown preference strings cannot inject encoder names or options.
Native acceleration targets H.264; the existing FFmpeg VP9 path remains software.
Video bounds, working-copy byte limits, timing checks, original-media retention
and audio extraction remain in the existing import/export transaction. Working
copies keep the existing CPU scaling step and accelerate video encoding.

## Browser and desktop exports

WebCodecs selects supported encoder/decoder configurations using hardware or
software preferences; a rejected hardware probe still tries software. These are
[browser preferences, not a guarantee of a specific GPU](https://www.w3.org/TR/webcodecs/#hardware-acceleration).
An encoder/decoder failure in the custom GPU path permits one software retry.
Desktop retry resets only the owner's scene-bound temporary file, preserving
the approved destination and its original bytes until atomic commit. A shorter
retry truncates the old partial tail. Progress restarts for that attempt while
retaining elapsed time. Server progress keeps the exporter/request/scene boundary.

Off does not silently fall back to video MediaRecorder, which cannot select a
software encoder. Its audio-only fallback remains available. Older desktop shells
without the temporary-file reset API use software for custom export.

FFmpeg options follow its [encoder documentation](https://ffmpeg.org/ffmpeg-codecs.html).
The implementation adds no room permissions, playback processing, audio settings
or project-format changes. GPU speed depends on the codec, driver and job; stream
copy does not need video encoding and audio-heavy exports may still be CPU-bound.

## Verification (2026-10-15)

- Syntax checks and all 444 unit/server tests pass. New cases cover local settings,
  policy decisions, driver probes, bounded CPU retry, cancellation, progress reset
  and ownership/scene checks when truncating a private temporary output.
- All 27 affected browser scenarios pass: personal settings across reloads/rooms,
  isolated guests, real CPU-only export, simulated GPU failure and CPU completion,
  unchanged stream-copy packets, compatible scene creation, original-video export,
  permissions, cancellation and exact processed-audio hashes.
- The source Electron native export smoke passes, including a simulated late GPU
  failure after real output has been written, followed by a playable CPU retry.
- A physical h264_nvenc probe and two-second 1280x720 encode succeed on the local
  NVIDIA device. Intel/AMD hardware was not available for physical validation.
- Playwright captures 20 settings states across six themes, EN/RU/UK and narrow
  150% layouts. Layout assertions pass; representative light/dark and narrow
  captures were visually inspected.

Commands: `npm run check`; `npm test`;
`node --test --test-concurrency=1 e2e/video-acceleration.e2e.js e2e/video-export.e2e.js e2e/proxy.e2e.js e2e/export-progress.e2e.js`;
`node tools/electron-video-export-smoke.js`; `npm run qa:acceleration`.
The packaged win-unpacked application was not rebuilt for this change.
