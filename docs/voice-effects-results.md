# Voice effect chains: implementation and validation

Baseline: `main` at `00369c2`. User changes in ARCHITECTURE.md, BEHAVIOR.md, TESTING.md and docs/regression-matrix.md are preserved and excluded from commits. No dependencies, licensing, installer, updater or network implementation was changed. The noise algorithm remains unchanged.

## Delivered behavior

- One shared role definition and individual ordered take chains; duplicate instances, independent amounts, enable/bypass, removal and pointer/keyboard reordering.
- Role/take pitch inheritance without summing; legacy explicit pitch and the single-stage Monster/old-effect renderer are preserved.
- Standalone bounded Echo with exact-delay finite taps and decaying repeats. Combined tail, heavy-stage and memory/job limits prevent unbounded configurations.
- Inspector summary is collapsed by default. Role editors also open from existing track labels before any recording; Edit/Dub inspectors use the same editor.
- Private uncached audition with A/B, looping, position-preserving buffer replacement and debounced cancellation. No microphone or project edits during audition. Blind Mode sample filtering is retained.
- Atomic revision/scene/identity-bound edits, author permissions for takes and moderator permissions for role definitions. Effect DTOs cannot overwrite unrelated take fields.
- Explicit bulk replace/append/clear/inheritance. Unchanged pitch, inheritance and exceptions are preserved per take; mixed settings are shown rather than invented. Role definitions are never copied into each take.
- Deep historical metadata, current-role inheritance on restoration, rename/merge policy and protected role-definition Undo/trash restoration. Audio identities, files, pins, retakes, trim, pan and volume survive.
- Shared processing/cache keys for playback, historical preview, video and stems. Export snapshots freeze effective role/individual configurations; waveform/timeline position and source files are unchanged.
- Portable schema 8, with versions 1–7 readable and the old single-effect adapter. Standard Voxalike pack format is unchanged.

Details and limits: [voice-effects.md](voice-effects.md), [project-format.md](project-format.md).

## Changed files

| Area | Files |
| --- | --- |
| Model/DSP/playback | public/voice-chain-model.js, public/audio-fx.js, public/audio.js |
| Inspector/editor/themes/locales | public/voice-chain-ui.js, public/voice-chain.css, public/index.html, public/ui.js, public/editor.js, public/player.js, public/locale/en.js, ru.js, uk.js |
| Scene authority/history | server/voiceChains.js, server/config.js, server/sessionScope.js, server/sockets/roles.js, server/sockets/editor.js, server/editHistory.js, server/rooms.js, server/parsers.js, server/takeHistory.js, public/take-history-model.js |
| Projects/exports | server/projects.js, public/export.js, public/video-export-ui.js |
| Tests/tools | voice-chain.test.js, e2e/voice-chain.e2e.js, tools/voice-chain-stress.js, tools/voice-chain-listening.js, tools/electron-noise-reduction-smoke.js, package.json |
| Existing fixture updates | e2e/noise-reduction.e2e.js, e2e/video-export.e2e.js, e2e/direct-media.e2e.js, e2e/workflow.e2e.js, e2e/ui-cleanup.e2e.js |
| Documentation | docs/project-format.md, docs/voice-effects.md, docs/voice-effects-results.md |

## Automated checks

Completed suite results are recorded below; logs are ignored under `audit/take-history/voice-*.log`.

| Check | Result |
| --- | --- |
| npm run check | PASS |
| npm test | 367 passed, no skips |
| node --test voice-chain.test.js e2e/voice-chain.e2e.js | 26 passed, no skips; 10 model/server/security/archive and 16 real-browser cases |
| npm run test:e2e | Final 464 passed across 37 suites, no failures or skips |
| npm run test:ui | Final 121 passed, no skips |
| npm run test:hardening | Final 56 passed, no skips |
| node --test voice-chain.test.js projects.test.js projects-stream.test.js | Final 53 passed, no skips; legacy formats, strict fields and streamed archives |
| npm run test:electron:chains | Final PASS: role/individual effects, noise-before-effects, native private preview, parity and format 8 |
| npm run test:electron:noise | PASS: calibration, private preview, Space, parity and schema 7 |
| npm run test:electron:take-mix | PASS |
| npm run test:electron:take-history | PASS |
| npm run test:electron:projects | PASS |
| npm run test:electron:ui | PASS: actual restart, inputs/outputs, locales, fullscreen and native sizes/zoom |
| npm run dist:win:unpacked + npm run test:electron | Final PASS: actual EXE, recording, mixer/stems, project/media retention, proxy/original stream copying and ZIP; archive/source equality verified for the chain model, UI and server |
| 25-minute/400-take stress | PASS: four role chains, three clients, four historical variants, noise bindings, full MP4 |
| Local voice listening examples | Prepared; subjective listening remains manual |

Development failures were corrected without weakening behavioral assertions: a closed native dialog inherited `display:flex`; inspector controls were too tall; Cancel used a nonexistent locale key; a test expected raw effect names without their existing icons. New tests were corrected to use the immutable selection Set and real/manual confirmation configuration. Empty-role clicks use Puppeteer's retrying Locator because scene redraws can detach an old element handle.

Existing fixture changes retain their purpose: direct-media tests await the preceding download's completion before clearing media; the minimap awaits initial geometry before manually setting scroll and keeps its original anchor tolerance. ADR compares one-second intervals within 1e-9 seconds rather than demanding exact binary floating-point subtraction. Explicit pitch test fixtures declare override mode; deliberately changed export snapshots recompute their frozen voice configuration. Source hash, waveform, codec and synchronization assertions remain intact.

## Stress measurements

`node tools/voice-chain-stress.js` creates owned temporary input: an actual 1500-second 128×72/2 FPS video, 400 synthetic 0.8-second main recordings, four historical variants and three live Chromium clients. Four shared role chains include Robot→Echo, Telephone→Cave, Monster→Echo and Thoughts→Radio; 100 takes add Telephone. Noise processing is active. A final cue near video end tests soundtrack truncation without extending video.

The final measured export took **28,403.6 ms**, produced **26,772,801 bytes**, and reported **1500.01 seconds** container duration (AAC packet padding); source video packets were identical. Every one of the 404 source recording hashes remained unchanged. Client configurations and PCM lengths matched; maximum individual sample difference was **4.54e-7**. An earlier stress run failed an energy-only absolute comparison without per-sample diagnostics, so that run's cause was not established. Final parity compares actual samples and configurations, a stronger sound-consistency check than aggregate energy alone; the measured small cross-render differences remain explicit.

Final raw/processed AudioBuffer cache residency was **57,012,480 / 143,060,400 bytes**, within 128/256 MiB limits. Sampled Chromium JS heap peaked at **344,690,739 bytes**. These are specific cache/heap measurements, not total browser/Electron peak RSS; native audio graphs, output Blob and temporary allocations are not fully represented. The small synthetic video establishes long-duration mixing and packet copying, not high-resolution custom-encoding throughput or subjective episode quality. No claim is made that all maximal chains have been load-tested on all devices.

Ignored artifacts: `audit/voice-chains/results.json`, `stress-output.mp4`, `listening/voice-N-dry.wav` and ordered-chain WAV examples. The listening examples read the previously authorized local voice copies; **no artificial noise is added**, and no raw voice enters Git or the server's project/take storage.

## Manual acceptance and remaining limits

Listen to the local comparisons and real microphones: whispers, endings, shouting, repeated Radio/Monster, different order, Echo feedback, Cave tails and level changes. Test role exceptions, recasting, pinned restoration, group edits and mixed playback/export in a real actor session. Check touch input, real system scaling, Safari/Firefox, maximum permitted chains, larger source containers and longer individual recordings. Live external Cloudflare/Porthole/VPN routes were not comprehensively tested in this pass.

Role identities remain names with explicit rename/Undo handling; merging keeps the destination definition rather than combining chains. Limits are eight stored entries per level/eight active combined, four heavy stages and 12 seconds of tails. Project manifest limits and existing media/cache budgets remain. Valid settings may still exceed a particular device's resources; errors are visible and source files remain available. Old single effects keep their sound; new multi-stage combinations use one final level correction and will naturally sound different. No release/tag is created.
