# Export reliability — completed checkpoint

Request: DubLine 1.4 export audit, supplied 2026-10-15. Completed 2026-10-16.
Baseline: fe148bc. Implementation checkpoints: 4236060 and df8a4d2.
Pre-existing edits to ARCHITECTURE.md, BEHAVIOR.md, TESTING.md and
 docs/regression-matrix.md remain untouched and outside these commits.
No packaged build or publication was requested for this task.

## Completed stages

1. Reproduced the actual 25-minute/402-take native hang and traced it to an
   unresolved video-packet read. URL fetch callbacks replaced the reader's abort
   signal, leaving abandoned HTTP responses open and exhausting connections.
   Combining both signals fixes the cause; no restart or timestamp rewrite.
2. Added cancellable waits/resource ownership, bounded diagnostics, real codec
   flush cancellation and reliable retry after cancellation. A native file commit
   remains the protected atomic boundary.
3. Added one compact presentation for private export and authoritative shared
   scene creation, with room/revision isolation, snapshots, reconnect, real host
   cancellation and bounded secret-free state.
4. Added source-aware automatic/manual bitrate, locale formatting, approximate
   size and original-by-default host custom export. Existing guest rights remain.
5. Completed long native/browser exports, full artifact checks, project/RNNoise
   compatibility, existing audio benchmark and Playwright inspection.

## Final evidence

- Actual HTTP A/B: old wrapper stalls after 6 readers at the 8-second guard; fixed
  wrapper completes/releases 12 in about 67 ms. Native long stalls reproduced at
  2:30–4:00 before the fix. Initial Blob/serial-reader hypotheses did not fix it
  and those experimental production changes were removed.
- Seven actual long exports completed; see export-reliability.md for exact cases.
  Fast video hashes are unchanged. All custom video/audio fully decode; starts
  match and end durations differ by about 7.34 ms. Original custom used hardware.
- Unit/server: 452/452. Related browser: 57/57, existing progress benchmark: 5/5.
  The later abort-signal compatibility case passes both the native API and relay.
- Native guest file transaction/MP4/WebM and project save/open/restart: PASS.
- Playwright: 48 captures, six themes, three languages, 375 px and 150% zoom,
  stacked operations and quiet/cancelled states; representative images inspected.
- Early QA harness failures were post-success diagnostics on a disposed source and
  same-filename browser download detection. Saved artifacts were checked and the
  harnesses corrected. An early PCM throughput hash assertion failed under competing
  renders; it was not weakened and its isolated final profile passes exactly.

All requested implementation and acceptance work is complete. Source media, test
profiles, generated files and diagnostic logs remain in ignored audit storage.
Practical coverage limits are explicit in export-reliability.md.
