# Dubline 1.4.0 — Projects, Workflow & Reliability

Built on current main, preserving the Workshop external-link fix after 1.3.1.

## New workflows

- New Single Player Project and Open Dubline Project launcher actions. Solo recording automatically covers all roles. Host Multiplayer promotes the open workspace using the existing providers and PIN.
- Portable .dubline ZIP with versioned manifest, complete active-scene media/current recordings/processing/alignment/shared mix. Save is available in both modes; open creates a new session. Consistent snapshots and staged validated import protect the current project.
- My Settings versus Room / Project Settings, visible disabled shared controls without permission, local ADR cue volume and enforced 3–5 second enabled preparation.

## Timeline and interface

- Central video-duration bounds across create, drag, both resize handles, keyboard, inspector and groups. Visible striped region beyond video and clear invalid-create notice.
- Empty clicks seek with zoom/scroll; mixed-role groups preserve relative placement and cancel atomically at role limits; vertical time lock releases with deliberate horizontal movement.
- Local individual role heights with reset; Dub represents current recording coverage.
- Centered reusable text/confirm dialogs with Enter, Escape, focus trapping/restoration and EN/RU/UK. Intershum becomes Background / M&E in English and Фон in Russian/Ukrainian. Critical light-theme contrasts repaired.
- Workshop clients first try exact-size/SHA-256 verified direct ZIP/media; failures, timeouts, changed packs and scene cancellation use existing delivery safely.

## Compatibility and limits

Existing browser/Electron rooms, takes, packs, session persistence, exports, P2P and network workflows remain supported. Legacy out-of-video cues are fitted to real media duration without deleting captions/take assets. .dubline holds one active scene/current takes and excludes credentials/runtime state/personal preferences/pending device blobs/history. Archives have no aggregate size ceiling. Working video is limited to 300 MB; complete proxy/source projects use format version 2, and version-1 projects remain readable. Host rights are required for save/open.

Large theme/launcher/titlebar/identity redesigns and simultaneous hybrid chunk acceleration remain deferred. Physical microphone/headphone and subjective multi-user QA require human release review. See the [coverage audit](docs/regression-matrix.md) and [testing guide](TESTING.md).

## Solo testing corrections

- Provider tabs remain responsive during checks; old requests cannot override the latest selection and the solo status clears on promotion.
- Visible cue numbers use timeline order while saved recording IDs remain intact.
- One working fullscreen control, with trusted-origin Electron permission and transport restoration.
- Fixed audio-track picker below video, independent of timeline scrolling/collapse.
- Visible preparation/buffering status; preparation of an old scene does not block the new video.
- Viewport/DPR-aware waveform canvases with overscan for QHD and scrolling.

Regression coverage is documented in [the testing guide](TESTING.md).

## Large project archives

- Removed the aggregate 384 MB .dubline limit; stream ZIP/ZIP64 through disk in browser/native workflows.
- Apply 300 MB to video independently of separate audio and accumulated takes.
- Explain limits/free-space/download status in EN/RU/UK; retain version-1 validation/rollback.

Large archive regression tests are described in [the testing guide](TESTING.md).

## Large video and smoother auto-ducking

Local custom videos above 300 MB automatically receive an optimized H.264 working copy up to 720p. The original stays on the host, survives complete .dubline version-2 save/open, and supplies the unchanged video stream for final MP4/MKV export. Preparation shows progress and can be cancelled. Guests receive working media; source-quality export runs on the host.

Auto-duck now anticipates takes with a smooth 300 ms attack and restores over 850 ms after a short hold. Room updates no longer abruptly replace gain automation. Existing version-1 projects remain readable.


## Choose the project storage drive

Select a parent folder in the launcher or My Settings. Dubline creates its own subfolder and moves existing projects, original/proxy videos, audio, takes, library and server export staging. Changes made in the workspace apply at the next launch. Progress is shown; failure preserves current data. Preferences, Chromium cache and portable EXE extraction keep their standard system locations. [Validation coverage](TESTING.md).

Clip mixing: per-take volume, stereo pan and dry/wet effect amount, with atomic bulk controls across selected clips. Recording authors may mix their own takes after releasing a role; hosts may mix every take. Settings apply to preview, playback, video audio and stereo character stems. Changed mixes save as .dubline format 3; formats 1/2 remain readable.
