# Export reliability and background operations

## Streaming and cancellation

Working-copy exports keep the existing Mediabunny packet-copy/audio-window pipeline.
Its URL fetch callback now combines the export AbortSignal with the reader's own
AbortSignal. Previously the callback replaced the latter: abandoning a range did
not close its unread HTTP response. Successive readers could consume Chromium's
per-origin connections and leave the next packet awaiting a connection forever.
The real 25-minute/402-take native scene reproduced that wait around 2:30–4:00;
a complete output passes packet identity and audio decoding after the change.
Neither restarting the export nor changing timestamps is part of the fix.
Older browsers without AbortSignal.any use a tested relay whose listeners live
through the response body and are released when either owner cancels.

An export owns its cancellable operation scope, demuxers and output codecs. Waits
for packets, decode, audio windows, encoding, native writes and finalization race
cancellation. Late decoded samples are closed. The real-time fallback stops media
tracks, elements and scheduled nodes and bounds its final drain. Cancellation
immediately acknowledges the request and cleans private file staging/scene leases;
closing and reopening Files retains the same job and cancel action. The final
native atomic commit temporarily disables cancellation to protect the destination.

A leaf operation that does not settle within three minutes fails explicitly rather
than waiting forever. Whole-scene preparation is not subject to that aggregate
limit: its individual preparation/decode/mix waits are guarded. The existing
15-second quiet-progress warning is informational and never advances progress.
Diagnostics retain bounded numeric pending/recent operations and last video PTS,
logging only slow waits, without media, captions, paths, PINs or credentials.
Server FFmpeg retains its existing bounded process timeout and abort signal; a
progressing long encode is not treated as a three-minute client leaf wait.

Mediabunny 1.60's public output cancellation does not interrupt a finalizing codec
flush. The narrow abort adapter force-closes the export's owned codec wrappers
before cancellation; the regression uses an actual WebCodecs encoder with a stuck
flush. Recheck this adapter when upgrading the dependency.

## One compact presentation

The same themed card renderer presents local video exports and shared scene
creation below the main header. Local export cards read the existing export
tracker; they are never broadcast. They show actual phase counters, quiet time,
results, file name, Details, cancellation and native Reveal when available.
Completed results remain until dismissed or superseded by the next export.

Scene creation/import uses ephemeral server records for video/subtitles, packs,
Workshop, library and project imports, after their existing host authorization.
Only the admitted room receives sanitized operation IDs, revisions, stage/status
and known progress. Unknown progress is indeterminate. The native project helper
and HTTP path share the same operation rather than starting duplicate jobs.
An HTTP completion, failure or abort determines the terminal state; a transient
socket disconnect alone does not invent success or abort a live HTTP operation.

Authenticated joins receive current/recent snapshots. Revisions prevent delayed
running messages from reviving completed work; room changes clear old cards.
Disconnected clients show an unknown/reconnecting state until a fresh snapshot.
Guest cards have no cancel action. The host reuses the existing custom-import
cancel action only while it can actually control that request. Two recent shared
records are retained; server terminal snapshots expire after five minutes. Elapsed
and quiet durations are transferred as durations, avoiding client clock skew.

## Custom bitrate and source

Custom export defaults to an available original for the host and the working
copy for guests. Existing original-file authorization remains enforced.
Auto bitrate follows source stream bitrate, relative pixel count, frame rate and
codec efficiency with a modest re-encoding allowance. It is a source-aware estimate,
not a promise of identical visual quality. Validation bounds increases to 2.5 times
the source rate (with a small low-rate floor), capped at 80 Mbps. Resolution/FPS
upscaling remains disallowed. Manual bitrate has a 0.1 Mbps slider/step and precise
typed input; geometry/codec changes preserve its value. Size remains approximate
and includes audio and container overhead. FPS and displayed rates use locale
formatting. Packet-copy modes expose no bitrate adjustment.

RNNoise, take timing, rights and project serialization retain their existing
implementation. Exports resolve confirmed per-author settings from the frozen
scene, including authors who have left.

## Validation — completed 2026-10-16

| Check | Result |
| --- | --- |
| Unit/server suite | 452/452 passed |
| Related browser regression | 57/57 passed |
| Existing progress/audio-throughput profile, run without competing renders | 5/5 passed; exact processed PCM preserved |
| Real HTTP range disposal with/without AbortSignal.any | Both passed |
| Native guest save/cancel, MP4/WebM and project save/open/restart | Passed |
| Playwright themes/languages/layout | 48 captures passed and representative desktop/mobile stacks inspected |

The browser profiles cover six themes, RU/UK/EN, 100–150% zoom, narrow layouts,
quiet versus waiting-for-user states, real throttled upload cancellation outside
Files, room isolation, late join/reload, error/stale notifications, an actual stuck
codec flush and AudioContext resume, MediaRecorder cancellation/restart, offline
author RNNoise, project round trips and real VFR/B-frame packet identity.

The actual 1503.51-second scene contains 402 recordings. Seven complete long exports
were checked: two native working-copy renders; native working-copy and original
custom renders; two consecutive browser guest working-copy renders; and a browser
guest custom render. Native fast/custom-working/custom-original ran consecutively
in the same window. The original custom render used real hardware encoding.
Working-copy packet hashes match the source. Custom results are 640×360; complete
video/audio decoding with FFmpeg error-on-error succeeds. Audio/video start at zero
and their end times differ by about 7.34 ms. No export restart workaround is used.

An isolated real-HTTP A/B probe also makes the cause reproducible quickly: the old
fetch wrapper stops after six readers; the corrected wrapper releases all twelve.
The optional long native/browser tools take a local data folder and copy selected
scene/media fields into isolated test storage. Source projects are never modified;
generated videos and captures remain in ignored audit storage. Repeated browser
downloads have separate QA directories, so overwriting the same suggested filename
does not masquerade as an unfinished download.

## Practical limits

- MediaRecorder runs in real time. Its real short-fixture export/cancel/restart and
  ordinary HTTP paths passed; a full 25-minute MediaRecorder run is not claimed.
- The long runs used overlapping QA workloads; their timings are not performance
  promises. GPU does not accelerate packet copying or the unchanged RNNoise DSP.
- A real healthy GPU was used for the original custom render. Driver-loss recovery
  is tested with an injected failure rather than damaging a running driver.
- The final atomic native commit briefly disables cancellation. The codec abort
  adapter depends on Mediabunny internals and must be rechecked on upgrades.
