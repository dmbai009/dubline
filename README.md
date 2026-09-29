# Dubline

Dubline is a collaborative browser-based dubbing studio and party game. Friends can claim characters or individual lines, record in parallel, review takes on a shared timeline, and export a finished video or DAW-ready character stems.

The project is inspired by Voxalike and The Choicer Voicer, while removing the need for players to record one after another.

## Features

- **Parallel recording.** Every player can claim and record their own lines without waiting for other actors.
- **Rooms and live synchronization.** Packs, roles, takes, host state, and chat are synchronized through Socket.IO. Add `?room=your-room` to the URL to create a separate session.
- **Persistent sessions.** Room state is stored in `data/rooms.json`; uploaded media and takes stay available after a server restart.
- **Host controls.** The first participant becomes the room host and can change scenes, pause playback for everyone, or release stale role claims.
- **Studio recording tools.** Pre-roll, microphone gain, optional browser noise/echo suppression, silence detection, waveform previews, non-destructive trimming, and manual take alignment.
- **Non-destructive voice processing.** Robot, radio, and monster effects plus a ±12-semitone pitch shifter are applied during playback and export without modifying the original recording.
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

The application itself does not expose your local server to the internet. One simple option for a private game is LocalTunnel:

```bash
npx localtunnel --port 3000
```

On Windows, `share.bat` runs the same command. Send friends a room-specific URL such as:

```text
https://example.loca.lt/?room=pizza-night
```

LocalTunnel may show a warning page asking for a tunnel password. This is LocalTunnel's anti-phishing check, not a Dubline password. The host can obtain the expected public-IP value at <https://loca.lt/mytunnelpassword>.

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
