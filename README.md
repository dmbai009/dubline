# Dubline

Dubline is a collaborative desktop and browser-based dubbing studio and party game. Friends can claim characters or individual lines, record in parallel, review takes on a shared timeline, and export a finished video or DAW-ready character stems.

The project is inspired by Voxalike and The Choicer Voicer, while removing the need for players to record one after another.

## Features

- **Self-contained Windows app.** The portable `Dubline.exe` starts the local Express/Socket.IO server and a bundled Cloudflare quick tunnel, opens the studio in a native Electron window, and stops both background processes when the window closes. The host does not need Node.js, FFmpeg, or cloudflared installed.
- **Protected desktop room.** Every app launch generates a new four-character PIN. The public link and masked PIN sit in the top-left invitation panel; guests enter their nickname and PIN before any room state or media URLs are sent. A private per-launch token guarantees that only the local Electron window receives host rights.
- **Parallel recording.** Every player can claim and record their own lines without waiting for other actors.
- **Studio layout.** A player lobby on the left, video, inspector and chat on top, and the timeline below. Drag the dividers to resize any panel (double-click resets it); sizes are remembered per browser.
- **Lobby and progress.** Players are listed as cards with online/recording status, host and “you” tags, and how many lines each has claimed and recorded. Players who left but contributed stay visible, dimmed. The overall “dubbed N / total” progress is shown in the lobby and above the timeline.
- **Timeline zoom.** Ctrl+mouse wheel zooms around the cursor; the toolbar has −/+ and “Whole scene”. The ruler adapts its tick spacing to the zoom level.
- **Per-player microphone delay.** Bluetooth headsets make takes sound late. Each player has one delay correction applied to all their takes, in playback, video export and stems: adjust it with ±10 ms on your lobby card, or Shift+drag any of your takes on the timeline to move them all at once.
- **Peer-to-peer video sharing.** Players who open the room through the tunnel download the scene video and backing track in full, taking 64 KB pieces directly from other players over WebRTC and only the missing pieces from the host. The file is checked against the server’s SHA-256, played locally, and then shared onward, so the host’s upload is used roughly once instead of once per player. “Watch now from the host” skips the wait; the feature can be turned off in settings. Room state still lives on the host’s server.
- **Rooms and live synchronization.** Packs, roles, takes, host state, and chat are synchronized through Socket.IO. Add `?room=your-room` to the URL to create a separate session.
- **Sessions.** Every import (ZIP pack, video + subtitles, or a mod launched from the library) creates a new session in the room; older sessions keep their scene, roles and takes. The host switches, renames and deletes sessions from the 🎬 menu in the header; everyone sees each session’s progress and last change. Deleting asks for confirmation and removes the session’s takes and scene files (shared pack folders are kept while another session uses them; archives in the mod library are never deleted). Rooms from older versions become a single session automatically.
- **Persistent state.** Rooms and sessions are stored in `data/rooms.json`; uploaded media and takes stay available after a server restart.
- **Host controls.** The first participant becomes the room host and can change scenes, pause playback for everyone, or release stale role claims. Pausing everyone asks for confirmation if someone is recording right now.
- **Watch together.** The host plays the finished scene for the whole room at once: a 3-second countdown, a start synchronized to the server clock, and periodic drift correction. Pause and seeking follow the host; recording is disabled until the host stops the screening.
- **Live recording status.** Everyone sees which line is being recorded and by whom: the tile pulses red and the player gets a 🔴 in the online list.
- **Connection banner.** If the tunnel or server drops, players see “No connection, reconnecting…” and the page rejoins the room automatically when the server is back.
- **Takes are never lost to a dropped connection.** If an upload fails (network drop, tunnel 502), the take is kept in the browser (IndexedDB, survives a page reload), marked ⏳ on the timeline, and re-sent automatically with backoff and as soon as the connection returns. The server recognizes a repeated upload and never stores it twice; a late take lands in the session it was recorded in, even if the host has switched sessions.
- **Room password and kicking.** The host can set a room password in Settings (players already inside stay; new devices enter it once, repeated wrong attempts are blocked; only a salted scrypt hash is stored) and remove a player with ✖ on their lobby card. Kicked devices cannot rejoin until the host allows it.
- **Host event log.** The server console prints who joined or left (with the reason, e.g. closed tab vs. lost connection), saved takes, pack changes, rejected requests, and errors; the host also receives the same log in the browser console (F12). An error in one handler is logged instead of taking the whole server down.
- **Play video from your own disk.** Download buttons show the file size; a player who already has the pack `.zip` or scene video can pick it in *Files & Export*, and the video then plays (and exports) from their computer instead of through the host’s tunnel.
- **Studio recording tools.** Pre-roll, microphone gain, optional browser noise/echo suppression, silence detection, waveform previews, non-destructive trimming, and manual take alignment.
- **Non-destructive voice processing.** Robot, radio, monster, thoughts, cave, behind-a-door, and megaphone effects plus a ±12-semitone pitch shifter are applied during playback and export without modifying the original recording. Delay and reverb tails are preserved in playback, video mixes, and WAV stems.
- **Multiple audio tracks.** If the video has several audio tracks (e.g. Japanese and Russian in an anime episode), the server extracts each one (AAC is copied, other codecs are converted) and the host picks which track plays as “Original” and which as “Background”, or none, below the mixer. The choice applies to everyone, to export, and survives restarts; scenes imported earlier get their tracks extracted automatically.
- **Arrange characters for any scene.** Subtitles without speaker names put every line on one track; you can sort them out in Dubline itself. The ✎ next to the character name in the inspector moves one line; Ctrl+click / Shift+click on the timeline select several lines (or a range) and assign them a character at once; the ✎ on a track label renames the whole track (merging with an existing character). Everyone can move free lines and their own; the host can move any line, rename any track, and release lines someone claimed by mistake (“Release selected”). Overlapping lines of one character are stacked into lanes instead of drawn on top of each other.
- **Three-channel mixer.** Control original video audio, background/ambience, and recorded dubbing independently.
- **Auto-ducking.** Background and original audio fade down over 80 ms while a take plays and recover over 250 ms. The same automation is used for playback and exported mixes.
- **Visual recording countdown.** After pressing Record the video rewinds 2 seconds; a thin bar sweeps across the video and three dots light up, then a red “Speak!” appears exactly when the line starts. It is silent, follows the video clock, and can be turned off in settings.
- **Recording follows your voice.** Recording does not stop at the end of the original line: if your phrase is longer, keep talking — it stops by itself after 0.8 s of silence (at most the line length, minimum 4 s, past the line end), or when you press the button again. Auto-trim keeps quiet word endings.
- **Built-in guidance.** A short “How to play” guide (headphones, claiming, recording, listening, timing, watching together, hotkeys) opens on the first visit and from the ❓ button. Silent dead ends now show a hint instead (e.g. pressing R with no line selected, or on someone else’s line), and a denied microphone explains how to re-enable it.
- **Video prompter.** The active character, line, and phrase progress are shown over the video. When several characters speak at once, all simultaneous lines are shown (up to four, then “+N more”); while recording, your line comes first and the others are dimmed. The overlay can be disabled or resized.
- **Fast browser export.** On supported browsers, WebCodecs and Mediabunny pass the encoded video stream through without re-encoding and create a new mixed audio track. A real-time fallback is available when WebCodecs cannot be used.
- **REAPER/DAW stems.** The browser renders one full-length, timeline-aligned WAV file per character and packages the files with a TSV cue sheet in a ZIP archive.
- **Room chat.** Includes persisted history, unread counts, and localized system notifications.
- **English, Russian, and Ukrainian UI.** The browser language is detected automatically and the selection is stored in `localStorage`.

## Import formats

### Voxalike-compatible ZIP packs

Dubline understands standard Voxalike and The Choicer Voicer scene archives. It looks for:

| File | Purpose |
| --- | --- |
| `dub_video.mp4` | Scene video |
| `*_backing_track*` | Music and ambience |
| `*.ini` / `*.txt` | Captions, characters, and timestamps |
| `*.wav` / `*.mp3` / `*.ogg` | Original line audio |

Uploaded archives are stored in `public/packs/` and extracted into a path-safe, flattened folder below `public/uploads/`.

### Video and subtitles

The import dialog also accepts:

- MP4 plus ASS, SSA, SRT, or VTT subtitles;
- MKV plus an optional external subtitle file;
- MKV with an embedded ASS, SSA, or SRT-compatible subtitle track.

For MKV input, the bundled `ffmpeg-static` binary extracts the first supported subtitle stream and remuxes video into MP4 without video re-encoding. Audio is copied when MP4 supports its codec and converted to AAC only when necessary.

ASS imports use the Aegisub `Name` field for the character; typesetting drawings (`\p1` vector shapes) and comment lines are skipped, and `\N` / `\h` become spaces. When an MKV has several subtitle tracks, the importer prefers full/dialogue tracks over signs, songs and forced ones (the choice is written to the server log). The host can delete lines that should not be dubbed (on-screen signs, song lyrics) from the inspector or for a whole selection; deleted lines go to the session trash (“🗑 Deleted (N)” on the timeline toolbar): search it, restore any line back to its place with its take, or delete lines forever. Ctrl+Z or “Undo” in the notice quickly restores the last deletion. The trash keeps the last 50 deletions per session; take files are removed only when a line is deleted forever. SRT/VTT lines may use prefixes such as `Alice: text`, `[Alice]: text`, or `(Alice): text`. When a scene has no separate backing track, video audio is treated as the background channel and participates in auto-ducking.

## Requirements and installation

Only the host needs to install anything. Friends just open the link in Chrome or Edge. Other browsers (Firefox, Safari) are not supported yet and show a hint to switch; wired headphones are recommended, since Bluetooth headsets drop to low sound quality while the microphone is on.

### Windows desktop app

Download and run **`Dubline.exe`**. The app starts its server and tunnel automatically. Wait until the invitation panel says that the link is ready, copy the link, and send the separately displayed four-character PIN to your friends. The PIN is masked until the host enables **Show**.

Rooms, imported media, and takes are stored in the app's Windows user-data folder and survive restarts. Closing the native window shuts down the local server and tunnel.
The **Clear all Dubline data** button in Settings removes every saved room, take, imported video, server pack, and local browser cache after an explicit confirmation, then restarts the app with an empty room.

### Build the portable EXE

```bash
git clone https://github.com/dmbai009/dubline.git
cd dubline
npm install
npm run dist
```

`npm run dist` downloads the pinned official Windows `cloudflared` binary, verifies its SHA-256, and creates `dist/Dubline.exe`. The portable file includes Electron, `ffmpeg-static`, and `cloudflared`; the build does not include local `data/`, uploaded scenes, takes, or server packs.

### Legacy browser server (one click)

1. Download the project: **Code → Download ZIP** on GitHub (or `git clone`), and unzip it.
2. Double-click **`start.bat`**. On the first run it:
   - offers to install Node.js LTS via `winget` if Node.js is missing;
   - installs the dependencies automatically (again only when they change after an update);
   - starts the server and opens <http://localhost:3000> once it is ready.
3. Double-click **`share.bat`** to get a public link for friends (see below).

If the server is already running, `start.bat` just opens the page.

### Other platforms / manual browser server

- Node.js 18 or newer; Node.js 20+ is recommended.
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

Do not share a tunnel publicly. Dubline is designed as a small self-hosted server for trusted groups, not as a hardened public multi-tenant service.

## Development and tests

```bash
npm test          # fast unit and integrity checks
npm run test:e2e  # browser end-to-end suite (about a minute)
```

The end-to-end suite drives real Chrome/Edge (`puppeteer-core`, no browser download) with a fake microphone. Every run starts its own server with temporary `data/`, `uploads/` and `packs/` folders, so your real rooms are never touched, and generates a small test scene with `ffmpeg-static` (no third-party content). It covers recording and the countdown, effects, take dragging and per-player delay, zoom and panels, host tools, watch-together, sessions, reliable uploads, password and kicking, reconnects, P2P sharing, local media and WebCodecs export. If Chrome is installed in a non-standard place, set `CHROME_PATH`.

The server folders can be overridden with `DUBLINE_DATA_DIR`, `DUBLINE_UPLOAD_DIR` and `DUBLINE_PACKS_DIR`.

## Project structure

```text
server.js              entry point: wires the modules together and starts the server
electron-main.js       Windows app: local server, Cloudflare tunnel, native window and cleanup
electron-preload.js    narrow IPC bridge for the public link, PIN status and clipboard
server/config.js       folders, limits, DUBLINE_* overrides
server/desktop.js      desktop host proof and generated room-PIN bootstrap
server/app.js          Express app, HTTP server, Socket.IO, static files
server/state.js        in-memory state shared by all modules (rooms, online players, recording, P2P, watch)
server/rooms.js        rooms and sessions, rooms.json persistence, public room view, audio track detection
server/parsers.js      Voxalike/Choicer Voicer packs and ASS/SSA/SRT/VTT subtitles
server/media.js        ffmpeg: durations, MKV subtitles, audio track extraction
server/files.js        paths behind /uploads and /packs, file sizes and hashes, take files
server/presence.js     online players, recording status, P2P seeders, watch-together, chat
server/auth.js         nickname ownership, host rights, room password
server/log.js          host event log
server/routes.js       HTTP API: pack and scene import, take upload and deletion
server/sockets/        Socket.IO handlers: room, roles, host, trash, p2p
public/                browser client (plain scripts, loaded in order from index.html)
```

## Controls

| Key | Action |
| --- | --- |
| `Space` | Play or pause |
| `R` | Record the selected line |
| `Left` / `Right` | Seek by three seconds |
| `Esc` | Close dialogs |

Use headphones while recording to prevent video audio from leaking into the microphone.

## Tests

```bash
npm test
npm run check
```

The test suite covers subtitle parsing, identifier sanitization, HTML/client integration, translation completeness, and a real FFmpeg MKV round trip with an embedded ASS stream.

## Stack

- **Desktop:** Electron, electron-builder, bundled cloudflared and ffmpeg-static
- **Server:** Node.js, Express, Socket.IO, Multer, adm-zip, ffmpeg-static
- **Client:** plain JavaScript, Web Audio API, MediaRecorder, WebCodecs, Mediabunny, JSZip, Canvas

No system FFmpeg installation or frontend build step is required.

## License

[MIT](LICENSE)
