# RNNoise in DubLine

DubLine bundles @shiguredo/rnnoise-wasm 2025.1.5 locally, including its model. No archive, Python installation, model download or calibration is required. The bundle SHA-256 equals the RNNoise bundle used by NoiseLab 0.3.0. DeepFilterNet and GTCRN are not included.

## Settings and ownership

Open My Settings → Audio → Noise reduction. The switch controls all recordings made by your nickname in the current scene, including current, new, historical, restored and pinned takes. Role ownership does not change the recording author. Hosts and moderators cannot edit another author's noise setting. The intensity starts at 60%; existing scenes and imported legacy projects start disabled.

The slider and preview are private drafts. Closing settings, Escape, changing category/tab or normally switching scene saves one acknowledged operation. An unchanged draft sends nothing. Failed saves keep the confirmed setting and draft with Retry. Lost acknowledgements reuse the immutable operation ID and query its receipt. Unknown outcomes prevent a new mutation until resolved. A remote scene switch/disconnect never publishes an old draft into the new scene.

Preview selects an accessible own current or historical recording at random on first play, retaining it until Next or settings close. No recording means preview is disabled while settings still work. Preview loops independently of the video, preserves position during intensity changes and crossfades over 30 ms. With effects uses the normal voice chain and output routing; turning it off auditions the noise stage alone. Preview never takes microphone permission or uploads sound. Browser microphone noiseSuppression remains a separate existing capture preference.

## Audio path

Original decoded PCM → RNNoise Wet → Dry/Wet blend → effective pitch → role and individual effect chain → existing effect level correction → trim / clip volume / pan / scene mix. Full-file context is processed before trimming. No extra normalization follows RNNoise.

The native model uses 48 kHz, 480-sample frames, independent channel states and PCM scaled by 32768. Processing pads incomplete frames, flushes the tail, removes the model's 960-sample delay (20 ms), resamples with NoiseLab's symmetric 64-tap Blackman sinc / 1024-phase / 0.94-cutoff path and returns exactly the original rate, length and channels. Every task/channel receives a fresh state, destroyed in finally. At 48 kHz the real output has been compared sample by sample against independent direct model frame calls.

Intensity s is exactly dry × (1−s) + wet × s. Zero bypasses neural processing; 100% is the complete model output. High intensity may reduce speech detail; subjective naturalness requires listening.

## Caches and failures

Raw PCM retains the existing 128 MiB cache. Full-strength Wet and final processed variants share the existing 256 MiB budget. Wet keys contain immutable source URL, engine/model/DSP versions, input rate, channel count and length. Intensity, trim and effects do not enter Wet keys. Final keys include resolved noise and voice settings and trim; output gain/pan remain node settings. Changing intensity or effects reuses Wet. Source replacement/deletion evicts relevant references and marks in-flight jobs stale.

One reusable module Worker processes jobs with preview/playback ahead of export/prefetch. Limits are 32 MiB decoded PCM per task, 64 MiB queued/in-flight input and 16 waiting jobs. Requests deduplicate and late cancelled callbacks cannot complete a later job. Cancelling a preview consumer does not discard shared useful Wet work. Worker/model failure uses original audio plus effects with a throttled visible warning; it is never cached as successful Wet or final output. Strict previews/exports report failures. Scene changes cancel queued stale work. Committing settings preserves already playing sources and performs no bulk denoising.

## Synchronization and compatibility

Scene state uses schemaVersion 2, rnnoise engine 2025.1.5, pinned modelVersion, dspVersion 1, actors and runtime revision. Actors contain only enabled and strength. Socket noise_update/noise_updated retain the existing session, authenticated nickname, editor operation receipt and snapshot barrier infrastructure. Strict disk flush precedes broadcast/ACK; failure rolls back state. A scene with active RNNoise rejects incompatible clients; enabling it while incompatible participants are connected fails explicitly.

Formats 1–8 remain readable. Legacy 7/8 profiles and references are validated before extraction, then removed while originals, authorship, histories, alignment, trims, pins and effects remain intact. Migrated author settings are disabled/60%. Persisted rooms, inactive sessions and trash migrate idempotently too. Writes use format 9 when RNNoise author settings exist. Portable archives exclude runtime revisions, receipts, local drafts and caches. Exports freeze confirmed noise settings with the existing immutable snapshot.

## Verification and listening

Run npm run check, npm test, npm run test:e2e, npm run test:ui, npm run test:hardening and applicable Electron tests. Dedicated checks are e2e/noise-reduction.e2e.js, noise-reduction.test.js, npm run test:electron:noise and npm run test:electron:chains.

node tools/rnnoise-audition.js LOCAL_SPEECH.wav writes ignored local WAV comparisons at 0/25/50/60/75/100% and checks the real model against independent frame processing. node tools/rnnoise-stress.js exercises an actual 1500-second video, 400 recordings, ten connected browser participants/authors, mixed effects, rapid seeking, a long stereo task and final encoded video export. Synthetic stress establishes resources and consistency, not naturalness.

Before release, listen to physical microphone recordings: room/fan noise, keyboard bursts, whispers, sibilants, screams, short syllables and phrase endings; compare effects and final stems/video at all six strengths. Test microphone removal and browser suppression on/off, actual WAN connections and Firefox/Safari. No subjective score is inferred from reduced energy or synthetic tones. Attribution and model licensing scope are in resources/licenses/rnnoise/PROVENANCE.md and THIRD_PARTY_NOTICES.
