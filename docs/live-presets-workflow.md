# DubLine 1.4: live presets and recording workflow

Implementation started from `main` at `4992faf10b8130c5ee91b895936ec1b58fc68469`. The existing DubLine license and application version remain unchanged. This document describes the working implementation, its actual checks and its limits.

## 1. Completed stages

All seven implementation stages are present: live scene presets, export controls/preflight/report, optional own-line recording sequence and historical A/B, advisory recording checks, optional shared voice levels, compact scene review, and media recovery states. The visual matrix covers the new preset, A/B, review and level surfaces.

## 2. Decisions and deviations

The existing chain editor, custom dropdown, recorder, history restore, editor operation journal, project mix, media downloader and export writer are reused. No framework, DSP dependency or second recording/export protocol was added. Used preset deletion offers Cancel or explicit detach of all dependants; replacement with another preset is available through assignment rather than a separate delete wizard. Normalization is a conservative per-take gain correction, not an acting-quality judgment or a certified broadcast meter. It does not perform voice recognition or change retake status.

## 3. Data

Role pitch remains a live dependency even when a take separately bypasses inherited effects. Current and historical takes and role definitions have explicit optional `voicePresetId` and `usePresetPitch`. A take resolves role stages, its linked preset, then individual extra stages, with the existing inheritance/exclusion rules. Preset pitch is optional and replaces the effective pitch only when requested. Rename retains the ID. Save as new creates a separate entry without relinking existing takes.

The scene's `projectAudio.normalizeVoices` defaults to false. Quality checks use a private `takeChecks` dictionary keyed by immutable take IDs. `publicRoom` excludes it; the authorized metadata endpoint returns checks only for recordings the requester may hear. Recording checks follow the same audio identity through history, pinning, restore, trash and project import. Evicted identities are pruned. Local opt-in and ignored warnings remain personal preferences.

## 4. Migration and portable projects

Formats 1–10 remain readable. Their preset applications remain independent copies; import never guesses a live binding. Version 11 is emitted when a scene uses live references, shared voice levels or stored quality checks. Its explicit manifest contains the catalogue, reference fields, shared setting and optional check for each main/historical take. Import validates everything before staging assets and rebuilds the private dictionary without inline public metrics. Scenes without these features retain the lowest applicable older format.

Corrupt live references are refused by project validation; damaged runtime storage falls back to its retained individual settings rather than crashing. This cannot reconstruct the sound of a deleted/corrupt catalogue. `voiceVersion: 1` is a runtime client capability, absent from portable archives. Legacy scenes admit older clients; activating shared processing with an older connected client is refused with an update explanation. A client without the capability cannot join an already linked/normalized scene.

## 5. Authority, revisions and conflicts

Only a preset creator or moderator may edit its common definition. Individual assignment retains take author/owner/moderator rules. Batches validate every target identity, mix revision, role context, preset revision and resulting current/historical chain before applying anything. Common changes validate dependent trash definitions too. Delete detaches references atomically, preserving pitch, exclusions and current sound; Undo's trash identity pointers are rebound after durable success, including empty-track definitions.

Persistence precedes broadcast and acknowledgement. Failed disk writes restore the previous catalogue, roles, lines, trash and timestamp. Common edits retain a private draft until Save; a rename-only revision change can preserve that draft. Unknown acknowledgements retain the immutable operation and query its receipt before retry. The shared level setting uses the existing durable editor journal and strict persistence; explicit conflict review can rebase a known rejected setting. A server-stamped disk failure is distinguished from a missing/local-storage result and can be retried explicitly in Dub Mode. Unknown results keep the original immutable receipt query. No ambiguous result authorizes a new mutation.

## 6. Audio and caches

The path is Raw → RNNoise Wet/blend → effective pitch/ordered voice stages → optional level gain → existing manual gain/pan/project mix/limiter. Resolved processing keys select new final/rate variants only for changed configurations. Old variants remain valid under the bounded cache for independent copies sharing the same file and frozen exports; Raw, RNNoise Wet, unrelated takes and other scenes remain cached. Active playback fades over 30 ms and normal timeline scheduling prepares a fresh variant. Private effect/noise audition retains position and fades between variants. Historical A/B uses one preview source.

Level analysis returns a coefficient alongside the existing buffer; it does not duplicate processed PCM or overwrite manual volume. Playback, audition, full/windowed mixdown and stems use that coefficient. Frozen exports retain confirmed effective voice/noise/level choices despite later scene changes. Missing required processing fails export with the line number; there is no silent dry substitution. Failed-processing observations belong to the resolved voice/noise/trim/level configuration; a successful preparation clears only that observation. An explicit export retry prepares it strictly again. Missing inaudible takes do not block a mix that excludes them, and the result counts only actually included recordings. Ordinary unavailable analysis produces a visible retry explanation.

Analysis runs in one worker, with at most 16 queued jobs, 32 MiB per selected input and 64 MiB retained queued/input PCM. Only the selected audible PCM bounds are copied/transferred; a short selection in a long stereo buffer does not transfer the whole recording. Each buffer caches at most eight numeric measurements by trim bounds/kind/version. Consumer cancellation does not destroy a shared measurement. Existing Raw/processed caches remain 128/256 MiB.

## 7. Level and quality algorithms

Level measurement uses the two K-weighting filters, 400 ms blocks, 100 ms hops, absolute −70 LUFS and relative −10 LU gating from [ITU-R BS.1770-5](https://www.itu.int/dms_pubrec/itu-r/rec/bs/R-REC-BS.1770-5-202311-I%21%21PDF-E.pdf). Clips shorter than 400 ms use one shorter complete block. Four-times true-peak estimation uses the Annex 2 FIR, including boundaries. The internal target is −20 LUFS for stereo; mono compensates for DubLine's existing dual-mono routing. Correction is bounded to ±6 dB, with additional peak attenuation when necessary and headroom before the existing limiter. Very quiet, very short and ambiguous unvoiced/noise-like material is not boosted. A small periodicity heuristic is conservative; it cannot reliably distinguish every type of noise from speech. This is deliberately different from full-program [EBU R 128](https://tech.ebu.ch/loudness/) delivery normalization.

Quality checks use short RMS frames and sample peaks for clipping, nearly empty/very quiet material, exceptionally long internal silence and possible abrupt start/end. They reuse the recorder's already decoded PCM when personally enabled. Ordinary whisper and short expressive clips have regression examples without warnings. Checks are advisory, can be ignored, and neither reject uploads nor request retakes automatically. They describe the captured recording; they are not reclassified on every manual trim or effect edit.

## 8. Workflow and interface

Optional sequence modes cover unrecorded own lines, requested retakes or the current filter. A saved take stays selected until Listen / Keep and next / Skip. Pending/failed uploads disable progression; confirmation recovery enables it. No action records automatically or claims foreign roles. Go to issue temporarily reveals a line without changing saved filters.

A/B chooses existing accessible current/history takes, shows author/duration/pin and switches at the same position where duration permits. Use this take delegates to the original history restore operation. It does not create extra history or files.

Scene review counts progress, retakes, unfinished lines and known file/processing/preset/check problems. Unfinished dialogue is a warning. File checks read host metadata without downloading all takes; hidden recordings' problems and quality are excluded. Export hides excessive dimensions/FPS, explains unavailable choices, selects a valid fallback when its source/method changes, and reports the actual saved/download-ready file. Cancel is never shown as success.

Media states reuse the downloader's actual phase/bytes/rate: authorization, transfer, integrity verification, preparation, ready, network/access/decode failure and cancellation. Retry/cancel reuse the existing scene download and canonical source. Details show whitelisted codec/status information without URLs, tokens or local paths. Percentages describe transfer bytes, not invented decoder progress.

## 9. Automated checks

Targeted live-preset cases cover private drafts, shared PCM, independent copies, rights, atomic bulk failure, history/pitch/exclusions, immutable lost-ACK recovery, strict disk rollback, restart, old/new project formats and unchanged source bytes. Workflow cases cover acceptance/skip/end, failed upload retry, accessible A/B restore, scene review, disabled export choices and a real export report. Level/check cases cover actual stem PCM, manual gain/pan, buffer identity, frozen export, hidden-check privacy, ignored warnings, format 11, disk rollback, lost ACK, restart and old-client admission.

Reference checks compare 48 kHz K-weighting coefficients, 997 Hz calibration, 44.1 kHz measurement, gating, stereo/short clips and true peaks against independent FFmpeg `ebur128`. Separate abrupt-boundary tests check headroom after correction. These tests do not certify a loudness meter.

Actual local verification, 2026-10-15:

| Check | Result |
|---|---|
| Syntax, npm run check | PASS |
| Unit/server suite | 406/406, 7 suites, 43.4 s |
| Full browser run | 520/521, 42 suites, 1,058.4 s; see corrected fixture below |
| Affected six-file browser profile | 72/72, 136.6 s |
| Final live-preset/workflow/level profile | 38/38, including the additional inherited-pitch case, 56.2 s |
| Export profile after safe retry and muted-file checks | 23/23 |
| Final media access/readiness checks | 10/10 |
| Native Electron microphone/RNNoise/quality/project 11 | PASS |
| Native streamed MP4/WebM, save cancellation and cleanup | PASS |
| Native editor, take mix, take history and projects | PASS |
| Windows unpacked build | PASS |
| Final packaged source equality | 144 owned JS/CSS/HTML files plus the exact RNNoise bundle |
| Browser / native visual matrices | 216 + 216 actual images; final packaged refresh 12 images |

The full run's sole failure was the new delayed-level test waiting on the wrong measurement: its test hook also intercepted unrelated prefetch work. The fixture now holds only the intended measurement and waits for the existing 30 ms gain ramp. The subsequent profiles pass. The complete 521-case command was not repeated after that fixture correction; the profiles above overlap and must not be added as independent case totals. Additional checks cover a pitch-only role dependency with effects bypassed, equivalent independent/frozen buffers sharing one source, actual failed-export recovery and an inaudible missing take. No failing scenario remains in the corrected affected profiles.

The final ASAR SHA-256 is b8c903c016bf6094b93e0eb2f05b705be26040e91f3cd4554a2645fe47cd109c; the unchanged RNNoise bundle is e6958293a0118bf9860cb2753332f7562531cc987c914552c426cd7d7180a63e. Exact local logs, images, source proof and benchmark JSON are retained under ignored audit/live-presets; original user projects/data were not used.

## 10. Regressions retained

RNNoise and its model/version are unchanged. Effect algorithms, legacy sound adapters, manual take volume/pan/trim, author rights, shared viewing, recorder/upload retries, pinned history, semantic editor leases, project snapshots, protected media admission, P2P/HTTP fallback and native preload isolation remain in their existing systems. Old preset browser fixtures explicitly choose Copy Replace now that Link is the default. The peer-disconnection fixture waits for an actual received P2P chunk before disconnecting its seeder, avoiding an HTTP/P2P setup race. Small VM test doubles were updated for the new prepared-buffer and structured status surfaces.

## 11. Measured load

The owned synthetic fixture has an actual 1,500 s, 128×72, 2 fps video, 400 current recordings, 10 historical recordings, ten real Chromium participants, ten authors' RNNoise and ten role chains. It is a resource/consistency test, not an anime-quality or listening benchmark. Windows, Node 24.21.0, 16 logical CPUs, 32 GiB RAM. The baseline is the exact archived `4992faf`; baseline/current preset applications both affect all 400 lines.

| Case | Uploads | Bulk configuration | Video export | Observed main JS heap peak |
|---|---:|---:|---:|---:|
| Baseline, copied presets | 36.650 s | 226.0 ms | 74.963 s | 393.3 MiB |
| Live presets, levels off (final) | 34.827 s | 203.0 ms | 72.625 s | 405.7 MiB |
| Live presets, levels on (final algorithm) | 35.669 s | 218.8 ms | 79.112 s | 393.3 MiB |

Both retained 55.2 MiB Raw PCM and 200.2 MiB processed PCM, within 128/256 MiB budgets. Five RNNoise intensity changes caused zero neural reruns. Three listeners' PCM differences were below 0.000002. The output retained exact video packets, duration 1,500.01 s and all original recording hashes. The final default-off run completed with zero level measurements. Optional correction added about 6.49 s (8.9%) to this one export; 5.90 s was measured worker compute. One run per case is insufficient to claim a speed improvement or a statistically significant memory regression. The JS samples are not full process RSS or a peak of all renderer/worker/native backing stores. The isolated final optional-level run completed 404 measurements in 5.901 s of worker compute, with 522,144 bytes maximum retained analysis input and zero jobs/bytes left afterward. Its three listener gains were identical (1.9952623149688795), with maximum PCM difference below 0.000001. Existing limiter/manual levels remained separate.

Reproduce with `tools/live-preset-stress.js`; `--baseline` reads an exact archived checkout outside test discovery using `DUBLINE_BASELINE_DIR`, and `--levels` enables the optional correction. Temporary fixtures never use real project data.

## 12. Visual and native checks

`tools/visual-workflow-next.js` captures 216 real screen images for shared preset editing with 30 long catalogue names, comparison, review and shared audio settings across six themes, EN/RU/UK and 100/125/150% scaling. It also checks keyboard focus in a 640×850 window and reduced motion. Browser screenshots exposed an async settings-close race in the test setup; awaiting the existing close/tab functions made the actual level card visible, and it is now placed in the shared Audio category. Representative light/dark, long-title, narrow, comparison, review and level images were visually inspected, in addition to geometry/localization checks.

Native recording smoke uses real Electron main/preload, fake physical microphone input, RNNoise, actual MediaRecorder upload, independent browser listener PCM and version-11 project export with persisted checks/levels. The packaged application is checked against source bytes before native visual verification. The final source-matched refresh also verifies unchanged buffer identity and equal audition/export gain (1.4776246354731637), using the actual packaged worker. Native streamed MP4/WebM, picker cancellation and partial-file cleanup pass. The complete native matrix precedes the final recovery/cache/inherited-pitch refinements; the final 12-image refresh and functional/native capture/export checks use the latest build.

## 13. Remaining manual coverage and limits

Numerical correctness and generated fixtures do not establish subjective voice quality. Listen to real whisper, shouting, quiet endings, room noise and expressive changes; decide whether ±6 dB conservative correction suits the scene. Check real microphones/output devices, touch dragging, Windows display DPI, Firefox/Safari codec/worker behavior and unstable external Cloudflare/Porthole/VPN group sessions. No actual public-tunnel interruption or long human group recording is claimed. Existing installer signatures/release publishing are outside this request. Source delivery does not imply a published installer or GitHub release.
