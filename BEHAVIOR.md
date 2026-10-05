# Behavior and invariants

## Existing guarantees

- Each line has one current recording. Take sequences enforce newer accepted recordings over delayed older uploads; retries are idempotent.
- Deleting a recording retains sequence history so an old upload cannot resurrect it.
- Editor, recording, and deletion requests are bound to their scene/session and relevant revision or audio URL.
- Queued recordings survive disconnect/reload; starting a new recording requires a live server connection.
- Rename preserves claims, take authors, and relevant ownership in active and inactive sessions.
- Library replacement cannot change media or source archives of scenes already imported.
- Clients cannot mutate host-only state without permission.
- Personal monitoring never alters project mix, recorded audio, video export, or stems.

## Portable project guarantees

- Project data is independent of online users, sockets, credentials, PINs, room passwords, host tokens, P2P state, chat, download progress, and rebuildable caches.
- A project preserves roles/order, line IDs/captions/timing, current recordings and their processing/alignment, source selection, and shared mix.
- Export is a consistent snapshot of metadata and asset bytes. Missing referenced assets fail export explicitly.
- Invalid manifests, unsupported versions, unsafe paths, missing files, oversized data, and inconsistent asset sizes/hashes fail import before any existing session changes.
- A successful import creates a new session; it does not overwrite the current or inactive sessions.
- Voxalike packs and Dubline Projects serve different purposes.

## Workflow guarantees in 1.4

- Single Player and Multiplayer use the same project model; `.dubline` save/open works across both modes.
- For known video duration, every source-line edit obeys `0 <= start < end <= duration` using centralized bounds.
- Mixed-track selection moves relatively and atomically at track boundaries.
- ADR cue volume is local; ADR enabled implies preparation between 3 and 5 seconds.
- Dialogs are centered, reusable, keyboard accessible, and restore focus.

Empty role-space clicks seek in Dub and Edit Mode; double-click creation excludes labels, lines, handles and audio lanes. Out-of-video creation shows an error. Drag/resize and keyboard moves clamp as a group; inspector/server mutations reject invalid bounds. Role-height adjustments are local UI state. Verified direct Workshop downloads must match the imported archive and assets, otherwise existing delivery takes over. See TESTING.md for validation commands and remaining subjective checks.

## Solo feedback corrections

Visible cue numbers follow chronological order, with stable IDs retained for recordings, edits, Undo and portable projects. The video audio-track picker stays below the video and outside timeline scrolling, even when the Audio group is collapsed. Preparation and audible-source buffering are indicated in the transport; preparation belongs to the current video, so a previous scene cannot block the new scene. Fullscreen has one transport control and is allowed only from the trusted room origin in Electron. Hosting tabs remain interactive during asynchronous provider checks; the latest selected mode wins. Waveforms cover the visible viewport with overscan and device-pixel scaling, including QHD displays.

## Disk-backed project IO

.dubline has no fixed aggregate compressed/expanded budget. Working video is limited to 300 MB independently of audio and recordings. Original video retained alongside a proxy is exempt. Manifest/schema/entry bounds, safe paths, CRC, sizes, SHA-256, host/session checks and rollback remain enforced. Immutable disk snapshots preserve concurrent edit/take consistency. Native open, HTTP upload and browser download avoid whole-archive buffering. Temporary free disk space is required; failure is localized. Existing subtitle/take/Voxalike limits remain separate.

## Video optimization and ducking

Oversized custom videos imported locally by the host are automatically optimized. The user-selected original is never modified. The committed session keeps both files and original audio sources; imports remain atomic and cancellation keeps the previous scene. Only the working video is distributed to guests. Source video URLs do not enter public room state and source files are refused by static HTTP serving.

Self-contained .dubline version 2 embeds the original with its size/hash and name; version 1 still works. Open checks playable media and matching durations before committing. Final video export of a proxy project is host-only and copies the original video packets, preserving codec, resolution and quality; failures must be explicit and must not silently export the proxy. Source MKV yields MKV, source MP4 yields MP4. The finished audio uses the shared project mix, independent of personal monitoring.

Auto-duck uses smooth gain changes with a 300 ms attack, a short hold and 850 ms recovery. Ordinary project updates must not snap gains or restart a scheduled ramp. Brief gaps/overlaps stay smooth in playback and offline export.


## Storage migration guarantees

Selection cancellation preserves the existing choice. Live workspace selection changes only the pending folder, so subsequent recordings remain in the current scene until close and are migrated at the next launch. A nonempty target or overlapping/junction paths fail without deleting the source. Disk/copy/preference-commit failures preserve current projects. The new root is committed before old managed directories are removed; an unavailable configured drive never silently falls back to an empty AppData store. Saved .dubline/final exports remain independent of this local app setting. Hard termination can leave redundant staging/old copies.

## Clip mixing

Recording authors may change their own take settings after releasing a role; the host may change any take. Claiming another author's line does not transfer its mixing rights. Legacy unattributed takes use the current line owner. Volume (0–3), stereo pan (−1–1) and effect amount (0–1) are non-destructive shared project state. Amount zero bypasses the preset, including preset pitch and tails, while user pitch remains. Defaults preserve existing centre playback levels.

Bulk controls operate on editable recorded clips in the current selection, across roles. Mixed values are shown explicitly; changing a parameter assigns one absolute value to every target and preserves unrelated settings. The server validates the complete batch, author/host rights, session, audio URL and clip revision before any mutation. A conflict, replacement recording, invalid value or unauthorized target rejects the entire batch. Preview/playback, offline soundtrack and stereo character stems share the clip gain/pan path. Live gain/pan changes ramp without restarting the take; muted clips do not duck the background. Audio processing/cache identity includes effect amount, excluding volume and pan. Portable version 3 stores clip mixes; versions 1/2 import defaults and remain emitted for default mixes. Runtime clip revisions are excluded.
