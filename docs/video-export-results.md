# Video export validation — 2026-10-13

Implementation baseline: `main` at `4d1be2c`. Existing uncommitted changes in
ARCHITECTURE.md, BEHAVIOR.md, TESTING.md and docs/regression-matrix.md were preserved.
No dependency update, project format change, release or tag was made.

## Changes

* `public/video-export-policy.js`: shared source bounds and size calculation.
* `public/video-export-audio.js`: bounded PCM windows, decoder pre-roll,
  continuous resampling and existing mix/FX/cache reuse.
* `public/video-export-engine.js`: packet-copy/custom encoding, streamed native
  output, real-time video/audio-only fallback and cancellation cleanup.
* `public/video-export-ui.js`, `video-export.css`, `index.html`, locales:
  three modes, actual metadata, disabled excessive choices, estimates, progress,
  native destination and completion controls. `ui.js`, `studio.js`, `action-help.js`
  now allow guest working-video export while retaining original restrictions.
* `public/export.js`: delegates video rendering to the common engine; stems,
  Voxalike packs and project save paths remain. `audio.js`/`audio-fx.js` optionally
  cancel export-owned requests while preserving requests shared with playback.
* `server/video-export-info.js`, `video-export-lease.js`, `video-export.js`:
  actual source inspection, authorized snapshot retention, host-only original
  copy/custom FFmpeg, compatible mixed AAC/Opus copy without a second lossy encode.
  `server.js`/`routes.js` include export shutdown and busy checks.
* `electron-video-export.js`, main/preloads: narrow owned tickets, native picker,
  bounded writes, protected app media folders, fsync/atomic replacement, expiry,
  reveal, destination-change and disk-error handling. `package.json` includes the
  new module and tests.
* New/updated regressions: `video-export.test.js`, `video-proxy.test.js`,
  `reliability.test.js`, `test/client-integrity.test.js`, `e2e/video-export.e2e.js`,
  `e2e/proxy.e2e.js`, `e2e/reliability.e2e.js`,
  `tools/electron-video-export-smoke.js`, `tools/electron-project-smoke.js`.

Old test updates preserve behavior checks: HTTP integration now sends its real
identity cookie and rejoins on reconnect; the HTML handler test includes the new
UI module in actual load order; native original tests select Original explicitly
and check the saved destination instead of waiting for a browser download event.

## Completed checks

| Command | Result |
|---|---|
| `npm run check` | Passed |
| `npm test` | 346 passed, 0 failed, 0 skipped |
| `npm run test:e2e` | 431 passed, 0 failed, 0 skipped |
| `npm run test:ui` | 88 passed, 0 failed, 0 skipped |
| `npm run test:hardening` | 56 passed, 0 failed, 0 skipped |
| Final export/proxy/reliability E2E profile | 35 passed, 0 failed |
| Final source/integrity/IPC unit profile | Passed |
| `npm run test:electron` | Packaged smoke passed |
| `npm run test:electron:ui` | Passed; production main/preload, 3 languages/window sizes, 150% scale |
| `npm run test:electron:guest` | Passed; packaged private-HTTP origin simulation |
| `npm run test:electron:hosting` | Passed; external services mocked |
| `npm run test:electron:projects` | Passed; Single Player/save/reopen/Multiplayer, original packet identity |
| `npm run test:electron:take-mix` | Passed; parameters and stereo export survive project reopen |
| `npm run test:electron:video-export` | Passed; native guest MP4/WebM, picker cancellation, actual streamed writes, cancellation preserving existing destination, tone, untrusted window/iframe rejection |
| `npm run dist:win:unpacked` | Local QA build passed; no publication |

Native smoke programs use assertions and do not expose a node:test case count.
Counts across overlapping suites should not be added as unique test cases.
Logs and private QA artifacts are ignored under `audit/` and `build/`.

## Measured performance

Same Windows environment, headless Chrome/software rendering, 1500-second
1280×720/25 FPS black video with audio, 420 synthetic active-take snapshots,
ten author identities and three read-only local voice samples. None/Telephone/
Radio/Behind Door, pitch, gain, panorama and ducking are included. Each run uses
a fresh browser. The fixture measures the pipeline, not a live ten-person room.
Source/original separation is tested separately in real manual-import E2E.

| Path | Elapsed | Largest offline PCM context | Sampled Chrome working-set peak |
|---|---:|---:|---:|
| Baseline `4d1be2c` | 148.84 s | 576,000,000 B | 2,094,866,432 B |
| Windowed | 45.29 s | 3,840,000 B | 1,438,183,424 B |
| Windowed repeat | 44.79 s | 3,840,000 B | 1,433,812,992 B |

Working set sums the benchmark browser's processes, sampled approximately once
a second; it is not a precise JavaScript heap or private-byte allocation metric.
All outputs were 1500 seconds and retained the source's encoded video packet hash.
The new output was 35,164,459 B; the baseline was 35,114,669 B. Different AAC encoder
settings/container layout can change total bytes while the video remains copied.
This browser benchmark still buffers the output; native disk streaming is verified
separately. No general speedup claim is made for arbitrary episodes/devices/codecs.

Short waveform comparisons kept the same strict tolerances: 44.1 kHz WAV maximum
sample difference 0.000318/RMS 0.0000166; AAC maximum 0.000237/RMS 0.0000178.
Both retained all 672,000 frames across two windows. The AAC regression initially
failed and identified missing negative-time decoder pre-roll; it was fixed without
loosening thresholds. These numeric tests do not replace listening.

## Remaining manual work

See [video-export.md](video-export.md) for the complete manual checklist. Actual
Firefox/Safari, external Cloudflare/Porthole/Radmin/Hamachi routing, real long
high-bitrate/HDR/rotated/VFR episodes, physical disk failures and human listening
remain unverified. Native HTTP/network tests model routing locally. User voice
inputs were neither modified nor uploaded/committed. Browser final-file buffering
remains a stated limitation. The application is ready for the next user session;
these automated results do not certify every device or network as stable.
