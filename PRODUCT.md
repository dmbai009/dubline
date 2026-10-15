# Dubline

Dubline is a desktop and browser studio for dubbing scenes together. The Electron host runs a local Node server; guests use a browser or Electron. The existing launcher supports hosting and joining with Cloudflare, VPN, or LAN connectivity.

## Current workflows

- Import a Voxalike pack from disk, the server library, or Workshop; every successful import creates a session, preserving previous scenes.
- Import video with optional Original audio, Background / M&E audio, and subtitles. Video-only import opens Edit Mode for manual roles and lines.
- Edit Mode supports roles, captions, timing, selection, drag/resize, keyboard movement, and per-user Undo.
- Dub Mode lets participants claim roles or individual lines and record in parallel. Each line has one current take, with non-destructive trim, pitch, effects, and alignment.
- Original, Background, and Dub share one project mix. Personal monitoring and microphone preferences affect the listener; exports use the project mix.
- Export a finished video, character stems, or an editable Voxalike pack.

## Projects in 1.4

A Voxalike pack exchanges scene content. A `.dubline` project preserves an active scene's complete working state and embeds its media and current takes. Opening a project creates a new session rather than replacing existing scenes. The archive is independent of network connectivity and contains no room credentials or personal monitoring preferences.

Single Player uses the same local server, sessions, editor, recorder, audio, and export systems. The local host can record every role without claims; multiplayer presence, invitations, passwords, and chat are hidden. The launcher offers New Single Player Project, Host Multiplayer Room, Join Multiplayer Room, and Open Dubline Project. Open chooses Single Player or Multiplayer; Host Multiplayer inside a solo workspace keeps its scene and enables existing PIN/provider controls. The same .dubline archive works across both modes.

## Timeline and preferences

Source lines stay within the actual video duration. Empty track/ruler clicks seek; double-click creates only in Edit Mode on empty role space. Mixed-track groups preserve role spacing and cancel atomically if any member would leave the role list. Vertical drag locks time until deliberate horizontal movement. Individual role heights persist locally and reset with a double-click on the resize handle. Dub shows current recording coverage rather than a source waveform.

My Settings contains microphone, monitoring, local auto-duck, ADR volume/preparation, theme, and layout. Room / Project Settings contains shared mix and host controls; controls without permission remain visible and disabled. ADR enabled means preparation 3–5 seconds; disabled allows 0–5. Workshop clients prefer a verified direct archive and fall back to the existing delivery system.

## Scope

1.4 emphasizes portable projects, workflow, timeline reliability, settings clarity, and regression coverage. Large launcher/theme redesigns are deferred. AI transcription, source separation, voice removal, video editing, director approval, accounts, and cloud project hosting are outside scope.

## Large project storage

.dubline has no aggregate size ceiling. Working video is limited to 300 MB independently of separate audio/recordings. Larger local video imports automatically create an H.264 working copy up to 720p while retaining the original. Final video export on the host copies the original video stream and attaches the project mix. Large project IO uses disk streams and requires temporary free disk space. Existing subtitle/take/Voxalike restrictions remain separate. Full .dubline projects embed both copies (format version 2); legacy version-1 projects remain readable.


## Desktop storage folder

The launcher and My Settings let the desktop host select a parent folder on another drive. Dubline creates a dedicated Dubline subfolder and moves persisted scenes, original/proxy media, audio, recordings, library and server export staging. Launcher changes apply immediately; host changes apply at the next workspace launch, after the current scene has been flushed on close. Saved archives/final downloads retain their chosen destination. Chromium preferences/cache and portable executable extraction remain in their normal system locations.

## Clip mixing in development main

The inspector supports per-recording volume, stereo pan and effect blend, individually or across a multi-selection. Authors control their own recordings; hosts control every recording, in Dub and Edit Mode. Bulk changes set an absolute value and preserve unrelated settings. Processing stays non-destructive; project files, previews, final videos and stereo character stems retain these settings. Changed clip mixes use portable format 3; formats 1/2 remain readable.

## Media / presence hardening

The development build implements durable editor intent and scoped collaboration, atomic semantic leases, decoder-aware media readiness, verified resumable partial seeding and configurable upload/cache budgets. Timeline search/filter/minimap, semantic collaborator cursors, pitch-preserving preview rates, personal master/subtitle controls, Needs Retake and atomic bulk Pitch reuse the existing session, audio and clip editor architecture.

A bounded safe snapshot barrier protects project/Voxalike/archive snapshots. Desktop Save Project uses a fresh native destination each time, the existing streamed serializer and destination-side atomic commit. Workspace autosave/history remains the recovery authority; opening a project imports one scene, and multiplayer host confirms a shared scene switch. A remote guest leaves and imports locally after confirmation.

Windows distribution now builds one core for a per-user NSIS Setup and an extracted Portable ZIP. Explicit channel markers select installed/Portable/Steam behavior. Background downloads never silently install during recording/import/export/pending work. Portable patches and full fallback use verified managed files, an external helper, rollback and crash recovery. Unknown projects/profile/storage are excluded. Setup/Portable use one product identity and single-instance coordinator, with independent owned HKCU document handlers and no UserChoice override. Optional hardware proxy acceleration and transfer graphs remain outside this pass.

Setup uses an assisted Windows wizard with welcome/license pages, a selectable
installation folder, progress and an optional final launch. It creates desktop and
Start menu shortcuts and registers in Windows Installed apps. Installation stays
per-user; updates reuse that installation folder and uninstall preserves user data.


## RNNoise replacement

RNNoise replaces microphone-profile calibration. Scene settings belong to recording authors, with private preview and acknowledged save on settings exit. Existing projects import disabled at 60%; original recordings remain unchanged.


## UI and scene presets

Scene-local shared effect presets support creation by admitted participants and management by their creator or moderators. Copies apply only through the ordinary role/take editor. Unified dropdowns and one-shot audition keep existing recording, RNNoise and project workflows; retake requests belong only to host/moderator authority.


## Live presets and recording workflow

Scene presets may remain live links; common edits are private until saved, while explicit copy/detach preserve independent sound. Next-unrecorded-line navigation, ordinary take-history playback, advisory capture checks, shared voice volume correction (off by default), compact scene review, clearer export choices/results and media retry/cancel states reuse the existing studio. Quality hints are personal and never mark retakes automatically. Shared correction retains manual levels and the same play/export result. See docs/live-presets-workflow.md.


## Adaptive inspector and compact effects

The inspector uses its available panel width for one, two or three columns while retaining existing recording, history and mix controls. Scene presets can be linked directly from the inspector. The current single-chain workflow replaces the complete own chain after confirmation, preserving recording/mix/inheritance settings; editing creates a private modified variant. See docs/single-effect-chain.md. The compact full editor retains chain dragging/presets and adds built-in preset icons; portable format 12 preserves optional icon metadata. The former single-role timeline selector is replaced by the existing multi-role filter. See docs/inspector-refresh.md.


## Studio UX corrections

The effect sidebar grows with the workspace while preserving chain space and four-card rows. Line/role terminology, recording/voice headings, compact history placement and themed silence-trim switches use the existing editor/audio controls. The sequence recorder and historical A/B dialog are removed. Next line wraps within the current owned role before moving to another owned role, reveals the target without changing saved filters and never starts recording. Requested retakes use the minimap warning color on the timeline. Completion checks sit before player names; moderators use a contrasting blue shield. Fractional-zoom dropdown positioning is stable, invitation copy-with-PIN shares its PIN row and fullscreen subtitles clear the actual wrapped transport height. See docs/studio-ux-fixes.md.


## Export progress

Video export reports completed recording counts, audio/video timeline positions, acknowledged output bytes and elapsed/quiet time, with a 15-second no-new-progress notice and cancellation. The fast mode labels video copying explicitly. Recordings prepare in bounded pairs through existing audio pipelines; RNNoise worker/cache limits and exported sound remain unchanged. See docs/export-progress.md for measured preparation speed, validation and limits.
