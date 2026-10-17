# Dubline 1.4.0-beta.1

The first public beta of Dubline 1.4. This changelog covers the changes since **1.3.1**, including new features, reworked workflows, fixes, and removals. This is a **pre-release**: bugs and more frequent updates are possible. Back up important projects before upgrading.

## Download for Windows x64

- **[Setup](https://github.com/dmbai009/dubline/releases/download/v1.4.0-beta.1/Dubline-1.4.0-beta.1-win-x64-Setup.exe)** — a standard Windows installer with a choice of installation folder, shortcuts, and updates for the installed application.
- **[Portable ZIP](https://github.com/dmbai009/dubline/releases/download/v1.4.0-beta.1/Dubline-1.4.0-beta.1-win-x64-Portable.zip)** — extract the archive and run `Dubline.exe` from the extracted folder. Keep the entire folder together.

The separate self-extracting Portable EXE is no longer distributed. `Setup.exe` is an installer, not the former standalone EXE. The other release assets support integrity checks and automatic updates; you do not need to download them manually.

## Projects, Single Player, and storage

- Added **Single Player**: dub every role on your own without creating a multiplayer room. An open project can later switch to Multiplayer using the existing connection methods.
- Added launcher actions for creating a Single Player project and opening a project in the selected mode.
- Added portable **`.dubline` projects**. A project stores the scene, captions and timings, tracks and their order, original and working media, current recordings and take history, audio processing, presets, and shared mix together.
- Saving uses a consistent scene snapshot. Import validates and prepares the data before creating a new scene; a failed import must not replace the open project or a library pack.
- Projects can be opened from Windows, including when Dubline is already running. A second launch forwards the request to the existing instance. A guest window does not upload a local project to someone else's room.
- Removed the overall `.dubline` archive size limit. Large archives use disk-backed processing and ZIP64. Individual media limits, archive validation, and free disk space requirements still apply.
- Large local videos automatically receive an optimized H.264 working copy at up to 720p. The host retains the original for original-quality export; participants receive the working video. Preparation shows progress and can be canceled.
- The storage folder can be selected in the launcher and personal settings. Migration includes scenes, recordings, original and working videos, audio, and the pack library; source data is retained if migration fails. Changes made from the studio take effect on the next launch.
- Extended the project format to version **15**, while retaining support for reading previously supported formats. New fields and media are validated during import.
- Room PINs, current connection permissions, personal devices and layout, and unsaved device queues are not included in portable projects.

## Recording and take management

- Added persistent, per-device microphone and playback-device selection. Playback output applies to video, takes, previews, and ADR cues. Device lists can be refreshed, and disconnected devices are handled.
- An active recording keeps its selected microphone until it finishes; a new selection applies to the next take. If the device is lost, Dubline preserves the captured portion when possible.
- Improved preparation, buffering, and playback-error indicators before recording. Preparation for an old scene no longer blocks a new video.
- Moved take history into the inspector: preview, restore, delete, and pin up to **three previous takes**. Pinned takes are protected from normal eviction. Added A/B comparison.
- Added persistent **retake requests** with comments, participant notifications, and navigation to the affected line. Comment drafts are protected from being silently overwritten by another participant's changes.
- Added optional technical hints for new recordings: clipping, near-silence, low signal level, long pauses, and possibly cut-off beginnings or endings. These hints do not prevent saving a take.
- Added a scene-readiness summary and navigation to the next owned, unrecorded line. Navigation respects pending uploads and never starts a new recording automatically.
- Improved sequential dubbing: previewing and confirming a saved take, advancing, and skipping a line remain explicit actions.
- Assignment and bulk actions respect the selected lines and ownership permissions. Recording authors can adjust their take mix after releasing a role; host and moderator operations are validated by the server.
- Clicking the take or original-preview button again now stops playback. The pin button sits between playback and re-recording, and compact buttons are less likely to wrap onto another row.
- Added **original-only preview** for video-and-subtitle packs, with up to 0.5 seconds of context before and after a line, regardless of the source track's mute state or mix level. Background audio is used as the original only when the source assignment allows it. Voxalike packs retain their separate per-line original-file workflow. Previewing does not change the export mix.
- ADR cue volume is now a personal setting. The interface explains the cues and preparation time.
- Added per-take volume, stereo pan, and effect mix, along with atomic bulk mix changes for selected recordings. These settings apply to playback, video export, and character WAV stems.
- Separated the **shared project mix** from **personal monitoring**: personal levels do not change exports. Original audio, background audio, and dub tracks have the applicable levels, mute/solo controls, and source offsets. Personal monitoring can be reset to the project mix.
- Smoothed automatic ducking: it lowers the background before a line, bridges nearby phrases, and gradually restores the level afterward. Room updates should not abruptly reset these transitions.

## Effects, presets, and noise reduction

- Replaced single effects with **ordered effect chains** for roles and individual lines. Processing order applies to playback, previews, and exports; original recordings are never overwritten with processed audio.
- The catalog now contains **11 effects**: Pitch, Robot, Radio, Telephone, Monster, Thoughts, Cave, Behind the Door, Megaphone, Echo/Delay, and a graphic Equalizer.
- Added the **Telephone** effect and balanced the levels of several voice effects.
- Moved Pitch from its separate top-level control into the chain. It supports **−12 to +12 semitones**, and users can choose its position among the other effects.
- Added a **graphic equalizer** with adjustable frequency bands.
- Made the effects editor more compact and consistent for roles and individual lines: toggles, numbered processing order and direction, draggable cards with a visible dragged item and shifting neighbors, drag-to-add from the catalog, and accessible ordering through the keyboard and buttons.
- Added personal previews, a recording selector, looping, and sound comparison. Draft changes are audible only to their author until applied; closing the editor offers to save or discard them.
- Added a **shared preset library for the current session**. Participants can create, select, and apply presets allowed by their permissions. Custom presets contain the full chain and can have a custom icon.
- Added quick preset selection directly in the inspector, including bulk assignment to selected lines.
- Each line has one chain of its own: a linked preset, a locally modified version marked **“(modified)”**, or unique effects. Removed the separate layer of individual effects on top of the same line's preset.
- Edits to a linked preset remain local initially. Users can keep them on that line, save a new preset, or confirm an update to the original shared preset if they have permission. Confirmed updates affect linked lines, including lines that are already recorded.
- Role effects are processed **before** a line's own chain. Inheritance can be disabled for an individual line. The compact chain diagram identifies role effects with a separate color and preset name.
- Role presets are separate from line presets. **Apply to role** updates the role's shared preset directly. Removed the unnecessary sidebar, role preset icon, and persistent warning; the explanation is available on the apply button.
- Participants can edit effects for roles they own. Role presets cannot be assigned to individual lines. Line presets cannot use a role's name, and name conflicts introduced by role changes are handled separately.
- Deleting or unlinking a shared preset accounts for its usage and preserves the required sound in local chains, including take history.
- Added optional, bounded **dialogue loudness leveling** with before/after preview. Manual levels are preserved, and near-silent recordings are not amplified without a limit.
- Replaced noise reduction with bundled **RNNoise**: an author-specific setting in the current scene, adjustable strength, personal preview before applying, reuse of processed audio, and project persistence. Processing runs locally without uploading voices to an external service.
- Removed the intermediate noise-profile/calibration workflow and its extra steps. Migrating an old setting does not automatically enable RNNoise; dry recordings are preserved.
- Completely removed the browser WebRTC noise/echo-processing setting and its logic. Microphone capture explicitly disables `noiseSuppression`, `echoCancellation`, and `autoGainControl`.

## Timeline, inspector, and interface

- Made the inspector more compact and responsive: a vertical layout at narrow widths and multiple columns when widened. Microphone gain, history, effects, volume, and pan remain available.
- The **Roles and characters** panel can be resized by dragging its right edge. The original width remains the minimum. The choice is saved locally, while tracks and the ruler move together without changing timing or selection.
- Improved individual track heights, role ordering, and drag reordering. Roles move vertically while neighboring tracks shift smoothly. Height changes survive timeline redraws caused by media readiness or another participant's actions during a drag. Long names, counters, and buttons fit narrow panels more reliably.
- Moved the track-effects button next to the role name so it no longer overlaps counters.
- Added a personal multi-role filter with vertically arranged options. Removed the obsolete single-role dropdown above the timeline while preserving the other filters.
- **Shift selection** now follows tracks and geometry: a range within one track, or a rectangle spanning different tracks, rather than a simple sequence of line numbers.
- In Dub Mode, dragging across empty timeline space selects a **personal time range**. Space plays to its end and stops; double-clicking selects the entire video.
- Time-range selection leaves existing Edit Mode gestures intact. Range times and actions are displayed in the bottom row beside zoom controls, without adding another bar above the tracks.
- Reworked the minimap, viewport frame, and zooming through its edges. **Whole scene** accounts for the actual window and panel size. Fixed zoom limits and alignment when resizing windows or panels.
- Creating, moving, resizing, keyboard nudging, and bulk operations are bounded by the video duration. The area beyond the video is marked, and invalid operations are explained.
- Visible line numbers follow chronological timeline order while internal identifiers and existing recording associations remain intact.
- Fixed group moves between roles, pointer alignment during scrolling and zooming, gesture cancellation, and time locking. A failed group operation must not move only part of the selection.
- Replaced ordinary checkboxes with spaced toggles, including silence trimming and the export-completion sound. Removed excess spacing and paired dividers while preserving useful section boundaries.
- Fixed jittering text in dropdowns. Improved selectors, focus, keyboard navigation, and long labels.
- Gave moderator icons a distinct color across themes and made participant readiness indicators more compact and understandable.
- Improved contrast across themes, CC and fullscreen controls, subtitle placement relative to playback controls, subtitle sizing, exiting fullscreen, and restoration of controls.
- Separated personal settings from room and project settings and organized them into categories. Added clearer explanations for unavailable actions and updated first-run help, dialogs, and EN/RU/UK translations.

## Collaborative editing and permissions

- Strengthened shared edit queues, server acknowledgements, and scene/revision binding. A lost acknowledgement, a permission denial, and a genuine conflict are now treated as different outcomes.
- Added reliable recovery of unacknowledged actions after reloads and reconnects, plus conflict review. Retrying an old request must not duplicate an operation that already succeeded.
- Made locks and waits for busy elements clearer; waiting can be canceled. Permission changes, timing protection, and participant departures update which operations are available.
- Timing protection blocks timing changes and line creation as well as single/bulk deletion, deleting lines with their track, and undoing line creation. The server also checks delayed requests. The bulk-delete button is styled red.
- Strengthened Undo, deletion and Trash, group and role restoration, moderator actions, concurrent track reordering, and large scenes. An ordinary rejection must not expose unsafe recovery options.
- Improved shared selections and participant cursors: stale data is cleared, jumping to a participant uses their current position, and display does not depend on matching scroll positions.
- Retained and expanded permission checks for import, casting, clearing/restoring Trash, mixing, effects, and uploads. The interface explains unavailable actions; the server remains authoritative for permissions.
- Fixed races between take deletion, replacement, and upload, as well as scene and nickname changes. Stale responses must not restore deleted audio or alter another participant's recording.

## Connections, media, and diagnostics

- Added a fourth connection method, **Custom tunnel**, marked for experienced users. Dubline starts its normal local server, shows the actual port, and provides instructions for a separately launched HTTPS tunnel. It does not download or start third-party software.
- Cloudflare can be enabled or disabled independently of browsing connection instructions. Switching instruction tabs does not restart the room, change its PIN, or stop a running tunnel.
- Made invitations a compact expandable panel: hide the PIN, copy the link and PIN together or separately, copy the port, and close with Escape or an outside click.
- P2P media sharing now requires **explicit participant consent**. Declining is remembered; if saving consent fails, sharing stays disabled. HTTP and Socket.IO remain fallback delivery paths.
- Added participant indicators for video download/sharing and source preparation, including Porthole/localhost guests, readiness states, and disconnected players.
- Added connection diagnostics: host latency, observed incoming/outgoing traffic, and status explanations. These measure application traffic, not internet connection speed.
- Improved size/hash validation, chunked downloads, reuse of verified cached data, and fallback to the server after failed P2P or direct delivery. Scene data remains unavailable until the required PIN/nickname admission is complete.
- Host playback no longer depends on completion of the host's own download. Fixed source switching, reconnects, cancellation, and late responses from an old scene.
- Moved separate original/background source controls into Audio. Added safe background upload, replacement, and removal with concurrent-change checks. Suitable sources reuse the existing compatible-video preparation path.
- Improved waveform generation and caching, canvas reuse during scrolling and zooming, preparation with bounded concurrency, and cleanup of completed jobs and obsolete sources.
- Compressed text responses from the server and reduced redundant downloads and retained media memory. Strengthened orphan-file cleanup and closure of local databases and resources.
- Fixed Workshop link opening from host and guest windows. Hardened navigation, microphone/fullscreen permissions, and handling of untrusted uploaded files.
- App guests receive a **version-mismatch warning** showing both guest and host versions. It can be dismissed and does not block entry. It also works for older guest builds connecting to an updated host; ordinary browser guests do not receive this warning.

## Video, audio, and subtitle export

- Reworked host and participant video export with **Working version**, **Original quality**, and **Custom** modes, clearer differences, and source-specific limits.
- Full-length working/original exports copy the video stream without re-encoding when supported, encoding the new audio separately. Original video is available only to the host.
- Added export of a **selected time range** with synchronized audio and precise trimming. Video is re-encoded between keyframes when necessary.
- Format/codec, resolution, FPS, and bitrate options account for the actual source and device capabilities. Fixed unavailable choices and messages for non-Chromium browsers.
- Added a personal **hardware acceleration policy: Auto / On / Off** for scene preparation and suitable export operations. Actual support is checked, with CPU fallback if GPU processing fails. Copying an existing video stream does not require GPU encoding.
- Added detailed progress stages: recording preparation, audio mixing/encoding, video copying/encoding, output bytes written, elapsed time, and a warning when no new progress has been reported. Cancellation releases resources.
- Long exports process audio in windows with bounded take preparation. Decoded and processed sources are reused. Fixed decoder delays, window boundaries, and synchronization.
- The Windows app streams the output file to disk in chunks, checking the destination, free space, cancellation, and final save. An incomplete export must not damage a previously existing file. Browser downloads may still require substantial memory.
- Added a real-time audio-export fallback where the required AudioEncoder is unavailable. The interface explains long-scene constraints and unsupported configurations.
- Before exporting, users can review scene readiness, missing files, and technical issues and jump to an affected line. Incomplete dubbing is not unconditionally blocked; hidden takes remain protected.
- Added a compact completed-file report and an optional sound after saving.
- Export uses the **shared project mix**, including effects, RNNoise, pan, volume, and enabled loudness leveling. Personal monitoring does not change the result. Updated stereo character-stem export to WAV ZIP.
- Added separate **SRT / ASS / WebVTT** subtitle export between audio-stem export and the Voxalike pack section. Tooltips explain the formats. Import into another scene has been checked for supported role and timing preservation.
- Retained editable Voxalike pack export with video and subtitles. Takes recorded in Dubline are not included in these packs.

## Installation, updates, and compatibility

- Setup now has a standard installation wizard with folder selection, shortcuts, and `.dubline` registration. A Portable copy can separately register or unregister its own file association without taking over associations owned by other applications.
- Setup and Portable use the same application build. Updates validate hashes and metadata, show progress, request restart safely, and log results. Recording, import, and other active operations are protected from unexpected installation.
- Installed copies support differential updates. Portable uses a verified patch of managed files or a full ZIP, with an external helper, recovery/rollback after failure, and preservation of user files.
- Added an **experimental updates** toggle in the launcher and personal settings. It is **enabled by default in beta builds** and disabled by default in stable builds. An explicitly saved preference takes priority and is independent of the room.
- Disabling experimental updates does not downgrade the application: an installed beta stays until a newer stable version is available. Version ordering supports `beta.1 → beta.2 → 1.4.0`. Steam builds continue to use Steam updates.
- Users of the old standalone EXE must migrate to Setup or Portable ZIP manually. Development builds already labeled `1.4.0` also require manual installation of this first beta because `1.4.0-beta.1` is considered an earlier version.
- Reorganized repository source and tests: application code is in `src/`, with tests in `test/` and `e2e/`. Removed unnecessary internal documentation while retaining the project-format documentation and public release history.
- Expanded unit, server, browser, and native checks substantially. CI uses independent groups and identifies failed scenarios; the release process validates the complete artifact set and prepares a draft before publication.
- Changed the current branch's license to **[DubLine Source License 1.0](https://github.com/dmbai009/dubline/blob/v1.4.0-beta.1/LICENSE)**. Previously published MIT releases, including `1.3.1`, retain their MIT license. Third-party notices and license texts are included in distributions. This beta is not an MIT release.

## Beta limitations

- This is a test release: keep backups. Older application versions are not guaranteed to read newer project formats.
- Chrome and Edge are the supported path for browser participants. Export and audio-device capabilities depend on the browser, operating system, and available codecs.
- Hardware acceleration does not speed up every operation. Audio processing, file verification, video-stream copying, and disk I/O have their own limits.
- Automated checks do not replace testing with real microphones, headsets, networks, and participants' listening feedback.

**Full commit comparison:** https://github.com/dmbai009/dubline/compare/v1.3.1...v1.4.0-beta.1
