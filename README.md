# Dubline

Dubline is a collaborative browser-based dubbing studio and party game. Friends can claim characters or individual lines, record in parallel, review takes on a shared timeline, and export a finished video or DAW-ready character stems.

The project is inspired by Voxalike and The Choicer Voicer, while removing the need for players to record one after another.

## Features

- **Parallel recording.** Every player can claim and record their own lines without waiting for other actors.
- **Studio layout.** A player lobby on the left, video, inspector and chat on top, and the timeline below. Drag the dividers to resize any panel (double-click resets it); sizes are remembered per browser.
- **Lobby and progress.** Players are listed as cards with online/recording status, host and “you” tags, and how many lines each has claimed and recorded. Players who left but contributed stay visible, dimmed. The overall “dubbed N / total” progress is shown in the lobby and above the timeline.
- **Timeline zoom.** Ctrl+mouse wheel zooms around the cursor; the toolbar has −/+ and “Whole scene”. The ruler adapts its tick spacing to the zoom level.
- **Per-player microphone delay.** Bluetooth headsets make takes sound late. Each player has one delay correction applied to all their takes, in playback, video export and stems: adjust it with ±10 ms on your lobby card, or Shift+drag any of your takes on the timeline to move them all at once.
- **Peer-to-peer video sharing.** Players who open the room through the tunnel download the scene video and backing track in full, taking 64 KB pieces directly from other players over WebRTC and only the missing pieces from the host. The file is checked against the server’s SHA-256, played locally, and then shared onward, so the host’s upload is used roughly once instead of once per player. “Watch now from the host” skips the wait; the feature can be turned off in settings. Room state still lives on the host’s server.
- **Rooms and live synchronization.** Packs, roles, takes, host state, and chat are synchronized through Socket.IO. Add `?room=your-room` to the URL to create a separate session.
- **Persistent sessions.** Room state is stored in `data/rooms.json`; uploaded media and takes stay available after a server restart.
- **Host controls.** The first participant becomes the room host and can change scenes, pause playback for everyone, or release stale role claims. Pausing everyone asks for confirmation if someone is recording right now.
- **Watch together.** The host plays the finished scene for the whole room at once: a 3-second countdown, a start synchronized to the server clock, and periodic drift correction. Pause and seeking follow the host; recording is disabled until the host stops the screening.
- **Live recording status.** Everyone sees which line is being recorded and by whom: the tile pulses red and the player gets a 🔴 in the online list.
- **Connection banner.** If the tunnel or server drops, players see “No connection, reconnecting…” and the page rejoins the room automatically when the server is back.
- **Host event log.** The server console prints who joined or left (with the reason, e.g. closed tab vs. lost connection), saved takes, pack changes, rejected requests, and errors; the host also receives the same log in the browser console (F12). An error in one handler is logged instead of taking the whole server down.
- **Play video from your own disk.** Download buttons show the file size; a player who already has the pack `.zip` or scene video can pick it in *Files & Export*, and the video then plays (and exports) from their computer instead of through the host’s tunnel.
- **Studio recording tools.** Pre-roll, microphone gain, optional browser noise/echo suppression, silence detection, waveform previews, non-destructive trimming, and manual take alignment.
- **Non-destructive voice processing.** Robot, radio, monster, thoughts, cave, behind-a-door, and megaphone effects plus a ±12-semitone pitch shifter are applied during playback and export without modifying the original recording. Delay and reverb tails are preserved in playback, video mixes, and WAV stems.
- **Three-channel mixer.** Control original video audio, background/ambience, and recorded dubbing independently.
- **Auto-ducking.** Background and original audio fade down over 80 ms while a take plays and recover over 250 ms. The same automation is used for playback and exported mixes.
- **Video prompter.** The active character, line, and phrase progress are shown over the video. The overlay can be disabled or resized.
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

ASS imports use the Aegisub `Name` field for the character. SRT/VTT lines may use prefixes such as `Alice: text`, `[Alice]: text`, or `(Alice): text`. When a scene has no separate backing track, video audio is treated as the background channel and participates in auto-ducking.

## Requirements and installation

- Node.js 18 or newer; Node.js 20+ is recommended.
- Chrome or Edge is recommended for the fastest WebCodecs export.

```bash
git clone https://github.com/dmbai009/dubline.git
cd dubline
npm install
npm start
```

Open <http://localhost:3000>. On Windows, `start.bat` starts the server and opens the page.

## Inviting friends

The application itself does not expose your local server to the internet. The recommended option is a free [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/): no account, no warning page, and it handles several players at once.

```bash
cloudflared tunnel --url http://localhost:3000
```

On Windows, just run `share.bat` while the server is running. If `cloudflared` is missing, the script offers to install it via `winget`; if you decline, it falls back to LocalTunnel (`npx localtunnel --port 3000`), which is less stable and shows a password page.

The tunnel prints an address like `https://random-words.trycloudflare.com`. Send friends a room-specific URL:

```text
https://random-words.trycloudflare.com/?room=pizza-night
```

The address changes every time the tunnel restarts. Players simply open the new link and enter the same nickname: a nickname is reserved only while its owner is online, so returning players get their nickname, roles and takes back (and the host gets host rights back).

Do not share a tunnel publicly. Dubline is designed as a small self-hosted server for trusted groups, not as a hardened public multi-tenant service.

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

- **Server:** Node.js, Express, Socket.IO, Multer, adm-zip, ffmpeg-static
- **Client:** plain JavaScript, Web Audio API, MediaRecorder, WebCodecs, Mediabunny, JSZip, Canvas

No system FFmpeg installation or frontend build step is required.
