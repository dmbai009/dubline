<div align="center">

<img src="public/icon-256.png" alt="Dubline" width="180">

# Dubline

**Dub scenes with friends, all at the same time.**

![Windows](https://img.shields.io/badge/Windows-portable%20.exe-0078D6)
![Browser](https://img.shields.io/badge/guests-Chrome%20%7C%20Edge-F4B400)
![Languages](https://img.shields.io/badge/UI-EN%20%7C%20RU%20%7C%20UK-8B5CF6)
![License](https://img.shields.io/badge/license-MIT-22C55E)

</div>

Dubline is a collaborative desktop and browser-based dubbing studio and party game. Friends can claim characters or individual lines, record in parallel, review takes on a shared timeline, and export a finished video or DAW-ready character stems.

The project is inspired by Voxalike and The Choicer Voicer, while removing the need for players to record one after another.

## What's new in 1.4.0

- **Project storage folder:** select another drive in the launcher or My Settings. Existing originals, working videos, takes and library move automatically; a change during a session applies after restart.
- **Single Player:** create a local project, edit and record all roles without claims. Host Multiplayer keeps the current scene and enables existing network/PIN workflows.
- **Portable projects:** save the active scene with video, Original, Background / M&E, current takes, captions, timing, effects and shared mix as .dubline. Open from the launcher in Single Player or Multiplayer, or from Files & Export. Invalid imports preserve existing scenes.
- **Reliable timeline:** all edit paths respect the video duration. The striped area marks its end; empty clicks seek. Mixed-role selections move relatively and atomically; vertical drag locks time. Resize each role locally with the handle; double-click the handle to reset.
- **Clear preferences:** My Settings controls your microphone, ADR and monitoring; Room / Project Settings shows shared mix and disabled controls where permission is missing. ADR volume is local; three beeps enforce 3–5 seconds preparation.
- **Workflow polish:** centered keyboard-accessible dialogs, Background terminology, current-take coverage display, readable light-theme lines, verified direct Voxalike delivery with P2P/host fallback.

See [release notes](RELEASE_NOTES_1.4.0.md), [project limits/schema](docs/project-format.md), and [testing guide](TESTING.md).

### Start and continue a project

Choose New Single Player Project in the launcher. Import video in Files & Export, add optional Original/Background or subtitles, add roles and captions in Edit Mode, then switch to Dub and record. Save Dubline Project includes portable media and current server takes. Finish pending uploads before saving. Open Dubline Project lets you select Single Player or Multiplayer; inside an open solo workspace, Host Multiplayer selects the existing connection provider without losing the scene. A saved project contains one scene; save other sessions separately. There is no aggregate .dubline archive/expanded-data size limit. Working video is limited to 300 MB, independently of separate audio and accumulated recordings. Larger local MP4/MKV videos are automatically optimized up to 720p; the original stays on the host and is used for final video export without re-encoding its video stream. Complete .dubline projects embed both versions (format v2); older v1 projects still open. Save/open/download use disk streams and need temporary free disk space.

## What's new in 1.3.1

- **Editor fixes:** Alt + Up/Down moves selected lines between role tracks. Adding roles and renaming roles or scenes use working in-app dialogs in the desktop app. Escape closes panels even while a text field has focus.
- **Create lines on the timeline:** in Edit Mode, double-click an empty area of a role track to create a line at that position, select it in the inspector, and edit its caption. Creation supports Undo and respects video bounds, zoom and scrolling.
- **Reliable takes and sessions:** delayed uploads cannot replace newer takes or resurrect deleted audio. Scene changes, nickname changes and restarts preserve the correct take, owner and media; local playback and export use the selected scene's sources. Starting a new recording requires a server connection; recordings already in progress and queued takes survive a disconnect.
- **Safer packs and editing:** replacing a library pack preserves existing scenes, and invalid imports leave the library intact. Captions up to 2,000 characters, quoted or multiline pack metadata, negative take offsets, 150 % mixer levels, live prompter edits and unusual role/nickname names are handled consistently.
- **More regression coverage:** server, browser and native Electron tests exercise these fixes, including concurrent uploads, persistence, permissions and real audio exports.

## What's new in 1.3.0

- **Studio audio tracks:** Original, Background / M&E and Dub live above character tracks, on the same timeline. Source waveforms are built in the background and cached. The Audio group starts collapsed so the role tracks stay in view; it and the player lobby can collapse independently. Source captions distinguish audio from video (including the selected embedded track) from separate audio files.
- **One shared project mix:** volume, mute, solo, auto-ducking and millisecond source offsets persist with the session and synchronize between players. Channel levels go up to 150 %. Video export and character stems use project levels; each listener can instead select **My monitoring** for a private mix that never changes the export — a player without the right to change the project mix is switched to it automatically when they move a level. A change that meets someone else's newer edit is re-sent on top of it instead of being dropped.
- **Flexible scene import:** video is required; original audio, background and subtitles are optional. Video-only scenes open in Edit Mode for manual line creation. Existing Voxalike packs and embedded MKV subtitles remain supported.
- **Permanent transport:** play/pause, ±3-second seek, time, expanded video and fullscreen; Space, J/K/L and F respect text fields and Watch Together host permissions.
- **Tighter lip sync:** a separate Original or Background / M&E source follows the video within about 20 ms by adjusting its speed by up to 5 % (pitch is preserved) instead of jumping; it only seeks after a large drift, a source change, play or seek.
- **Shared and personal auto-ducking:** the project setting is used by everyone and by export; each player can switch on their own auto-ducking, which applies only to what they hear.
- **Optional ADR cues:** three beeps one second apart, with the silent fourth beat at the line start. Off by default; when enabled, preparation is at least three seconds, including near 0:00. Cues go only to headphones/speakers, never directly into takes or exports, and are re-timed to the video once playback really starts (after a seek, buffering or the held first frame).
- **Compact participants and recording settings:** initials, status tooltips and download progress remain visible in the collapsed lobby. Microphone-delay controls moved to Settings; Shift+drag still works.
- **Cleaner import form:** themed file pickers in the interface language; an import larger than the limit is refused from its size before any file is read into memory.
- **English on first launch:** the selected language persists in the browser and desktop app, including when the desktop server chooses a different port or a desktop guest joins a new host address.
- **Safer recording and exports:** playback failures stop recording with a clear notice; transient audio downloads can retry. Exports keep one snapshot of project levels, timing and takes, and report unavailable audio instead of silently omitting it. Recording and video export cannot overlap, and delayed recording callbacks cannot affect a newer take. ADR beeps use the audio clock, independently of UI frame updates.

## What's new in 1.2.2

- **Drafts merge instead of blocking:** if someone (or you, by dragging or with the arrow keys) changes a different field of the line you are editing, your draft takes the new value and stays saveable. Only the same field changed on both sides is a conflict, and you can now keep your version or load the latest one.
- **Pack export stops when the host leaves:** closing the tab or losing the tunnel cancels the export at once instead of building a ZIP nobody receives. Each room has its own export slot, so hosts of different rooms no longer block each other.
- **Skipped subtitle lines are reported:** cues with a missing, reversed or zero-length time are counted on import; the host sees a warning and the room chat gets a notice.

## What's new in 1.2.1

- **Millisecond timing:** import and edit timestamps with three decimal places; short subtitle cues keep their original duration.
- **Safer editor drafts:** room updates and selection changes preserve unsaved text and timings. Conflicting edits show the latest server version without discarding your draft, and invalid timings are explained next to the fields.
- **Smoother recording preparation:** adjust the buffer in 0.1-second steps. Lines at 0:00, 0:01 or 0:03 receive the full configured preparation time; canceling preparation clears pending playback and speech timers.
- **Clearer pack exports:** line-by-line progress, one export at a time per host, and the correct ZIP filename even when the scene changes during export.

## What's new in 1.2.0

- **Shared Edit Mode:** create, resize and move source lines, edit captions, add and rename role tracks, and undo your own changes. The host switches the whole room between Edit and Dub Mode; Dub Mode keeps source editing locked while allowing take alignment and host-created role tracks.
- **Voxalike pack export and Workshop import:** export the edited scene as a compatible ZIP, or open a Workshop pack link with a cached copy on the host.
- **Random Cast and Blind Mode:** distribute speaking roles among online players, and hide other players' takes until the host reveals them.
- **One-second preparation by default:** change the pre-recording buffer from 0 to 5 seconds in Settings; lines near 0:00 also get the full preparation time.
- **Six visual themes**, download progress in the lobby, a refreshed inspector, video-only fullscreen and an expanded video view.
- **Editor reliability fixes:** revision-checked edits and deletion, consecutive Undo, safe handling of lost replies and session changes, and consistent pack-export snapshots.

## Features

- **Self-contained Windows app.** The portable `Dubline.exe` starts the local Express/Socket.IO server, chooses a free random port, and offers three clear connection modes: Cloudflare, Porthole, or VPN (Radmin/Hamachi). It stops every bundled background process when the window closes. The host does not need Node.js, FFmpeg, or cloudflared installed.
- **Desktop guest mode.** The same EXE can join a friend's private Radmin or Hamachi address and enables the microphone only for that exact origin. It gives VPN users a secure-context-compatible alternative to opening an unencrypted private address in a normal browser.
- **Manual update notice.** On startup, the desktop app checks the latest stable GitHub Release. If a newer semantic version exists, a dismissible corner notice opens its fixed GitHub release page; Dubline never downloads or executes updates automatically, and network/API errors stay silent.
- **Protected desktop room.** Every app launch generates a new four-character PIN. The public link and masked PIN sit in the top-left invitation panel; guests enter their nickname and PIN before any room state or media URLs are sent. The desktop app hosts exactly one room: a link with any other `?room=` leads to the same PIN prompt instead of a new unprotected room. Scene videos, takes and the pack library are served only to the host and to devices that entered the PIN (and were not kicked). A private per-launch token guarantees that only the local Electron window receives host rights.
- **Parallel recording.** Every player can claim and record their own lines without waiting for other actors.
- **Studio layout.** A player lobby on the left, video, inspector and chat on top, and the timeline below. Drag the dividers to resize any panel (double-click resets it); sizes are remembered per browser.
- **Lobby and progress.** Players are listed as cards with online/recording/sharing/downloading status, video download progress, host and “you” tags, and how many lines each has claimed and recorded. Players who left but contributed stay visible, dimmed. The overall “dubbed N / total” progress is shown in the lobby and above the timeline.
- **Timeline zoom.** Ctrl+mouse wheel zooms around the cursor; the toolbar has −/+ and “Whole scene”. The ruler adapts its tick spacing to the zoom level.
- **Per-player microphone delay.** Bluetooth headsets make takes sound late. Each player has one delay correction applied to all their takes, in playback, video export and stems: adjust it with ±10 ms in Settings, or Shift+drag any of your takes on the timeline to move them all at once. Lobby cards show the current value without technical buttons.
- **Peer-to-peer video sharing.** Players who open the room through the tunnel download the scene video and backing track in full, taking 64 KB pieces directly from other players over WebRTC and only the missing pieces from the host. The file is checked against the server’s SHA-256, played locally, and then shared onward, so the host’s upload is used roughly once instead of once per player. “Watch now from the host” skips the wait; the feature can be turned off in settings. Room state still lives on the host’s server.
- **Rooms and live synchronization.** Packs, roles, takes, host state, and chat are synchronized through Socket.IO. Add `?room=your-room` to the URL to create a separate session.
- **Sessions.** Every import (ZIP pack, video + subtitles, or a mod launched from the library) creates a new session in the room; older sessions keep their scene, roles and takes. The host switches, renames and deletes sessions from the 🎬 menu in the header; everyone sees each session’s progress and last change. Deleting asks for confirmation and removes the session’s takes and scene files (shared pack folders are kept while another session uses them; archives in the mod library are never deleted). Rooms from older versions become a single session automatically.
- **Persistent state.** Rooms and sessions are stored in `data/rooms.json`; uploaded media and takes stay available after a server restart.
- **Host controls.** The first participant becomes the room host and can change scenes, pause playback for everyone, or release stale role claims. Pausing everyone asks for confirmation if someone is recording right now.
- **Watch together.** The host plays the finished scene for the whole room at once: a 3-second countdown, a start synchronized to the server clock, and periodic drift correction. Pause and seeking follow the host; recording is disabled until the host stops the screening.
- **Live recording status.** Everyone sees which line is being recorded and by whom: the tile pulses red and the player gets a 🔴 in the online list.
- **Connection banner.** If the tunnel or server drops, players see “No connection, reconnecting…” and the page rejoins the room automatically when the server is back.
- **Takes are never lost to a dropped connection.** If an upload fails (network drop, tunnel 502), the take is kept in the browser (IndexedDB, survives a page reload), marked ⏳ on the timeline, and re-sent automatically with backoff and as soon as the connection returns. The server recognizes a repeated upload and never stores it twice; a late take lands in the session it was recorded in, even if the host has switched sessions.
- **Room password and kicking.** The host can set a room password in Settings (players already inside stay; new devices enter it once; five wrong attempts block a device, and 20 wrong attempts from all devices within 10 minutes stop new players for a while, so the password cannot be guessed by reconnecting; only a salted scrypt hash is stored) and remove a player with ✖ on their lobby card. Kicked devices cannot rejoin until the host allows it.
- **Host event log.** The server console prints who joined or left (with the reason, e.g. closed tab vs. lost connection), saved takes, pack changes, rejected requests, and errors; the host also receives the same log in the browser console (F12). An error in one handler is logged instead of taking the whole server down.
- **Play video from your own disk.** Download buttons show the file size; a player who already has the pack `.zip` or scene video can pick it in *Files & Export*, and the video then plays (and exports) from their computer instead of through the host’s tunnel.
- **Studio recording tools.** Pre-roll, microphone gain, optional browser noise/echo suppression, silence detection, waveform previews, non-destructive trimming, and manual take alignment.
- **Non-destructive voice processing.** Robot, radio, monster, thoughts, cave, behind-a-door, and megaphone effects plus a ±12-semitone pitch shifter are applied during playback and export without modifying the original recording. Delay and reverb tails are preserved in playback, video mixes, and WAV stems.
- **Multiple audio tracks.** If the video has several audio tracks (e.g. Japanese and Russian in an anime episode), the server extracts each one (AAC is copied, other codecs are converted) and the host picks which track plays as Original or Background / M&E, or none, inside the Audio group. Single-track video with codecs such as ALAC or AC3 gets a browser-compatible AAC soundtrack too; a silent video is identified by the server rather than inferred from a browser decoding error. The choice applies to everyone and to export, and survives restarts. A separate imported Original source takes precedence over embedded tracks.
- **Separate Edit and Dub Modes.** The host switches the whole room's mode. In Edit Mode every participant can create source lines, edit their captions and bounds in the inspector, resize their edges, drag them onto another role track, add tracks or rename/merge a whole track. Ctrl+click / Shift+click select several lines or a range. Changes are revision-checked; Ctrl+Z undoes your own edits without overwriting later source edits by others. Undo history is kept in memory (up to 200 operations per session) and resets on server restart. In Dub Mode source editing is disabled: players align their recorded takes, and the host may still add a role track. Overlapping lines of one character are stacked into lanes. Entering Edit Mode stops an active recording and queues its take until dubbing is available again.
- **Random Cast.** The host randomly distributes roles with lines among online players. Empty editor tracks are ignored; existing takes are kept.
- **Editor drafts and precise timing.** Unsaved inspector text and timings survive room updates and line selection changes within the open page. If the line changes meanwhile (someone else's edit, or your own drag, arrow keys or Undo), fields you did not touch take the new values and your draft stays saveable. Only when the same field was changed on both sides does a conflict notice appear: keep your version to save it over the latest one, or load the latest version. Drafts are not persisted across page reloads. Timing fields support milliseconds and explain invalid bounds inline. Short imported subtitle cues keep their original duration, including cues shorter than the 0.1-second minimum for new lines.
- **Blind Mode.** The host can hide other players' takes for the scene, or each player can hide their own takes. The host's “Reveal all” makes current takes listenable; a new recording is hidden again. This is a UI spoiler-prevention feature, not server-side access control.
- **Six local themes.** Midnight, Graphite, Light, Ocean, Forest and Sunset can be selected in Settings; each device remembers its own choice.
- **Larger video views.** Low-resolution video fills the available area while preserving its aspect ratio. Use the expand button for a larger in-window view or fullscreen to hide the surrounding workspace, including during watch-together.
- **Three-channel project mixer and private monitoring.** Control Original, Background / M&E and Dub on their timeline rows. Project settings are shared; My monitoring is private and never affects export. Levels go up to 150 %. Source offsets support three decimal places; mute and solo work across the three channels.
- **Auto-ducking.** Background and original audio fade down over 80 ms while a take plays and recover over 250 ms. The project setting is shared and used by exported mixes; in Settings each player can also turn on **My own auto-ducking** with its own strength, which only affects what they hear.
- **Visual recording countdown.** After pressing Record the video rewinds by the configured preparation time (1 second by default, adjustable from 0 to 5 seconds in 0.1-second steps in Settings). Near 0:00 the first frame is held for the missing part of the buffer. A thin bar sweeps across the video and three dots light up, then a red “Speak!” appears when the line starts. The visual cue is silent and can be turned off independently of the preparation time.
- **Recording follows your voice.** Recording does not stop at the end of the original line: if your phrase is longer, keep talking — it stops by itself after 0.8 s of silence (at most the line length, minimum 4 s, past the line end), or when you press the button again. Auto-trim keeps quiet word endings.
- **Built-in guidance.** A short “How to play” guide (headphones, claiming, recording, listening, timing, watching together, hotkeys) opens on the first visit and from the ❓ button. Silent dead ends now show a hint instead (e.g. pressing R with no line selected, or on someone else’s line), and a denied microphone explains how to re-enable it.
- **Video prompter.** The active character, line, and phrase progress are shown over the video. When several characters speak at once, all simultaneous lines are shown (up to four, then “+N more”); while recording, your line comes first and the others are dimmed. The overlay can be disabled or resized.
- **Fast browser export.** On supported browsers, WebCodecs and Mediabunny pass the encoded video stream through without re-encoding and create a new mixed audio track. A real-time fallback is available when WebCodecs cannot be used.
- **REAPER/DAW stems.** The browser renders one full-length, timeline-aligned WAV file per character and packages the files with a TSV cue sheet in a ZIP archive.
- **Voxalike-compatible pack export.** The host exports the edited scene as a ZIP containing video, backing audio when present, and INI/WAV files for each line. Clean original voice files are preferred; otherwise line audio is cut from the selected original soundtrack. Recorded dubbing is exported separately as video or DAW stems. Export uses a scene snapshot, so collaborative edits cannot mix different versions inside the ZIP. Progress shows completed lines. Each room runs one pack export at a time (at most two at once on the whole server, because the ZIP is built in memory), and the export is cancelled as soon as the host disconnects.
- **Room chat.** Includes persisted history, unread counts, and localized system notifications.
- **English, Russian, and Ukrainian UI.** First launch defaults to English. The selected language is remembered locally; desktop hosts, guests and the launcher share an app-level preference across changing server ports and host addresses.

## Import formats

### Voxalike-compatible ZIP packs

Dubline understands standard Voxalike and The Choicer Voicer scene archives. It looks for:

| File | Purpose |
| --- | --- |
| `dub_video.mp4` | Scene video |
| `*_backing_track*` | Music and ambience |
| `*.ini` / `*.txt` | Captions, characters, and timestamps |
| `*.wav` / `*.mp3` / `*.ogg` | Original line audio |

The library cache lives in `public/packs/`. Each imported scene uses its own content-addressed archive and path-safe, flattened media folder below `public/uploads/`, so replacing a library entry cannot overwrite media used by existing scenes.

### Voxalike Workshop links

In **Files & Export**, the host can paste a pack page link from `https://voxalike.com/workshop`. Dubline downloads and validates the ZIP on the host; reopening the same link reuses its cached archive rather than downloading it again. Workshop availability is required for the first download, but not for an already cached copy. A pack downloaded under an unrelated filename is not automatically recognized as this cache entry.

### Custom scenes: video, audio and subtitles

The import dialog also accepts:

- MP4 or MKV alone (an empty shared Edit Mode scene);
- MP4/MKV plus optional ASS, SSA, SRT or VTT subtitles;
- optional Original audio and/or Background / M&E (WAV, MP3, M4A, AAC, OGG, OPUS or FLAC), normalized to browser-compatible AAC;
- MKV with embedded subtitles when available.

Without separate Original audio, the video's selected audio track is used. Background / M&E is optional. Working video is limited to 300 MB; larger originals are optimized automatically and preserved for final export. Separate audio does not count against the working-video budget. Subtitles are limited to 20 MB. These limits are shown in the import form. Remote uploads still follow the displayed tunnel transfer restriction; large files should be opened/imported locally on the host.

Use **Project mix** on the Audio tracks to change the shared playback/export mix (host in Dub Mode, any collaborator in Edit Mode). **My monitoring** changes only this device's listening mix; switching back to Project mix lets you hear the exported balance. When a player who cannot change the project mix moves a level, mute or solo, Dubline switches them to My monitoring, starting from the current project mix. Source offsets always belong to the project: a positive offset delays the source, a negative one trims its beginning. Audio collapse does not affect sound. Editable Voxalike pack exports contain source/reference assets rather than the recorded final mix; video and WAV stems are the dubbing outputs.

ADR is independent of the silent visual countdown. Enable it in Settings only when needed, and use headphones: although cues never connect to the recording/export graph, a physical microphone can still pick up speakers.

For MKV input, the bundled `ffmpeg-static` binary extracts the first supported subtitle stream and remuxes video into MP4 without video re-encoding. Audio is copied when MP4 supports its codec and converted to AAC only when necessary.

Cues with a missing, reversed or zero-length time are skipped; the host sees how many in the import status and the room chat gets a notice. ASS imports use the Aegisub `Name` field for the character; typesetting drawings (`\p1` vector shapes) and comment lines are skipped, and `\N` / `\h` become spaces. When an MKV has several subtitle tracks, the importer prefers full/dialogue tracks over signs, songs and forced ones (the choice is written to the server log). In Edit Mode participants can delete lines that should not be dubbed (on-screen signs, song lyrics) from the inspector or for a whole selection; deleted lines go to the session trash (“🗑 Deleted (N)” on the timeline toolbar). The host can search it, restore lines with their takes or delete them forever. Ctrl+Z or “Undo” in the notice restores your own last editor operation. The trash keeps the last 50 deletion batches per session; take files are removed permanently when an entry is purged or its batch ages out of this limit. SRT/VTT lines may use prefixes such as `Alice: text`, `[Alice]: text`, or `(Alice): text`. Without a separate Original source, video sound belongs to the Original channel and participates in project auto-ducking; a missing Background / M&E track is simply silent.

## Requirements and installation

With the default Cloudflare method, only the host needs the app and friends open its HTTPS link in Chrome or Edge. Alternative connection methods may require Porthole or the same VPN client on both sides; Radmin and Hamachi guests also open `Dubline.exe` in guest mode so their microphone works. Other browsers (Firefox, Safari) are not supported yet and show a hint to switch; wired headphones are recommended, since Bluetooth headsets drop to low sound quality while the microphone is on.

### Windows desktop app

Download and run **`Dubline.exe`**, then choose **Create a room** or **Join as a guest**. A host chooses one of three connection methods before entering a nickname:

- **Cloudflare (recommended):** creates and checks a public HTTPS link automatically. If the tunnel cannot start, Dubline opens a visible warning with the alternatives.
- **Porthole:** install the free Porthole app from Steam on both computers, join the same lobby, and set its TCP port to the port shown by Dubline. The guest opens the copied `localhost` link in Chrome/Edge, where microphone access is allowed.
- **VPN (Radmin VPN or Hamachi):** everyone joins the same private network using either client. Dubline automatically picks up the active adapter and its address. The host copies that address; each friend starts `Dubline.exe`, chooses **Join as a guest**, and pastes it. This restricted window grants microphone permission only to the selected private origin.

The server selects a free port at random from `38473–38637` and displays it in the invitation panel and connection instructions. The host can switch methods while the room is running without losing its session. Dubline detects whether Porthole, Radmin, or Hamachi is installed/running and whether a VPN address is available; a successful guest connection is the final reachability confirmation.

Wait until the invitation panel says that the link is ready, then copy the invitation and PIN. The PIN is masked until the host enables **Show**, and **Copy link and PIN** does not reveal it on screen.

Rooms, imported media, and takes are stored in the app's Windows user-data folder and survive restarts. Closing the native window shuts down the local server and tunnel.
The **Clear all Dubline data** button in Settings removes every saved room, take, imported video, server pack, and local browser cache after an explicit confirmation, then restarts the app with an empty room.

## Known limitations and troubleshooting

Dubline is ready for normal fandub sessions, but it is still a self-hosted application: the host's computer, connection, and free disk space remain part of the room. These are the main issues to expect:

| Problem | What to do |
| --- | --- |
| **Cloudflare stays on “Connecting” or friends cannot open its link.** Quick tunnels may be blocked or unstable on some providers and in some regions. | Switch the running room to **Porthole** or **VPN** from the hosting dialog. Switching methods does not delete the room or its current session. |
| **Porthole, Radmin, or Hamachi is not detected.** Installation detection alone does not prove that the connection is reachable. | Start the selected client first. In Porthole, join the same Steam lobby and enter the exact TCP port shown by Dubline. With Radmin/Hamachi, join the same private network and wait for its adapter to receive an address. Also allow Dubline on private networks in Windows Firewall. |
| **A guest can open a VPN address but the microphone is unavailable.** Chrome and Edge do not grant microphone access to ordinary private `http://` addresses. | The guest must start the same `Dubline.exe`, choose **Join as a guest**, and paste the VPN invitation there. Do not use a normal browser tab for a Radmin/Hamachi address. Cloudflare HTTPS and Porthole's `localhost` address can be opened normally. |
| **Windows SmartScreen or antivirus warns about the EXE.** The current portable build is not signed with a commercial code-signing certificate, and Electron apps are comparatively large. | Download Dubline only from the official [GitHub Releases](https://github.com/dmbai009/dubline/releases) page. Antivirus scanning can also make the first launch or a local build take longer. |
| **A large or long MKV takes time and temporarily uses a lot of disk space.** Dubline remuxes the video without re-encoding when possible, but may need to convert audio, extract tracks, and keep both the source and processed file during import. | Keep several gigabytes free for an episode or film and wait for processing to finish. H.264 video is the safest option; HEVC/H.265, especially 10-bit video, may not play in Chrome/Edge even after a successful MKV-to-MP4 remux. |
| **Exporting a 20–120 minute episode or film consumes a lot of RAM or fails.** Browser video export and full-length WAV stems are assembled locally; long projects may require several gigabytes of memory and disk space. | Prefer short scenes, close memory-heavy applications, and export one scene at a time. Dubline shows a warning once a scene reaches 20 minutes. |
| **A large upload fails through the public link.** Cloudflare tunnel requests are limited to roughly 100 MB, and unstable connections may interrupt long uploads. | Import large media on the host computer itself, use a local/VPN connection, or let players select the same video/pack from their own disks. Failed voice takes are different: they remain in IndexedDB and retry automatically. |
| **Dubline data keeps growing on drive C:.** Imported videos, extracted audio tracks, packs, takes, room history, and browser caches are intentionally persistent. Development copies additionally contain `node_modules`, Electron caches, and `dist` builds. | Remove individual sessions you no longer need or use **Settings → Clear all Dubline data** for a complete reset. This deletion is permanent, so export important takes first. |
| **A room disappears after moving to another computer.** Rooms are stored locally on the host and are not synchronized to a cloud account. | Keep the original host data folder or export the material before clearing, reinstalling, or changing computers. There is currently no automatic cloud backup. |
| **Firefox or Safari behaves differently.** Recording, WebCodecs export, P2P media sharing, and permission handling are developed and tested for Chromium. | Use a current Chrome or Edge browser, or the Windows desktop app. |
| **An editor action times out or conflicts with another player.** Its server outcome may be uncertain; dependent queued actions are canceled instead of being blindly repeated. | Reconnect and inspect the refreshed scene before repeating an action. A rejected conflicting edit or deletion leaves the server's current lines intact. |
| **A Voxalike pack export is refused for size.** Export is limited to 2,000 lines, 10 minutes per line and an estimated 384 MB of uncompressed video, backing and PCM audio. | Export shorter scenes and avoid simultaneous exports on a low-memory host. These limits are separate from browser video/stem export. |
| **Blind Mode does not keep audio secret.** Takes are hidden by the client UI, not withheld from authorized room members by the server. | Use it to prevent accidental spoilers among trusted friends, not for confidential recordings. |

If a connection still fails, first verify that the host window is open, the invitation address and port have not changed, and every participant is using the same Porthole lobby or VPN network. The host can open the developer console with `F12`; connection, import, take, and security events are written there and are useful when reporting a reproducible bug.

### Build the portable EXE

```bash
git clone https://github.com/dmbai009/dubline.git
cd dubline
npm install
npm run dist
```

`npm run dist` downloads the pinned official Windows `cloudflared` binary, verifies its SHA-256, and creates `dist/Dubline.exe`. The portable file includes Electron, `ffmpeg-static`, and `cloudflared`; the build does not include local `data/`, uploaded scenes, takes, or server packs.

To publish an update, increment `version` in `package.json` and `package-lock.json`, build and smoke-test `Dubline.exe`, then create a stable GitHub Release in `dmbai009/dubline` with a matching tag such as `v1.3.1` and attach the EXE. A tag without a GitHub Release, a draft, or a prerelease does not trigger the in-app notice.

### Legacy browser server (one click)

1. Download the project: **Code → Download ZIP** on GitHub (or `git clone`), and unzip it.
2. Double-click **`start.bat`**. On the first run it:
   - offers to install Node.js LTS via `winget` if Node.js is missing;
   - installs the dependencies automatically (again only when they change after an update);
   - starts the server and opens <http://localhost:3000> once it is ready.
3. Double-click **`share.bat`** to get a public link for friends (see below).

If the server is already running, `start.bat` just opens the page.

### Other platforms / manual browser server

- Node.js 20.1 or newer.
- Chrome or Edge is recommended for the fastest WebCodecs export.

```bash
git clone https://github.com/dmbai009/dubline.git
cd dubline
npm install
npm run start:server
```

Then open <http://localhost:3000>.

## Inviting friends without the desktop app

The Electron app handles sharing automatically. When running the legacy browser server, expose it with a free [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/): no account, no warning page, and it handles several players at once.

```bash
cloudflared tunnel --url http://localhost:3000
```

On Windows, just run `share.bat` while the server is running. If `cloudflared` is missing, the script offers to install it via `winget`; if you decline, it falls back to LocalTunnel (`npx localtunnel --port 3000`), which is less stable and shows a password page.

The tunnel prints an address like `https://random-words.trycloudflare.com`. Send friends a room-specific URL:

```text
https://random-words.trycloudflare.com/?room=pizza-night
```

The address changes every time the tunnel restarts. Players simply open the new link and enter the same nickname: a nickname is reserved only while its owner is online, so returning players get their nickname, roles and takes back (and the host gets host rights back).

Uploads through the tunnel are limited to about 100 MB per file (Cloudflare’s limit), so large videos and packs should be imported by the host at <http://localhost:3000>, or a pack `.zip` can be put into `public/packs/`; Dubline explains this instead of failing silently.

Do not share a tunnel publicly. Dubline is designed as a small self-hosted server for trusted groups, not as a hardened public multi-tenant service. The browser server has no PIN: anyone with the link can open their own `?room=` and become its host, and scene files are not access-controlled. Set a room password for anything beyond close friends, or use the desktop app, whose single room and its files are protected by the PIN.

Uploaded files are served with `X-Content-Type-Options: nosniff` and a sandboxing Content-Security-Policy, and packs keep only the media and text files Dubline uses, so a file inside a pack cannot run as a page on Dubline's address.

## Development and tests

```bash
npm test          # fast unit and integrity checks
npm run check     # syntax checks
npm run test:e2e  # browser end-to-end suite
npm run dist      # packaged Windows app
npm run test:electron             # packaged app smoke test
npm run test:electron:guest       # packaged guest language / restricted bridge smoke test
npm run test:electron:cloudflare  # live Cloudflare smoke test
node tools/electron-smoke.js cloudflare --portable # smoke the exact release EXE
node tools/electron-portable-smoke.js             # concurrent portable host / guest regression
```

The 1.3.0 workflow coverage checks the Audio group collapsed on a new device, a guest's level change switching to private monitoring without touching the project mix, ADR beats re-timed after a late video start, 150 % levels, all six optional-source import combinations, manual lines in a video-only scene, atomic rejection of damaged media, waveform caching and true duration, shared mix permissions and stale revisions, private monitoring, real-sample export/stem levels and signed offsets, persistent sessions and layout, expanded audio zoom/scroll, transport keys and watch authority, and three ADR beats near zero with cancellation. Source captions are checked for imported files, embedded track changes, silence and all three UI languages. A six-case export matrix checks Original only, Background / M&E only, Dub only, Background / M&E + Dub, Original + Dub, and all three channels: frequency analysis of the offline mix and final encoded MP4 verifies channel presence, mute/solo, relative project levels and independence from private monitoring. Compact-lobby tests exercise initials, recording, downloading and progress, sharing, offline, completion, host/current-user badges, readable tooltips, reload persistence and reconnect. Failure-recovery tests cover waveform retries, take-cache retries, explicit export failures, stable export snapshots, playback rejection/stalls and source synchronization without unnecessary seeks. Additional regressions exercise real ALAC/AC3/AAC and silent video, legacy scene recovery, delayed recorder callbacks, recording/export exclusion (including delayed microphone permission), pending playback cleanup, and rapid mute/solo clicks before server acknowledgements. The packaged smoke also checks the launcher-to-host language preference, bundled waveform extraction, source offsets and a guest's private monitoring; the guest smoke checks language persistence across host origins and the restricted preference-only bridge.

The 1.2.2 regression coverage adds draft merging with other players' and your own changes, "keep my version" on a same-field conflict, a pack export cancelled by a host disconnect, and the count of skipped subtitle cues. The 1.2.1 coverage checks millisecond form submission, short subtitle import and exact-duration pack export, drafts across room updates and delayed save acknowledgements, simultaneous pack export rejection, and a full five-second preparation for lines starting at 0, 1 and 3 seconds.

The end-to-end suite drives real Chrome/Edge (`puppeteer-core`, no browser download) with a fake microphone. Every run starts its own server with temporary `data/`, `uploads/` and `packs/` folders, so your real rooms are never touched, and generates a small test scene with `ffmpeg-static` (no third-party content). It covers recording and the countdown, effects, take dragging and per-player delay, zoom and panels, host tools, watch-together, sessions, reliable uploads, password and kicking, reconnects, P2P sharing, local media, WebCodecs export, and the desktop PIN room (the host and PIN guests get the video, strangers get neither the room nor its files). Editor regressions cover unchanged saves, consecutive Undo, claim changes, stale deletion, lost replies, and resized pack lines surviving reload and server restart. Random Cast, Blind Mode, themes, Workshop URL validation and pack export are covered too. If Chrome is installed in a non-standard place, set `CHROME_PATH`. Packaged smoke tests use a separate temporary Electron profile; Cloudflare smoke requires Internet access. Portable builds use a separate extraction directory for each launch, so closing one instance cannot remove another's FFmpeg or app resources. Folders left behind by a crashed launch are removed by a later start once they are older than ten minutes; a folder still used by a running instance cannot be renamed and is never touched. Run the portable host and guest smokes concurrently to check that isolation.

The server folders can be overridden with `DUBLINE_DATA_DIR`, `DUBLINE_UPLOAD_DIR` and `DUBLINE_PACKS_DIR`.

## Project structure

For development, read [PRODUCT.md](PRODUCT.md), [ARCHITECTURE.md](ARCHITECTURE.md), [BEHAVIOR.md](BEHAVIOR.md), and [TESTING.md](TESTING.md). The [regression matrix](docs/regression-matrix.md) records existing coverage and remaining 1.4 gaps.

```text
server.js              entry point: wires the modules together and starts the server
electron-main.js       Windows app: local server, Cloudflare tunnel, native window and cleanup
electron-preload.js    narrow IPC bridge for the public link, PIN status and clipboard
server/config.js       folders, limits, DUBLINE_* overrides
server/desktop.js      desktop host proof, room-PIN bootstrap, the single desktop room and media access
server/app.js          Express app, HTTP server, Socket.IO, static files
server/state.js        in-memory state shared by all modules (rooms, online players, recording, P2P, watch)
server/rooms.js        rooms and sessions, rooms.json persistence, public room view, audio track detection
server/parsers.js      Voxalike/Choicer Voicer packs and ASS/SSA/SRT/VTT subtitles
server/media.js        ffmpeg: durations, MKV subtitles, audio track extraction
server/files.js        paths behind /uploads and /packs, file sizes and hashes, take files
server/presence.js     online players, recording status, P2P seeders, watch-together, chat
server/auth.js         nickname ownership, host rights, room password
server/log.js          host event log
server/editHistory.js  per-player, per-session editor undo history
server/workshop.js     validated Voxalike Workshop URLs and bounded downloads
server/routes.js       HTTP API: pack/scene import and export, take upload and deletion
server/projects.js     portable .dubline manifest, media snapshots, validation and staged import
server/sockets/        Socket.IO handlers: room, roles, editor, features, host, trash, p2p
public/editor.js       shared source-line editing and session-bound request queue
public/features.js     Random Cast, Blind Mode and player activity
public/                browser client (plain scripts, loaded in order from index.html)
```

## Controls

| Key | Action |
| --- | --- |
| `Space` | Play or pause |
| `R` | Record the selected line in Dub Mode |
| `J` / `K` / `L` | Seek back 3 s / pause / seek forward 3 s |
| `F` | Toggle video fullscreen |
| `Left` / `Right` | Seek by three seconds; in Edit Mode, move selected lines by 0.1 s (Shift: 1 s) |
| `Alt` + `Up` / `Down` | Move selected lines to the adjacent role track in Edit Mode |
| `Ctrl` + `Z` | Undo your own last editor operation |
| `Delete` / `Backspace` | Delete selected source lines in Edit Mode, with confirmation |
| `Esc` | Close dialogs |

Use headphones while recording to prevent video audio from leaking into the microphone.

## Tests

```bash
npm test
npm run check
npm run test:e2e
npm run test:electron:editor
```

The test suite covers subtitle parsing, identifier sanitization, HTML/client integration, translation completeness, a real FFmpeg MKV round trip with an embedded ASS stream, and access control against a real server (`test/security.test.js`): the desktop PIN for rooms and media, upload rights, refused uploads not being buffered in memory, pack file filtering, kicking, and the password lockout.

The 1.3.1 regression tests also cover immutable pack media and source archives, delayed deletion, out-of-order take uploads, nickname changes, persisted queues, long captions, INI export/import, prototype-like names and mixer levels up to 150%. Browser tests use actual keyboard and pointer events, including Alt+arrows and double-clicking an empty role track to create a line. The Electron editor smoke test uses an isolated profile and a hidden window to verify role and scene dialogs and keyboard shortcuts in the desktop runtime.

## Stack

- **Desktop:** Electron, electron-builder, bundled cloudflared and ffmpeg-static
- **Server:** Node.js, Express, Socket.IO, Multer, adm-zip, ffmpeg-static
- **Client:** plain JavaScript, Web Audio API, MediaRecorder, WebCodecs, Mediabunny, JSZip, Canvas

No system FFmpeg installation or frontend build step is required.

## License

[MIT](LICENSE)
