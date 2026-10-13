# Video export in DubLine 1.4

The Files & Export tab uses the same source-based policy for manual imports,
Voxalike packs/Workshop, and reopened `.dubline` projects. Project format remains
version 6; personal export choices are not stored in the shared scene/archive.

## Modes and source limits

* **Working version:** admitted actors render locally. Mediabunny copies encoded
  video packets into MP4/WebM when the container and audio encoder support it.
  Only the current working video is available to guests.
* **Original quality:** confirmed, connected hosts use the existing FFmpeg route.
  Video is copied; MP4, MKV or WebM is retained. If there is no separate original,
  the UI explains that working and original video are the same source. Failure to
  inspect an original does not disable export of the working source.
* **Custom:** MP4/H.264/AAC or WebM/VP9/Opus, subject to actual encoder support.
  Working sources are encoded locally; only the host can choose the private
  original and use FFmpeg. This is real video encoding, not a metadata change.

Source metadata comes from actual video packets, not container-wide bitrate.
Resolution is bounded on both coded/display axes after rotation and preserves
aspect ratio. FPS/average target video bitrate cannot exceed the source. Unknown
values remain unknown; manual controls fail closed. VFR timestamps are preserved
unless a supported lower constant FPS is selected. Re-encoding at the same
bitrate does not guarantee lossless picture quality.

Approximate size uses video-stream bitrate, duration, 192 kbps audio and 2%
container overhead. It excludes unrelated original audio tracks and padding.
VBR and encoder implementation make this an estimate, not a reserved byte count.

## Audio, authorization and cancellation

Only authorized **active main takes** enter video export. Timeline filters and
historic takes do not change the mix. A short-lived authenticated snapshot lease
retains media files using existing reference pins; actors can continue recording
and editing. Leases are owner/scene/video-bound, capped, renewed only during an
active export, and released on completion, failure, disconnect or expiry.

The mixer retains effects, pitch, trimming, latency, gain, panorama and shared
duck/limiter behavior. It uses 8-second PCM windows with 2 seconds of warm-up,
including codec pre-roll and continuous resampling. Existing bounded take caches
are reused. Export-owned take requests abort on cancellation; shared playback
requests remain alive. A native offline Web Audio operation already executing
cannot be interrupted; its bounded result is discarded when cancelled.

Without usable WebCodecs, an explicitly confirmed MediaRecorder path captures the
working video and mix in real time. Supported MIME combinations are checked;
format changes are not silent. Hosts can still preserve original video by
capturing **audio only** in real time and using FFmpeg for video copy. Already
encoded AAC/Opus is copied when compatible with the final container; legacy WAV
and incompatible audio are encoded by FFmpeg. Missing required audio fails export.

## Saving

Electron host and guest choose the destination using a main-process native dialog
**before** media processing starts. The renderer receives an owned opaque ticket
and display name/location, never filesystem authority. Main-frame/exact-origin
checks, bounded preload payloads and one-megabyte writes protect the bridge.
The main process writes a same-directory unique `.part`, checks disk space when an
estimate exists, fsyncs, checks the approved destination has not changed, then
renames atomically. Cancellation/failure preserves existing destination content.
App media/data directories cannot be overwritten through export. File size is
limited to 64 GiB and idle tickets expire. Cancellation is disabled at the final
atomic commit boundary. Reveal-folder uses the saved ticket.

Native Mediabunny output uses StreamTarget with backpressure and `fastStart:false`;
the completed video is not collected in an ArrayBuffer. The host's intermediate
soundtrack is compressed and buffered for its existing multipart endpoint.
The optional local completion tone runs only after the saved file closes.

Browsers use normal downloads, never File System Access or a service worker.
Their final BufferTarget/Blob **still buffers the output**; large files can exhaust
browser memory. The UI explains this and reports download handoff rather than
claiming that the browser has finished writing its destination. No browser tone.

## Reproduction and manual checks

Automated scenarios live in `e2e/video-export.e2e.js`, `e2e/proxy.e2e.js`,
`video-export.test.js`, `video-proxy.test.js` and the Electron smoke scripts.
`node tools/video-export-benchmark.js [local-voice-storage-root]` compares the
baseline at `4d1be2c` with the new pipeline using a synthetic 1500-second source,
420 take snapshots and ten author identities. It records Windows Chrome process
working-set samples, elapsed time, maximum PCM context allocation, duration and
encoded-video packet identity under ignored `audit/video-export/`. Voice inputs
are read-only and never committed. This is a pipeline benchmark, not a live
ten-user recording session or a measurement of arbitrary high-bitrate episodes.

Before release, manually verify:

1. Firefox/Safari on their actual OS/device, with and without protected encoder
   APIs; media-recorder MIME support, real-time timing and background-tab behavior.
2. Actual Cloudflare/Porthole/VPN routes and interrupted downloads; local HTTP
   simulations do not establish external routing reliability.
3. A real 25-minute episode with hundreds of takes, both original/working sources,
   all effects, negative/positive offsets, silence, overlapping speech and tails.
   Listen for clicks, missing lines, level changes and mouth/voice synchronization.
4. High-resolution, rotated/portrait, VFR, HEVC/AV1 and HDR originals on intended
   playback devices. Preserve-source mode copies the original codec; custom HDR
   color conversion and browser decoder support need device-specific verification.
5. Native Save As overwrite, nearly full/removable/network drives, closing during
   export, and completion tone with chosen output devices. A crash/power failure
   can leave an uncommitted `.part`; no success is reported for that file.
6. Several sequential exports in a real scene, concurrent actor recordings,
   scene/mode switches, `.dubline` reopen, stems and Voxalike pack export.

No release, tag, updater, network topology, project schema or audio-recording
workflow is changed by this export implementation.
