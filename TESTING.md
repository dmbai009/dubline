# Testing

## Commands and layers

| Command | Layer / purpose |
| --- | --- |
| `npm run check` | Syntax checks for server, client, and desktop scripts |
| `npm test` | Unit, integrity, real-server, persistence, authorization, and FFmpeg tests |
| `npm run test:e2e` | Chrome/Edge workflows with generated media and a fake microphone |
| `npm run test:electron:projects` | Native Single Player, real recording/save/close, launcher open in both modes, corrupt open rollback |
| `node tools/visual-workflow-qa.js` | Reproducible screenshots for human visual inspection, not a subjective audio test |
| `npm run test:electron:editor` | Native Electron editor dialogs and shortcuts |
| `npm run test:electron` | Host launcher, server, source selection, and monitoring smoke |
| `npm run test:electron:guest` | Guest language persistence and restricted bridge |
| `npm run dist` | Packaged Windows portable build |
| `node tools/electron-smoke.js cloudflare --portable` | Exact release EXE and live tunnel |
| `npm run test:electron:portable` | Concurrent portable host/guest isolation |
| `npm run test:electron:cloudflare` | Live Cloudflare smoke; requires network |

Tests use temporary data/uploads/packs and generated FFmpeg media. E2E uses a locally installed Chrome/Edge (`CHROME_PATH` override); missing browsers can skip tests, so inspect skipped counts. Electron and packaged checks have runtime/build prerequisites and must be reported separately from unit results.

## Regression strategy

Test behaviors rather than line coverage. Run affected tests after each major block, then syntax, unit/integration, browser, desktop, and packaged suites before declaring the release ready. Preserve existing integrity and authorization tests. Exercise failures as well as the happy path, real pointer/keyboard actions, actual media bytes, and reload/restart persistence.

The functionality audit is `docs/regression-matrix.md`; validation commands, automated coverage and manual limitations are documented here. Coverage means a test exists, not that it was executed in the current session.

## Manual checks before release

Verify dialog centering/focus, timeline boundaries under zoom/scroll, drag and axis-lock feel, ADR loudness with real headphones, light-theme readability, real microphone latency, subjective multi-user behavior, and playback of final video/stems. Automation cannot establish those subjective checks.

## Solo feedback regressions

e2e/solo-feedback.e2e.js verifies stable-ID versus visible chronological numbering through actual portable save/open, one real fullscreen button with transport restoration, a fixed multi-track picker through redraw/scroll/collapse, published preparation state, an actual delayed audio response, and painted waveform samples at the right edge on a 2560px viewport at DPR2. The desktop suite resolves provider requests out of order while tabs remain interactive; native project smoke additionally covers Electron fullscreen permissions and rapid promotion/provider changes. tools/visual-solo-feedback.js creates a QHD screenshot with actual two-track video.

## Large archive regressions

projects-stream.test.js runs in npm test: actual >400 MiB archive, bounded RSS, immutable snapshots, forced ZIP64, real HTTP and native IPC file open, cookie-protected direct download, cancelled transfer, 400 MiB separate audio and >300 MiB video rejection. Failure cases cover CRC/hash/size/path/duplicate/symlink validation, abort, disk space and auth. The valid oversized WAV fixture uses one RIFF JUNK chunk; an initial malformed trailing-zero fixture timed out during FFmpeg probing and was replaced. Physical >4 GiB archives were not generated. Browser/native tests use the actual new download UI.

## Proxy and ducking regressions

video-proxy.test.js covers a physical >1 GiB MP4 with a valid sparse free atom, 1080p to 720p optimization, original multilingual tracks, streamed version-2 archive reopen/restart, exact final encoded-video packet hash, protected source/download paths, host/session/slot checks, MKV with MPEG-4 video/AC3/embedded subtitles, schema failures, smooth gain samples and preservation of playback automation during room updates. Sparse padding exercises file IO/size; it is not a real episode encoding-duration benchmark. e2e/proxy.e2e.js uses the real 301 MiB file picker, progress, guest playback, recording, source-quality render and cancellation.


## Storage folder regressions

electron-storage.test.js covers exact media/take/library bytes, Unicode, pending changes and late recordings, restart, cancellation of pending changes, occupied/overlapping paths, unavailable drives, malformed preferences, space/copy/commit failures, concurrent requests and junctions. It also copies a physical >1 GiB sparse file with bounded RSS and migrates between actual profile/workspace volumes. npm run test:electron:storage exercises native UI/preloads/IPC, real recording/save/reopen in both modes, deferred and immediate moves, and original-quality final render after migration. node tools/electron-smoke.js --portable --storage checks the exact packaged EXE with a pending external-root migration and then normal shared import/record/export workflows. Copy failures preserve the original storage. Hard termination can leave a staging directory beside the destination, or old copies if it occurs during post-commit cleanup.

e2e/storage.e2e.js is included by the launcher suite in npm run test:e2e. It checks copy progress/startup locking, cancellation/occupied-folder UI, unavailable-drive startup retry and EN/RU/UK pending-folder text.

## Latest local validation

On 2026-10-05 the unit/server suite passed 144/144 before two additional storage tests and final launcher error-message/button changes. The final storage suite passed 13/13, including a physical >1 GiB sparse file and actual C-to-D migration. The full browser suite passed 176/176; after adding storage UI coverage, the affected launcher/storage suites passed 8/8. All of these runs had zero skips. The standard browser command now includes the four new storage UI cases.

Syntax and whitespace checks passed. Native storage smoke passed recording/save/close/reopen, immediate/deferred migration, original-video packet identity after both moves and rejection of untrusted storage IPC. The final Windows portable EXE passed a pending C-to-D storage move followed by PIN guest import, shared editing/Undo, recording, .dubline save/open and original video mux/download. No GitHub release is implied by these local build checks.

Sparse >1 GiB fixtures exercise disk IO and memory bounds; they do not establish the compression time of a real anime episode. Physical >4 GiB project archives and subjective microphone/headphone/WAN behavior remain outside these automated checks.
