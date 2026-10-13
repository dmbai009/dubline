# Microphone profile noise reduction

The system adds non-destructive processing before pitch and voice effects. Browser noise/echo suppression, silence detection, ADR preparation, waveform rendering and take files retain their existing roles. No timeline controls were added.

## Signal processing

Algorithm 1 uses a 1024-sample STFT with a square-root Hann window, 256-sample hop, overlap-add normalization and zero padding at both boundaries. A voluntary six-second sample produces one 513-bin noise-power profile using the 60th percentile over frames. Playback uses a bounded Wiener amplitude mask, three-bin frequency smoothing and temporal smoothing. Strength 0 bypasses processing; 20% is the default, with a maximum attenuation floor from 0 to 24 dB over the slider. Signal bins above the learned noise retain their energy while stationary noise is attenuated during speech as well as in pauses.

No gain normalizer follows noise suppression. The existing voice-effect level correction compares an effect with its *cleaned* dry input, so it cannot restore the removed background level from the original. New peak overshoot is limited without lowering a pre-existing decoded peak above 0 dBFS. The downstream existing mix limiter is unchanged. Output sample count, sample rate, channels and alignment are preserved. Frequency/sample-rate mapping interpolates the stored power spectrum; speech quality across different capture/decoder rates still needs listening.

Calibration rejects incomplete or absent input, clipping, strongly unstable levels and excessive spectral change. These are quality heuristics, **not a reliable voice activity detector**: steady speech, music or a stationary competing voice can pass. The user must remain silent and use headphones; the profile must be reviewed by listening. It is never estimated from pre-roll or individual takes. A bad or cancelled recalibration leaves the previous profile intact. The scratch capture uses the selected microphone, existing browser processing flags, mono capture and microphone gain, with no playback loopback. Input capture requires an explicit button press and permission.

The implementation follows the established noise-profile/frequency-smoothing approach described in the [Audacity noise reduction manual](https://www.audacityteam.org/manual/effects/noise-removal-and-repair/noise-reduction/), but is an independent Wiener implementation; it does not claim Audacity-equivalent quality.

## Shared and local data

`noiseReduction` is scene-scoped state. It contains immutable profile versions, per-author enable/strength/future-profile settings and a runtime revision. `noiseProfileId` is part of each active/historical take. Authors control their own recordings, even after role reassignment; claiming someone else's take grants no noise-setting rights. There is no host/moderator override of another actor's profile controls.

New captures bind the profile when the recorder starts, after microphone selection resolves. The captured input/gain/browser-processing signature must match the last successful local calibration. Device fallback or changed gain/processing leaves new takes unbound and recommends recalibration; normal recording is still available. The binding survives delayed/offline uploads and never switches to whatever profile is selected when upload finishes. Existing takes require a separate explicit batch operation, including history. A common strength/enable change affects already bound takes using their original profile versions.

Portable format 7 stores shared sound metadata once per profile; see [project format](project-format.md). Local storage contains the offer-seen preference, last calibration profile, its device/gain compatibility signature and confirmed future-recording enable/strength preferences. A compatible confirmed calibration can initialize future recordings in a fresh scene without another capture. This only initializes an absent author entry with no existing bound recordings; it never overwrites shared project settings or enrolls existing takes. Shared playback never depends on another device's local storage. Raw calibration/scratch recordings are neither uploaded nor inserted into the scene. Recalibration supplies future takes only until an explicit existing-take assignment. This app exports one active scene per portable project, so batch controls deliberately say **current scene**, not all room sessions.

`noise_update` uses existing authenticated scene middleware, snapshot barriers and actor-bound operation receipts. Confirmed batches validate every immutable take ID and history revision before applying anything; mix and editor fields remain unchanged. Disjoint first-time author initialization can merge against a newer scene revision only while that author remains absent and unbound; every ordinary update still requires the current revision. Strict room persistence precedes acknowledgement and failures roll back all patches. Lost ACKs retry the identical operation ID once. An unconfirmed result tells the user to reconnect/review before a new operation. No slider traffic is sent during scratch preview.

## Preview and resource limits

The scratch player decodes only the selected original take, bypassing pitch and all DubLine voice effects. It has its own AudioContext and gain nodes; it never mutates the line or shared caches. A/B changes and slider results replace audio at the same playback offset with a 30 ms crossfade, retaining pause and looping. Rapid slider changes abort old worker tasks. Checkboxes have an independent draft selection, retained across search, and do not enroll the chosen scratch sample. Selection cancellation makes no network changes. Closing/switching scene/disconnecting stops scratch capture and playback, releases tracks/nodes/timers/context and discards temporary buffers.

A single reusable Worker processes noise jobs. Queue count is bounded at 16, pending PCM at 64 MiB and a single take at 32 MiB decoded PCM. Existing raw/processed caches remain 128/256 MiB and processing keys include profile ID/version, strength, enable, take source, pitch, effect amount and trim. Confirmed changes invalidate affected author's cached variants only. Bulk assignment bypasses the old eager per-line processing hook; normal lookahead and on-demand processing remain available. A temporary processing failure plays the original with a visible warning and does not permanently cache that fallback as cleaned audio. Scene changes cancel stale jobs. A cooperative, yielding main-thread fallback supports Worker-unavailable environments; it is slower and calibration analysis itself can still briefly block if Worker is unavailable.

HTTP playback/processing needs no new secure-origin exception or crypto API. Microphone capture still depends on the environment's existing `getUserMedia` policy; an ordinary remote HTTP browser that cannot access a microphone cannot calibrate or record there. It can listen to saved processed recordings using Worker/Web Audio. No browser security flags were added to the product.

## Validation and manual acceptance

Run `npm run check`, `npm test`, `npm run test:e2e`, `npm run test:ui`, `npm run test:hardening` and the applicable native Electron commands. The new profile suite is `e2e/noise-reduction.e2e.js`; the production Guest test is `npm run test:electron:noise`. Numerical/permission checks do not prove subjective speech quality.

`node tools/noise-reduction-benchmark.js "LOCAL_RECORDINGS_FOLDER"` creates ignored local comparisons under `audit/noise-reduction`. It reads up to three local voice files without changing them, adds known synthetic white noise, and renders 20/50/100% comparisons. This establishes controlled error/cost measurements; it is not a measurement of the user's room noise. Files and raw voices must not be committed or uploaded.

Manual checks before release:

- Calibrate physical microphones in several rooms, with fans, hum, keyboard bursts and browser processing on/off; confirm contaminated profiles are rejected or discarded by the user.
- Listen to original/noisy/cleaned comparisons, whispers, sibilants, shouted and short lines. Tune a weak setting first; check for metallic noise and lost endings.
- Recalibrate after changing device/gain; confirm older active/pinned/historical takes retain their profiles. Test default-input hardware replacement as well as explicit device selection.
- Record a real 25-minute group episode, listen to overlaps, effects and tails, and compare final video/WAV stems with playback. Automated stress uses hundreds of cues/short takes, not ten physical microphones or a full long native render.
- Check Safari/Firefox on real devices, microphone removal, actual Cloudflare/Porthole/VPN routing, narrow windows and system scaling. Local HTTP and mocked native network routes do not establish WAN reliability.

Known limits: 64 profile versions per scene; profiles are retained conservatively rather than exposing a separate profile-management UI. Per-author common strength is scene-scoped. Noise suppression cannot repair clipping, reliably remove intermittent sounds or separate competing speech. Old projects remain acoustically unchanged until explicitly assigned; newly assigned takes will sound different by design.
