# Dubline 1.4.0-beta.2

The second public beta of Dubline 1.4 focuses on recording alignment, subtitle handling, export memory use, and collaboration reliability. The changes below are relative to **1.4.0-beta.1**. For the full 1.4 feature overview since 1.3.1, see the [first beta changelog](https://github.com/dmbai009/dubline/blob/v1.4.0-beta.2/docs/releases/RELEASE_NOTES_1.4.0-beta.1.md).

This is a **pre-release**. Keep backups of important projects; beta versions may contain bugs and receive frequent updates.

## Download for Windows x64

- **[Setup](https://github.com/dmbai009/dubline/releases/download/v1.4.0-beta.2/Dubline-1.4.0-beta.2-win-x64-Setup.exe)** — the Windows installer, with folder selection, shortcuts, and updates for the installed application.
- **[Portable ZIP](https://github.com/dmbai009/dubline/releases/download/v1.4.0-beta.2/Dubline-1.4.0-beta.2-win-x64-Portable.zip)** — extract the archive and run `Dubline.exe`. Keep the whole extracted folder together.

Download only the distribution you use. The other release assets support automatic updates and integrity checks; they do not need to be downloaded manually. There is no separate standalone Portable EXE.

## Recording alignment

- Fixed take alignment when microphone capture or video playback starts later than requested. Saved takes now use the actual capture/playback relationship rather than the planned start time.
- Recording preparation waits for the recorder to start. Playback alignment is retained separately for each take, including while earlier recordings are being uploaded.
- Preserved captured audio before the first video frame instead of clamping it back to the old start boundary. Manual timing adjustments use the same permitted boundary on the client and server.
- Added regression coverage for delayed recording/playback and takes near the beginning of a scene.

## Subtitles and character audio export

- Fixed multiline captions in the video overlay: line breaks are preserved and long text wraps correctly.
- Fixed `timeline.tsv` in character-stem exports. Captions and role names containing tabs, line breaks, or quotation marks no longer break the table's fields.
- Reduced memory use during character WAV-stem export by rendering and compressing audio in bounded windows instead of retaining full-scene audio buffers for every character.
- Added ZIP64 packaging for stem archives and protection against overlapping stem exports. The compressed archive, source media, and recording caches still require storage and memory; individual WAV files retain the RIFF size limit.
- Stem rendering continues to use the project mix and take processing, without adding original/background tracks or applying the private video selection range.

## Collaboration

- Improved delivery of the final collaborator cursor position when a lossy cursor packet is dropped or rate-limited. A stopped pointer is less likely to remain on the previous role track.
- Cursor retries are bounded and stop when idle, hidden, disconnected, or switching scenes.

## Verification and release process

- Balanced browser tests using measured Windows CI durations and expanded them from three to six parallel groups.
- Split native Electron checks into three independent groups. Regular CI and release verification now share the same check definitions.
- Release packaging and installation/update checks run alongside the other tests. Draft release uploads still wait for every required check and artifact verification to succeed.
- Removed the duplicate ordinary CI run for release tags; the release workflow runs the complete shared checks instead.
- Corrected race-prone browser checks for competing recording claims and project snapshots after a participant disconnects, without weakening the application assertions.
- Added checks that every browser suite is scheduled exactly once and that failed verification cannot proceed to release upload.

## Updating from beta.1

- Keep **Receive experimental updates** enabled in the launcher or My Settings. Beta builds enable it by default unless you previously saved a different preference.
- Setup users receive the installed-app update. Portable users receive a verified patch when their managed files match the previous release, with a full ZIP fallback when needed.
- The update keeps the existing workspace and personal settings. Wait for recordings, imports, and exports to finish before restarting to apply it.
- Stable **1.3.1** remains the default download for users who have not opted into experimental updates. This beta does not downgrade or replace that stable release.
