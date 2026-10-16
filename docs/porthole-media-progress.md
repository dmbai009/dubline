# Porthole participant download progress

Porthole can forward a remote room through the participant's own `localhost`
or loopback address. A loopback URL alone does not mean the participant already
has the scene video on disk.

The media loader skips its managed download only for the room host on loopback
(or an explicitly supplied local media file). Other participants use the existing
authorized HTTP/P2P loader and report its actual progress through media presence.
Expanded participant cards show the download percentage and progress bar; compact
cards retain the download icon and percentage. Completion still waits for decoder
readiness. Room permissions, project data and P2P consent remain unchanged.

## Regression coverage

`e2e/media-transfer.e2e.js` forwards the real test server through a separate local
HTTP proxy, throttles video delivery and joins from independent browser contexts
using both `localhost` and `127.0.0.1`. It verifies actual in-progress percentages
on the host and guest, expanded/compact card contents, completion readiness and
the local host's unchanged direct-file playback. This scenario fails against the
previous hostname-only check because the guest starts no managed download.

This exercises the local-forwarding behavior without launching the external
Porthole application; real cross-computer routing remains a manual check.

Local validation: syntax checks pass; media readiness, client integrity, HTTP and
media lifecycle tests pass (23/23). The combined media-transfer, stage-three and
media-next browser profile passes (25/25), including the loopback regression,
HTTP/P2P fallback, cancellation, scene changes, host playback and reconnect/resume.
