# RNNoise integration report

Implementation date: 2026-10-14. DubLine integration is based on main at 071c99e. Existing local documentation notes were preserved outside this change. The existing DubLine license and version 1.4.0 remain intact.

## Completed replacement

The old runtime STFT/Wiener DSP, spectral power profiles, six-second calibration, microphone-signature checks, calibration offer, scratch microphone recording, per-take profile assignment and selection/bulk enrollment UI were removed. Recordings/uploads/history no longer carry noiseProfileId. The only legacy profile code left is bounded read-only validation and migration for old projects. Obsolete local profile/offer preferences are removed. The later effect-workspace update removes the browser-processing preference and explicitly disables noiseSuppression, echoCancellation and autoGainControl for every microphone request; RNNoise remains postprocessing.

Only RNNoise is integrated; DeepFilterNet3, GTCRN and external model/archive setup are absent. The exact @shiguredo/rnnoise-wasm 2025.1.5 bundle is installed, hash checked and copied locally by tools/vendor-rnnoise.js. The same bundle and model are used in NoiseLab 0.3.0. Its SHA-256 is e6958293a0118bf9860cb2753332f7562531cc987c914552c426cd7d7180a63e. The official default model archive identifier is 0a8755f8e2d834eff6a54714ecc7d75f9932e845df35f8b59bc52a7cfe6e8b37.

## Integration points and signal order

public/noise-model.js supplies one shared server/browser schema and author resolution. server/noiseReduction.js validates authenticated author updates, persists before acknowledgement/broadcast, rolls back failures and enforces client engine compatibility. public/noise-audio.js owns the reusable module Worker and bounded priority queue. public/noise-worker.js invokes public/rnnoise-dsp.mjs; public/rnnoise-resample.mjs adapts NoiseLab's resampling.

public/audio.js integrates full Wet caching and the blend before existing processing. Timeline playback, Inspector/take-history previews, watch/listener playback, audio/stems and both video export paths converge on this processed-take path. public/export.js freezes confirmed noise/voice settings and refuses a missing neural result rather than exporting untreated audio silently. Shared successful work still survives cancellation of an export consumer when ordinary playback needs it.

The order is decoded original → RNNoise Wet → intensity mix → effective pitch → role and individual voice effects → existing effect level correction → existing trim/clip volume/pan/project mix and monitoring. Noise processing never writes a take file or adds normalization. Full source context is processed before trim, and voice chains retain their previous order, tails, inheritance and pitch rules.

## Delay, frames and model equivalence

The native model consumes 48 kHz, 480-sample float frames in PCM-16 magnitude (×32768 and inverse). Stereo uses two independent denoiser states. Each job starts fresh and destroys all states in finally. Incomplete frames are zero padded; the adapter flushes the neural tail and resampler support, drops the 960-sample/20 ms model delay and returns exactly the source sample rate, channels and frame count. Other rates use the same symmetric 64-tap Blackman sinc, 1024 phases and 0.94 cutoff used in NoiseLab.

Actual browser tests cover 1/99/1001/48091 samples at 44.1/48 kHz, stereo silence isolation, finite output, unchanged input and repeated fresh-state results. Separate delayed-identity fixtures check alignment, cancellation and state destruction; these fixtures are not neural-quality evidence.

For the local 508591-sample / 10.59565-second / 48 kHz speech reference, an independent direct loop over the real upstream processFrame API scales samples, pads/flushes frames and removes 960 samples. Maximum absolute difference against DubLine Wet was exactly 0. This establishes actual model invocation and matching frame/delay semantics at 48 kHz; it does not establish naturalness on every microphone.

## Strength and caches

Default intensity is 0.6, with migrated/new author defaults disabled. Enabled strength zero also bypasses the network, including explicit export settings on a cold source. A blend is precisely dry × (1−s) + wet × s; 100% is full RNNoise. No intensity-dependent model task, AGC or post-noise normalization is introduced.

Raw retains the existing 128 MiB cache. Wet and final variants share the existing 256 MiB processed budget, including an all-pinned eviction path that drops cache references while active audio sources retain their own buffers. Wet keys contain source URL/immutable identity, engine/model/DSP version, rate, channels and length. Strength, trim and FX only affect final keys. Volume/pan remain output node parameters. Source invalidation purges Raw/Wet/final entries and guards in-flight stale publication.

One Worker processes one job at a time. Waiting queue limit: 16; per-task decoded input: 32 MiB; aggregate queued/in-flight input: 64 MiB; execution timeout: 60 seconds. Preview/playback precede export/prefetch. Consumers deduplicate and promote existing work. Late cancelled replies cannot finish replacement jobs. Private slider cancellation drops its consumer, retaining useful shared Wet. Scene changes cancel queued stale work.

No bulk preprocessing runs on a settings commit. Only affected author final variants are invalidated; currently playing sources continue. Playback failure falls back to original plus FX with a throttled warning. Failed Wet/final work is evicted for retry, and strict preview/export consumers cannot accept another consumer's fallback as successful processing.

## Author settings and migration

Settings belong to recordedBy in the current scene, independently of role claims. They apply to current/new/history/pinned/restored takes; host/moderator status does not permit editing another author's setting. Renames move actor settings while existing author migration updates take metadata.

Scene schema 2 includes engine rnnoise, engineVersion 2025.1.5, pinned modelVersion, dspVersion 1, actors and a runtime revision. Each actor contains exactly enabled and finite strength in 0–1. Unsupported versions/metadata, extra actor fields, legacy mutation fields and invalid/oversized dictionaries are rejected.

Portable readers accept formats 1–9. Legacy 7/8 profiles/references undergo strict bounded validation before extraction, then migrate to disabled RNNoise/60%. Profile state and take bindings are removed while original asset bytes, recordedBy, history, IDs, pins, trim, alignment and effects remain intact. On-disk rooms, inactive sessions and trash migrate idempotently. Format 9 is written when any RNNoise author entry exists; scenes without entries retain the lowest applicable format. Format 9 excludes runtime revisions/receipts, local drafts, model files and derived PCM. Existing chain/history schemas remain validated.

## UI drafts and server consistency

My Settings → Audio has a compact switch, full-width strength slider, own-recording preview, Next and With effects. No microphone setup dialog is required. Preview is disabled without an own recording, while settings remain usable. Initial audition randomly selects an accessible current/historical own take, keeps it until Next/close, and attempts other candidates if a file is missing. Next selects a different candidate when available. Slider/effect audition preserves position with a 30 ms fade and never seeks the scene video or changes shared settings.

Drafts are scoped by room/scene/nickname. Normal close, Escape, category/tab changes and normal scene switching await one immutable noise_update operation. An unchanged draft emits nothing. Strict room flush precedes noise_updated and ACK. Failure preserves confirmed settings and the draft with Retry. Lost ACK retries the same operation ID and queries editor_operation_status; unresolved outcomes prevent a new blind mutation. Another author can update independently, while a changed own baseline prompts conflict review. Unexpected disconnect/page close/remote scene change never publishes an old draft into another scope.

The existing snapshot barrier freezes noise_update and voice_update alongside editor mutations. Export uses confirmed immutable settings; private audition drafts are excluded. Clients with an incompatible noise processing version cannot join an actively processed scene, and enabling noise with incompatible current participants is refused explicitly.

## Validation

| Check | Result |
| --- | --- |
| npm run check | PASS |
| npm test | 373/373, no skips |
| Dedicated real RNNoise browser suite | 17/17, no skips |
| npm run test:hardening | 56/56, no skips |
| npm run test:ui | 118/118, no skips |
| npm run test:e2e | 463/463, no skips; final additional preview edge cases also pass the dedicated 17/17 suite |
| Electron noise / voice chains / UI / projects / video export | All five PASS |
| Packaged EXE | Actual RNNoise stereo, PIN guest, recording/Undo, project save/open, source/proxy and video mux PASS |
| 400-recording / ten-author / 25-minute export stress | PASS; final measurements below |
| Local six-strength speech WAVs and direct model comparison | PASS; maximum difference 0 |

Important failure coverage includes disk-write refusal/rollback/draft retry, duplicate operations/lost ACK status lookup, author forging, invalid models/profile payloads, original-byte persistence/restart, modern and legacy project validation, shared Wet under intensity/FX changes, stale source deletion, cancellation/late Worker replies, exact zero bypass, neural failure retry and refusal of silent dry export. Six themes, EN/RU/UK and narrow/150% settings plus production native scale/output/capture are covered.

During implementation, full unit verification caught an export cancellation regression in shared processing; it was corrected and tested. The first complete browser run passed 460/461 and caught a pending preview source being evicted on a mix-only update. The source guard now retains the explicit updated take as well as scene/history references; the entire take-mix suite passed 14/14 after repair, and a focused unit regression was added. The final complete browser rerun passed 463/463. Additional preview tests then found and fixed stale intensity during first preparation and a debounced refresh restarting a paused audition; the dedicated suite passed 17/17 after these fixes. Stable samples now refresh their current take/effect metadata for subsequent audition without changing source identity. A UI remark/Undo scenario failed once during concurrent broader test load; its standalone repeat passed. The shared recording helper was hardened to wait for a genuinely new source and completed pending submission, followed by another full UI run. Earlier probe failures were test-harness issues (hidden switch input, lost-ACK timer simulation and wrong helper arguments), not substituted DSP results. Chrome/Electron audio decoding and effect output can differ slightly; native comparisons record per-sample RMS/max tolerances rather than claiming bit identity between those distinct decoders.

Only temporary isolated projects and fake/synthetic input were used in automated recording/export tests. Existing data/rooms.json and user uploads were not used as mutable fixtures. Local audition voices, screenshots, large stress video and detailed logs remain ignored under audit/rnnoise and were not uploaded or committed.

## Measured resource and timing results

Measured on the local Windows 10 build 19045 machine with Ryzen 7 5700X (8 cores / 16 threads), Node 24.21.0 and Electron 44.5.0. Chrome 156.0.8078.12 and 31.92 GiB physical RAM were used. Other automated browsers ran concurrently; these are observed timings, not a universal hardware guarantee. Tests use ten actual connected browser authors, 40 current recordings each plus one historical recording each, with four role-effect pair types across ten roles and an additional own Telephone stage for the host.

| Measurement | Final observation |
| --- | --- |
| Typical 0.8 s mono, decoded at 44.1 kHz, first model use | 113–159 ms model load; 0.4–0.5 ms state creation; 95–112 ms native neural calls; 264–341 ms total Worker job |
| Typical warm 0.8 s mono | Model already loaded; 0.1 ms state; 82.5 ms neural calls; 99.5 ms frame/resampling/scaling computation; 121.7 ms total |
| 60 s stereo, 48 kHz | 63.2 ms input validation; warm model; 0.3 ms for two states; 11.787 s neural calls; 12.982 s total Worker processing / 13.061 s including transfer and AudioBuffer creation |
| Five strength variants of an existing Wet source, with FX | 193 ms total final variant processing; zero additional RNNoise runs |
| Accumulated Dry/Wet arithmetic in the export client | 40.8 ms across the measured strength/seek/export processing; separate from FX time |
| 400 current takes + 10 historical originals uploaded | 45.164 s, original files retain identical SHA-256 |
| Actual encoded export, 1500 s video | 72.010 s; 26,969,800-byte MP4; output duration 1500.01 s; video packets identical |
| Neural work in export client | 400 distinct cached Wet sources + one uncached 60 s stereo probe; 401 successful jobs; zero fallback |
| Raw / combined Wet+final cache at export completion | 57,859,200 / 204,835,680 bytes, below 128 / 256 MiB limits |
| Queue/input peak | Three waiting jobs; 23,040,000 input bytes; queue drained to zero |
| WASM heap after cold/long/all export jobs | 20,578,304 bytes (19.625 MiB), stable in recorded endpoints |
| Sampled browser JS heap peak | 412,432,436 bytes (~393 MiB); includes existing renderer/export overhead and is not process RSS |
| Three listener processed-PCM comparisons | Maximum differences 4.58e−7 / 3.41e−7 |

The stress script checks all 400 frozen export takes have RNNoise enabled at 60%, at least 400 actual completed neural jobs, original hashes and encoded video hashes. It also issues 80 rapid seeks while preserving the bounded four-job lookahead. Heap samples are taken at export progress intervals; an unsampled instantaneous peak can be higher. Cache accounting counts buffer references conservatively and does not promise that complete process RSS equals cache budgets.

The genuine 10.59565 s speech probe recorded 27.3 ms validation, 546.9 ms cold initialization, 0.6 ms state creation, 2245.7 ms native neural calls, 2316.4 ms frame computation and 3131.2 ms total during concurrent QA. Maximum difference from independent direct model frames remained 0. The earlier less-loaded run of the same probe took 1253.7 ms total, illustrating load sensitivity. Metrics distinguish validation, model loading, state creation, native calls, frame computation (also input resampling/scaling) and full processing. Export wall time includes decoding, existing FX, mix and mux; it must not be labelled pure RNNoise time.

## Licenses and distribution

RNNoise code: Xiph BSD-3-Clause. Wrapper: Apache-2.0. NoiseLab resampling/pipeline adaptation: MIT. Full notices and provenance are in resources/licenses/rnnoise and THIRD_PARTY_NOTICES; the packaging hook places them in readable resources/licenses/third-party/rnnoise. The ASAR contains the exact pinned public vendor bundle and both DSP modules; its bundle hash was verified after packaging. No CDN or separate model fetch is used.

The published model archive does not contain a separate explicit weight-license grant. Treating these weights as covered by the upstream RNNoise repository license remains an inference; this report does not claim independently verified unrestricted commercial rights for weights/training data. Clarify the pinned model's commercial redistribution scope before a commercial release. [Xiph source/license](https://github.com/xiph/rnnoise), [wrapper source](https://github.com/shiguredo/rnnoise-wasm/tree/2025.1.5), [NoiseLab](https://github.com/dmbai009/noiselab).

## Remaining manual acceptance

Listen on physical microphones to speech with fan/hum, room noise, keyboard/clicks, whispers, sibilants, screams, very short syllables and phrase endings at 0/25/50/60/75/100%. Compare Wet alone and the same recordings after pitch/role/individual FX in playback, stems and final video. Check that high intensity remains useful and natural; numeric attenuation and synthetic tones cannot answer that. Verify unprocessed microphone capture with RNNoise on/off, device removal, ten physical microphones, real WAN/Cloudflare/Porthole/VPN and Firefox/Safari. Automated ten-browser testing establishes software resources/synchronization, not real room acoustics or WAN conditions.

Generated local speech comparisons are audit/rnnoise/audition/speech-{0,25,50,60,75,100}.wav. Repeat with node tools/rnnoise-audition.js LOCAL_SPEECH_FILE. The source reference retains its original rights and is not a distributable application asset. Heavy decoded recordings beyond the documented 32 MiB task bound fail processing explicitly; microphone permissions and unsupported output devices retain existing browser/device behavior.
