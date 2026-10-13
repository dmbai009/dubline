# Noise reduction implementation and validation

Baseline: `main` at `2cacdb4`. Baseline check and all 346 unit/server tests passed. User changes in ARCHITECTURE.md, BEHAVIOR.md, TESTING.md and docs/regression-matrix.md were preserved and excluded from commits. No dependencies, licenses, updater, installer, network architecture or timeline controls were changed.

## Delivered behavior

- Voluntary offer after microphone access; Skip/Escape/close persist the decision. Settings remain available later. Critical operations, other dialogs and active capture defer the offer.
- Six-second selected-microphone calibration, cancellation and quality checks. Capture uses the same browser processing flags and gain as recording. Recalibration preserves the previous profile until successful confirmation.
- Actor-wide strength slider, default 20%, A/B with position-preserving crossfade, looping, scratch phrase and lazy selection of authored main/historical takes. Preview bypasses DubLine effects and never sends edit operations.
- Explicit current-scene all/selected assignment and removal, independent of the scratch sample. Selection survives search; cancellation sends nothing. Captured IDs/revisions reject replacement races atomically.
- New take binding freezes at recorder start, including queued/offline uploads. Actual device/group, selected input, software gain and browser processing are checked locally. Strength zero bypasses DSP but retains an enabled capture's binding for later adjustment.
- A confirmed compatible local calibration and future-recording preferences carry into a fresh scene without another microphone capture or enrollment of existing takes. Initialization never replaces an existing scene's author settings or bindings.
- Profile binding follows take history/pins/restoration. Actor enable/strength is shared; profiles are immutable per version and retained conservatively. Author-only mutations use existing membership, scene checks, barriers, receipts and strict room persistence.
- Common `getProcessedTake()` cleans before pitch/effects. Playback, previews, stems and video soundtrack use that chain. Export snapshots freeze their noise settings. Unassigned recordings keep their original sound and ongoing playback when an author confirms settings.
- Project version 7 preserves profiles, bindings and common settings; versions 1–6 remain readable. Invalid or missing bindings fail save/import rather than being silently discarded. No original audio files are rewritten.

Implementation and known limits: [noise-reduction.md](noise-reduction.md), [project-format.md](project-format.md).

## Changed files

| Area | Files |
| --- | --- |
| DSP/model/worker | public/noise-model.js, public/noise-dsp.js, public/noise-audio.js, public/noise-worker.js |
| Settings/preview/locales | public/noise-ui.js, public/noise.css, public/index.html, public/locale/en.js, ru.js, uk.js |
| Capture/history/playback/export | public/audio-devices.js, public/recording.js, public/take-history-model.js, public/audio.js, public/room.js, public/export.js, public/video-export-ui.js |
| Shared state/security/projects | server/noiseReduction.js, server/parsers.js, server/rooms.js, server/projects.js, server/routes.js, server/sessionScope.js, server/sockets/roles.js, server/sockets/room.js |
| Tests/tools | noise-reduction.test.js, e2e/noise-reduction.e2e.js, e2e/helpers.js, tools/electron-noise-reduction-smoke.js, tools/electron-ui-cleanup-smoke.js, tools/noise-reduction-benchmark.js, package.json |
| Documentation | docs/project-format.md, docs/noise-reduction.md, docs/noise-reduction-results.md |

## Automated checks

| Command | Result |
| --- | --- |
| npm run check | PASS |
| npm test | 357 passed, 0 failed/skipped |
| npm run test:e2e | 446 passed, 0 failed/skipped; contained 15 profile scenarios before the additional MP4-output and future-scene initialization tests |
| node --test e2e/noise-reduction.e2e.js | Final 17 passed, 0 failed/skipped, including actual project reopening, MP4 output and future-scene initialization |
| npm run test:ui | 102 passed, 0 failed/skipped; later edge cases covered by the final profile/native runs |
| npm run test:hardening | Final 56 passed, 0 failed/skipped |
| node --test noise-reduction.test.js projects.test.js projects-stream.test.js | 54 passed, 0 failed/skipped; includes invalid-binding save refusal, legacy/streamed archives |
| npm run test:electron:noise | PASS: production Guest, calibration, zero preparation, Space, private A/B, host sample/energy parity, version-7 project |
| npm run test:electron:ui | Final PASS: production main/preload, actual restart, microphone/output selection, RU/EN/UK, window sizes and 150% zoom |
| npm run test:electron:projects | PASS: Single Player/save/close/open/Multiplayer |
| npm run test:electron:take-mix | PASS: persisted clip mixing and stereo exports |
| npm run test:electron:take-history | PASS: history/pins/portable reopen |
| npm run test:electron:guest | PASS: PIN/nickname, private HTTP policy, media and fake-device recording; routing simulated |
| npm run dist:win:unpacked + npm run test:electron | PASS: rebuilt EXE, recording, shared editor/Undo, Blind Mode, project/media retention, stems, proxy/original mux and ZIP |
| git diff --check | PASS |

The initial hardening/full E2E runs failed the existing canonical-slider-reset assertion: the new slider was missing reset metadata. Production reset metadata was added; no expectation was relaxed. The initial native UI run was blocked by the new voluntary offer, so that existing workflow now explicitly clicks Skip. Calibration has its own production native test. Earlier new-fixture failures (four-line import assumptions, array-index assumptions in a 420-cue scene, missing snapshot barrier/room field, Blob return shape) were corrected while retaining their behavioral assertions.

Windows sandbox ACL/login failures were environment failures; native tests and protected writes were rerun with approved access. Skipped checks are not reported as passes. Physical microphones, Safari/Firefox devices, external tunnels/VPN and subjective listening remain manual. No release/tag was created.

## Measurements

Reproducible Node v24.21.0 / 48 kHz DSP run: 400 synthetic takes of 1.5 seconds each (600 seconds of PCM) at 20% processed in **5803.194 ms**. One take took **14.142 ms**. Sampled ArrayBuffer usage before/peak/after the 400-take loop was **10,486,755 / 11,091,451 / 10,486,755 bytes**. These are between-iteration ArrayBuffer samples, not whole-process peak RSS or a browser/Electron episode benchmark. The 420-cue browser scenario includes 100+ authored takes, two live participants, raw-file hash checks and proof that bulk assignment does not schedule DSP for every file.

Three local voices were read without modifying or uploading their originals. Known synthetic white noise was added; the calibration uses that same noise, not the original room background. RMS error against the saved voice at 20% changed as follows:

| Sample | Added-noise RMS | Processed error RMS |
| --- | --- | --- |
| voice-1 | 0.0034625 | 0.0025692 |
| voice-2 | 0.0034641 | 0.0028875 |
| voice-3 | 0.0034619 | 0.0025209 |

Output sample counts were unchanged. Stronger settings were also generated; improvement was not monotonic for every voice, so these numbers are not a perceptual quality claim. The comparisons found a real edge case with decoded peaks already above 0 dBFS; DSP now limits only additional peak overshoot rather than globally lowering such an input.

Ignored local artifacts: `audit/noise-reduction/results.json`, `voice-N-original.wav`, `voice-N-noisy.wav`, `voice-N-clean-20/50/100.wav`, `noise-light-ru.png`. Test logs are under `audit/take-history/noise-*.log`. Only metadata/results documentation and reproducible tools enter Git.

## Remaining acceptance

Listen to the local comparisons, then calibrate real microphones with fan/hum and browser suppression on/off. Check quiet consonants, whispers, shouting, all effects and tails. Repeat calibration after changing room/device/gain and verify older pinned/historical takes. Run a real group episode and compare playback with video/WAV output, including long exports. Stationarity checks are not guaranteed speech detection; aggressive suppression can still color speech. No claim is made that real Cloudflare, Porthole, Hamachi or Radmin routes were fully tested. A profile limit of 64 and a decoded-take noise-processing bound of 32 MiB remain documented; unsupported/oversized processing warns and uses the source with existing effects.
