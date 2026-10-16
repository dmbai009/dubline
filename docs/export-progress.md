# Video export progress and bounded preparation

Current implementation, 2026-10-15.

## Visible progress

The old coarse weighted bar is replaced visually by independent phase meters. The legacy callback/DOM hook remains compatible with existing export callers. Preparation counts completed audible recordings, excluding muted clips and muted Dub. Audio and video show completed timeline duration; desktop writes show acknowledged output bytes. The fast path explicitly says that video is copied without re-encoding. Opening/checking phases are indeterminate until they complete and then leave the compact view. Finalization is separate from recording preparation and stream processing. Browser output says prepared for download, since the app cannot observe the browser download manager completing its disk write.

Elapsed time and last actual advancement are independent. A one-second UI heartbeat never advances completed counters or resets the quiet clock. After 15 seconds without new work data, the interface says the current operation has not reported completion, with cancellation available. It does not claim that an unresponsive worker has definitely crashed or that an elapsed timer proves processing is advancing. Native destination selection is treated as waiting for the user. Cancellation and errors stop indeterminate meters and never present a successful final result. Initial file checks can also be cancelled.

For host-side source-video assembly, the prepared soundtrack upload uses the existing metered XHR transport with an optional upload progress callback. Existing cookie authorization, multipart validation and abort behavior remain. FFmpeg's real output timestamps are sent only to sockets belonging to the authenticated exporting actor, with the captured scene and random export-request identity. Guests never receive these events; unrelated/stale events cannot update the active UI. No project/preset schema or persistent state changes.

## Preparation concurrency

Only two existing decoding/offline-render pipelines run together. The RNNoise worker and its queue/memory bounds remain unchanged. Each bounded batch drains before the next; failure starts no later batch. Input order, trims, pan/gain, effects, sample alignment, limiter/ducking and the original audio bytes remain unchanged. Preparation retains metadata, not scene-length PCM. Existing raw/processed cache limits and windowed eight-second mixing remain.

A cold 24-recording benchmark alternates concurrency 1 and 2 over three repetitions, with identical generated speech, effects and pitch. The final local medians were:

| Configuration | One pipeline | Two pipelines | Preparation time reduction |
| --- | ---: | ---: | ---: |
| Effects, RNNoise off | 1079.3 ms | 720.6 ms | 33.2% |
| Effects, RNNoise on | 4180.6 ms | 3589.1 ms | 14.1% |

Processed PCM SHA-256 hashes match exactly across configurations. These are preparation measurements on the test machine, not a promised reduction for every complete export. RNNoise still serializes its own CPU worker jobs; WebCodecs, audio decoding and OfflineAudioContext use their existing browser/native execution paths.

## Verification

### Cold PCM regression fixture (2026-10-16)

The cold sequential/parallel hash comparison now uses Radio and Telephone with
the same pitch/RNNoise matrix and exact SHA-256 equality. Chrome's native
ConvolverNode can produce different Cave PCM on independent renders, without
export or any preparation batching: an isolated repeated-render probe reproduced
four variants within 112 renders, with a maximum sample difference of 0.022.
This is larger than rounding noise; it remains a separate audio-engine finding.
No production DSP, effects or recording data changed in this test maintenance.

A separate Cave regression checks both batch widths against the exact cached
processed buffer, its hash and its reverb-tail length. This verifies preparation
does not alter or replace convolved audio without treating independent native
convolver renders as a deterministic hash oracle. The timing table above records
the earlier fixture and is not a new benchmark for the changed fixture.

- Syntax check PASS; all 429 unit/server tests PASS.
- Seven new unit cases cover genuine advancement versus heartbeat, waiting in the picker, interleaved monotonic counters, muted/zero inputs, two-job bounds, order, failure draining and cancellation.
- All 28 affected real-browser scenarios PASS (export-progress, video-export, workflow-next). They cover the real exported video packet hashes, windowed audio versus full mix, MP4/WebM/custom output, real-time fallback, errors/cancellation, permissions, host-only progress delivery, stale request isolation and exact PCM equality.
- The production Electron guest export smoke PASS: native picker/cancel, actual MP4/WebM files, bounded IPC streaming, byte-count meter equality with the saved file, completion signal and preservation of a previous destination on cancellation.
- Playwright captures 26 images from an actual export held after the first completed audio window (8/12 seconds), across all six themes, EN/RU/UK, narrow/150% layouts, the quiet-warning state and cancellation. Local results: audit/export-progress/visual-results.json. Representative final images were visually inspected.
- Commands: npm run check; npm test; node --test --test-concurrency=1 e2e/export-progress.e2e.js e2e/video-export.e2e.js e2e/workflow-next.e2e.js; node tools/electron-video-export-smoke.js; npm run qa:export-progress.
