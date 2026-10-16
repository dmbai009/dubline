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

## Validation

See export-reliability-plan.md for the current measured checkpoints and remaining
acceptance runs. New regressions cover real range-request disposal, blocked mux/
encode/finalize cancellation, a stuck native codec flush, MediaRecorder fallback,
shared upload/reload/late join/error/stale events, offline authors and VFR/B-frames.
The optional long native/browser tools take a local data folder and copy selected
scene/media fields into isolated test storage. Source projects are never modified;
generated videos and captures remain in ignored audit storage.
