# CI recovery, 2026-10-17

Investigated Actions runs 38989506928 (`db60858`) and 38991472053
(`775f438`), using their actual job logs and local browser reproductions.

## Application fixes

- The low-level `renderVoice(buffer, 'equalizer')` API now defaults missing bands
  to 0 dB. A flat EQ returns the dry buffer unchanged, matching chain rendering.
  Nonzero EQ bands retain the existing filters and level correction.
- Stopping/replacing an HTML audio preview consumes the rejection belonging to
  the obsolete play request. A failure of the current preview still propagates.
  Two controller tests cover both outcomes; the browser history workflow also
  exercises actual playback interrupted by recording.

## Test fixes

- Recording helpers wait for decoder readiness and the existing media preparation
  gate before one recording attempt. Local failures reported `Preparing media…`,
  no pending upload and idle recording: the earlier attempt was correctly refused.
  The microphone-selection and live-status tests use the same readiness wait.
  Missing-audio tests still explicitly check that capture is refused while loading.
- Track-height assertions target the track row, rather than the new effect button
  that also has `data-character`.
- Embedded audio assertions compare actual media sources with `mediaUrl(track.url)`
  so verified Blob playback is covered alongside direct HTTP playback.
- The background concurrency test waits for a new upload directory. An older
  rejected request's asynchronous cleanup can leave a directory after its response.
  Authorization, busy refusal, cancellation and unchanged recording assertions remain.
- The partial-peer fixture permits the transport frame crossing its 256 KiB
  threshold. With a randomly selected short final chunk, stopping before that
  frame could leave fewer bytes than the test required. Chunk verification,
  disconnect recovery and corrupt-peer repair assertions remain unchanged.

No production networking, room rights, project format, timeouts or CI jobs changed.
One original Actions stress case also reported a transient WebSocket
`ERR_NO_BUFFER_SPACE`; the complete local media-transfer runs exercise that case
without filtering this error or weakening its assertions.

## Local validation before push

- `npm run check`: passed.
- `npm test`: 477/477 passed, zero skips.
- Media, room, UI cleanup, history and workflow14 browser profile: 89/89 passed.
- Collaborative actor workflow: 14/14 passed. Final EQ/role suite: 9/9 passed;
  the targeted all-effect level scenario also passed after the final change.
  The initial exact neutral-EQ regression exposed floating-point processing of
  a flat EQ and led to the dry-buffer fix.
- Complete media-transfer browser suite: 18/18 passed, including the three-client
  stress case with exact wire-byte and request-count assertions.
- Native `test:electron:workflow`: passed real recording, RNNoise, preview parity
  and project v15 with EQ/levels/quality.

Full GitHub Actions results are checked after this commit is pushed. The local
checks do not establish external WAN/STUN/tunnel reliability or physical devices.
