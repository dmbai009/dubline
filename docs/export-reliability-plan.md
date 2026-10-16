# Video export reliability work log

Request: DubLine 1.4 export audit, supplied 2026-10-15.
Baseline: fe148bc (personal hardware acceleration). Existing local edits to
ARCHITECTURE.md, BEHAVIOR.md, TESTING.md and docs/regression-matrix.md are unrelated
and must remain untouched. No packaged build or publication is requested.

## Stages

1. [in progress] Reproduce and trace long stream-copy export; fix the demonstrated
   cause and make waiting operations cancellable. Keep bounded, secret-free
   diagnostics; test real media, VFR/timestamps, file integrity and repeat exports.
2. [implemented; final regression pending] One background-operation UI for private export and server-authoritative
   scene creation (local video, packs, Workshop/projects). Room-bound snapshots,
   reconnect, sanitised guest state and real cancellation only.
3. [implemented; final regression pending] Auto/manual source-aware bitrate, compact slider and precise input,
   formatted FPS/bitrate, file estimate; default original for host custom export.
4. [in progress] Long-scene/browser/native tests, offline-author RNNoise/project
   consistency, theme/language/responsive Playwright checks and final report.

## Evidence

- The stream-copy loop waits for each video add, then each 8-second audio add.
  This alone is not evidence of a muxer deadlock; trace real operations first.
- Cancel currently aborts a flag/fetch and calls Output.cancel, but awaits in
  iterators, OfflineAudioContext and codec queues are not raced with abort.
  Output.cancel itself does not interrupt a finalizing output in this library.
- Existing progress already distinguishes completed work and 15-second quiet time;
  reuse its tracker rather than invent a second percentage timer.

Validation checkpoints below supersede the initial untested state.

## Diagnostic checkpoint

The old export completed in an isolated engine-only run over the real 1503-second
402-take scene, but stalled in the production Electron host/native-save workflow
at video PTS 240.907s (audio prepared to 248s; 33 MiB written). Only
video-packet-read was pending, not mux/write/audio. No source mutation occurred.
The current hypothesis is the long-lived Blob stream reader under backpressure.
Testing the public BlobSource useStreamReader:false option, which retains bounded
range reads and demuxing, instead of restarting the export. This is not yet a
confirmed final fix; await full native/repeated output verification.

Cancellation unit cases 4/4 and new browser scenarios 8/8 pass. The existing
export/proxy/hardware browser profile passes 25/25. One exact-PCM throughput
benchmark failed under simultaneous long RNNoise work; it has not been weakened
and must be rechecked without competing workloads.

## UI/cancellation checkpoint

- New cancellation/server-operation/bitrate unit profile: 23/23 PASS.
- Browser cancellation/background profile: 10/10 PASS, including an actual
  WebCodecs flush that never settles, real held upload, a late/reloading guest,
  room isolation, offline-author RNNoise and a real VFR/B-frame packet hash.
- Playwright: 46 captures PASS; the first pass exposed helper wrappers placing
  the bitrate mode and input on different rows. Scoped CSS and themed input fix
  it; the new geometry assertion and captures pass.
- Critical long-export audit remains IN PROGRESS. Blob range reads alone still
  stalled at 4:01; serial packet reads with default Blob streams stalled at 2:59
  (underlying source worker running at 25,169,479 bytes with getNextPacket pending).
  Testing serial packet reads plus bounded Blob range reads together next.
- The 3-minute operation guard exits both stalled native runs with error and
  removes the incomplete .part file. This is a safety net, not the root-cause fix.
- Mediabunny 1.60's public cancel ignores finalizing output / existing normal
  closes. A narrow adapter force-closes owned codec wrappers before cancelling;
  keep the real codec-flush regression when upgrading that dependency.

Serial packet reads plus BlobSource range reads also stall at 2:59. Both retain
the same orchestrator/prefetch path. Testing public CustomSource with prefetch
disabled and 512 KiB Blob ranges; this remains a hypothesis until native runs pass.

Important diagnostic correction: fallback sources are UrlSource, not BlobSource.
The export fetchFn overwrites the reader-owned AbortSignal, so obsolete open-ended
HTTP range responses are never aborted. Their unread bodies can exhaust the
Chromium per-origin connection pool. Removed ineffective Blob/serial changes;
composing both signals and testing full native export next.

Root fix checkpoint: composing UrlSource and export abort signals completed the
full 1503.502-second, 402-take production-native export. The committed 221,320,534-byte
file has identical video packet SHA-256 and its complete audio track decodes with
no errors. The QA poll then accessed a disposed source getter; the fixture now
retains a source reference for diagnostics. Repeated/native custom and long guest
runs remain in progress. Full unit/server suite: 451/451 PASS; browser cancellation,
real range-disposal, error/stale message and MediaRecorder profile: 13/13 PASS.

Checkpoint: a second complete native working-copy export succeeded and the same
window has moved to custom-working, then custom-original acceptance cases. The
long browser guest first pass also completed and downloaded successfully; its
same-window repeat/custom cases are running. Playwright recheck: 46/46 PASS.
Existing project/RNNoise/proxy browser checks pass; one direct-call acceleration
regression exposed an optional job.check guard, fixed without changing the test.
The cancellation/background + acceleration rerun passes 19/19; a separate actual
AudioContext.resume stall cancels/closes and then exports via MediaRecorder.
