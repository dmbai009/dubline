<div align="center">

<img src="public/icon-256.png" alt="Dubline" width="180">

# Dubline

**Dub scenes with friends, all at the same time.**

![Windows](https://img.shields.io/badge/Windows-portable%20.exe-0078D6)
![Browser](https://img.shields.io/badge/guests-Chrome%20%7C%20Edge-F4B400)
![Languages](https://img.shields.io/badge/UI-EN%20%7C%20RU%20%7C%20UK-8B5CF6)
![License](https://img.shields.io/badge/license-MIT-22C55E)

[Download for Windows](https://github.com/dmbai009/dubline/releases/latest)

</div>

Dubline is a dubbing studio and party game for recording scenes together.

- Claim characters and record in parallel.
- Edit captions and timing on a shared timeline.
- Import your video, subtitles or Voxalike packs.
- Mix dialogue, background audio and recorded voices.
- Export a finished video, character WAV stems or an editable pack.
- Host from the Windows app; friends join through Chrome, Edge or Dubline.

## Coming Soon

**Dubline 1.4 — projects and smoother workflows.** These features are being prepared for the next release and are available in the development version on [main](https://github.com/dmbai009/dubline/tree/main).

- **Single Player:** dub every role yourself and invite friends into the same project later.
- **Portable projects:** save and reopen a complete scene as `.dubline`, including media, recordings and mix settings.
- **Large video optimization:** use a smaller working copy and keep the original for final export.
- **Choose your storage drive:** move project media, recordings and the library to another disk.
- **Timeline and audio improvements:** smoother auto-ducking, clearer loading status, reliable fullscreen and audio-track controls, precise group editing and adjustable role heights.
- **Clearer settings:** separate personal monitoring and microphone preferences from the shared project mix.

## Get started

1. Download and run **Dubline.exe** from [GitHub Releases](https://github.com/dmbai009/dubline/releases).
2. Create a room and choose **Cloudflare**, **Porthole** or **VPN**.
3. Import a video or scene pack in **Files & Export**.
4. Share the invitation and PIN. Friends join, claim roles and record their lines.
5. Review the scene together and export the result.

Cloudflare creates an HTTPS link that guests open in Chrome or Edge. Porthole uses a shared Steam lobby and the TCP port shown by Dubline. Radmin VPN and Hamachi users join the same network; guests open the invitation through **Dubline.exe → Join as a guest** so microphone access works.

The host can switch connection methods without closing the scene. Keep the host window open during a session and use headphones while recording.

## What Dubline can do

### Scenes and imports

Import MP4 or MKV video with optional Original audio, Background / M&E and ASS, SSA, SRT or VTT subtitles. Video-only import opens an empty scene for creating roles and lines manually. MKV subtitles and multiple audio tracks can be extracted automatically; the host chooses the Original and Background tracks.

Separate audio supports WAV, MP3, M4A, AAC, OGG, OPUS and FLAC. Subtitle character names and timestamps become editable lines. Invalid subtitle cues are reported, and unwanted signs or lyrics can be removed in the editor.

Voxalike and The Choicer Voicer ZIP packs can be imported from disk, the host's library or a [Voxalike Workshop](https://voxalike.com/workshop) link. Packs contain scene video, optional backing audio, captions, timestamps and reference voices. Every import creates a new session; previous scenes keep their media and recordings.

### Shared editing

In **Edit Mode**, collaborators create and rename roles, edit captions and timing, move lines between tracks, resize their edges and select groups. Overlapping lines appear in separate lanes. Timing supports milliseconds, and unsaved inspector drafts survive ordinary room updates.

Undo restores your own edits while preserving later changes by other players. Deleted lines can be restored from session trash. **Dub Mode** locks source editing so actors can focus on recording and aligning their takes.

### Recording and voice tools

Claim a character or an individual line, then record while other actors work on theirs. The timeline and participant list show who is recording and how much of the scene is complete.

Adjust microphone gain, noise suppression, preparation time and microphone-delay correction. Use the silent visual countdown, optional three-beep ADR cues and a video prompter. Recording can continue beyond the source line while you are still speaking.

Trim and align takes without changing their original audio. Pitch shifting and robot, radio, monster, thoughts, cave, behind-a-door and megaphone effects apply during playback and export. Each line keeps one current take; recording again replaces it.

If an upload is interrupted, the take stays on that device and retries after reconnection, including after a page reload. A delayed upload belongs to the scene in which it was recorded.

### Audio and playback

**Original**, **Background / M&E** and **Dub** share a project mixer with volume up to 150%, mute, solo and precise source offsets. Auto-ducking lowers reference and background audio while recorded dialogue plays. Project settings are used by the exported mix; **My monitoring** gives each listener a personal balance.

Listen to individual takes, expand or fullscreen the video, and use **Watch Together** for a synchronized screening with host-controlled playback. Peers can share media to reduce repeated downloads from the host. A participant who already has the scene video or pack can select their local copy.

### Room tools and interface

Use chat, **Random Cast** to distribute roles and **Blind Mode** to hide takes until the group is ready to listen. Blind Mode prevents accidental spoilers in the interface; it does not make recordings private from authorized room members.

Desktop invitations use a PIN. The host can set a room password, remove participants, switch scenes and pause the room. Saved sessions and their recordings survive restarts.

Resize the lobby, video, inspector and timeline panels; zoom the timeline around the cursor. Choose from six themes and an English, Russian or Ukrainian interface. Layout, language and personal preferences are remembered on each device.

### Exports

- **Finished video:** combine the scene video with the project mix. Supported browsers copy the video stream and encode the mixed soundtrack; a real-time fallback is available.
- **Character stems:** export full-length, timeline-aligned WAV files with a TSV cue sheet for REAPER or another DAW.
- **Voxalike pack:** export the edited scene with video, backing audio, captions, timing and source/reference voices. Recorded dubbing is exported through video or stems.

### Projects and large media — in development

**Single Player** lets you create, edit and record all roles locally. **Host Multiplayer** opens the same scene for collaboration. A `.dubline` project embeds one scene's video, audio, current takes, captions, roles, effects, timing and shared mix; it can be reopened in either mode.

Project archives have no aggregate size ceiling. Working video is limited to **300 MB**. Larger local videos receive an H.264 working copy up to **720p**, with progress and cancellation. The original stays on the host, is included in the complete project archive, and supplies its unchanged video stream for final MP4/MKV export.

Choose a storage folder in the launcher or **My Settings** to move existing project media, recordings, library and temporary exports to another drive. A change made during a session applies at the next workspace launch. Application preferences, Chromium cache and portable EXE extraction keep their standard system locations.

Upcoming workflow improvements also include smoother audio ducking, loading indicators, timeline bounds and group movement, local role-track heights, and separate personal and shared settings. See [PRODUCT.md](PRODUCT.md) and the [project format guide](docs/project-format.md) for development details.

## Controls

| Key | Action |
| --- | --- |
| `Space` | Play or pause |
| `R` | Record the selected line |
| `J` / `K` / `L` | Seek back 3 s / pause / seek forward 3 s |
| `F` | Toggle video fullscreen |
| `Left` / `Right` | Seek; in Edit Mode, move lines by 0.1 s (`Shift`: 1 s) |
| `Alt` + `Up` / `Down` | Move selected lines to an adjacent role track |
| `Ctrl` + `Z` | Undo your last editor operation |
| `Delete` / `Backspace` | Delete selected source lines in Edit Mode |
| `Esc` | Close dialogs |

## Requirements and practical limits

The portable Windows app includes its server, FFmpeg and Cloudflare helper. The host does not need to install them separately. Browser guests use **Chrome or Edge**; Firefox and Safari are not supported. Other connection methods require Porthole or the chosen VPN client.

The room runs on the host's computer. If a public link is unreachable, try Porthole or VPN and check the invitation address, port and host window. Import large files locally on the host; tunnel uploads have a separate transfer limit shown in the interface.

Long scenes, extracted audio, exports and complete project archives need free disk space. Browser soundtrack mixing and full-length WAV stems can also use substantial RAM. Subtitle files are limited to 20 MB; Voxalike packs and their export have separate limits. Keep backups of important recordings before deleting sessions or clearing application data.

## Run from source

Use **Node.js 20.1 or newer**:

```bash
git clone https://github.com/dmbai009/dubline.git
cd dubline
npm install
npm start
```

Build the portable Windows app with `npm run dist`; the result is `dist/Dubline.exe`. Development builds from `main` include the Coming Soon features.

For a standalone browser server, run `npm run start:server` and open <http://localhost:3000>. On Windows, `start.bat` sets up and starts this server; `share.bat` creates a public link. The standalone server is intended for trusted groups and does not use the desktop app's PIN protection for media.

## Development

```bash
npm run check
npm test
npm run test:e2e
```

See [TESTING.md](TESTING.md) for native and packaged checks, [ARCHITECTURE.md](ARCHITECTURE.md) for the code structure, and [BEHAVIOR.md](BEHAVIOR.md) for project guarantees.

Inspired by Voxalike and The Choicer Voicer. Built with Electron, Node.js, Express, Socket.IO and browser audio/video APIs.

## License

[MIT](LICENSE)
