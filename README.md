<div align="center">

<img src="src/public/icon-256.png" alt="Dubline" width="180">

# Dubline

**Dub scenes with friends, all at the same time.**

![Windows](https://img.shields.io/badge/Windows-Setup%20%7C%20Portable%20ZIP-0078D6)
![Browser](https://img.shields.io/badge/guests-Chrome%20%7C%20Edge-F4B400)
![Languages](https://img.shields.io/badge/UI-EN%20%7C%20RU%20%7C%20UK-8B5CF6)
[![License](https://img.shields.io/badge/license-DubLine%20Source%201.0-2563EB)](LICENSE)

[Download for Windows](https://github.com/dmbai009/dubline/releases/latest)

</div>

Dubline is a dubbing studio for recording scenes together. The Windows host runs the room; friends join through Chrome, Edge or Dubline.

- Claim characters and record in parallel, or dub every role in Single Player.
- Edit captions and timing on a shared timeline.
- Import video, subtitles or Voxalike packs.
- Mix original dialogue, background audio and recorded voices.
- Shape voices with effect chains, scene presets and built-in RNNoise noise reduction.
- Save complete scenes as portable `.dubline` projects.
- Export finished video, a selected fragment, character WAV stems, SRT/ASS/VTT subtitles or an editable Voxalike pack.

The `main` branch contains development work for **1.4**. Download a published release for the released version. [Release history](docs/releases/).

## Getting started

1. Download the Windows Setup or Portable ZIP. Keep the entire extracted Portable folder together.
2. Start Dubline and choose Single Player, Host Multiplayer Room, Join Multiplayer Room or Open Project.
3. Import a video with optional subtitles/audio, a Voxalike pack, or a `.dubline` project.
4. Claim a role, select a line and record. Use Edit Mode to change roles, captions and timings.
5. Export through Files. Save Project preserves the scene, media, current recordings and mix settings in a portable archive.

Ordinary edits are saved in the host's workspace. Opening a project imports a new scene rather than replacing existing scenes. Personal monitoring, devices and layout settings do not change the shared project mix or exported audio.

## Connecting friends

| Method | Use |
| --- | --- |
| Cloudflare | Automatic public HTTPS invitation. No additional app is needed by guests. |
| Porthole | Steam-based port sharing; follow the instructions in the launcher. |
| VPN | Connect through a private network such as Radmin VPN or Hamachi. |
| Custom tunnel | Advanced instructions for a separately installed HTTPS tunnel. Forward it to the actual local port shown by Dubline; send the resulting HTTPS link and room PIN. |

The host keeps Dubline open throughout the session. If one method is unavailable, try another. Custom tunnel mode does not install or launch third-party tunnel software; the local port may change after a restart.

## Controls

| Key | Action |
| --- | --- |
| `Space` | Play or pause; in Dub Mode a selected time range stops at its end |
| `R` | Record the selected line |
| `J` / `K` / `L` | Seek back 3 s / pause / seek forward 3 s |
| `F` | Toggle video fullscreen |
| `Left` / `Right` | Seek; in Edit Mode move lines by 0.1 s (`Shift`: 1 s) |
| `Alt` + `Up` / `Down` | Move selected lines to an adjacent role track |
| `Ctrl` / `Cmd` + `F` | Find captions, roles or chronological line numbers |
| `Ctrl` + `Z` | Undo your last editor operation |
| `Delete` / `Backspace` | Delete selected source lines in Edit Mode |
| `Esc` | Close dialogs or clear a private time range |

## Requirements and storage

The Windows app includes its server, FFmpeg and Cloudflare helper. Browser guests use **Chrome or Edge**; Firefox and Safari are not supported. Other connection methods require their corresponding external tools.

Long scenes, extracted audio, exports and project archives need free disk space. Browser exports and full-length WAV stems can also use substantial RAM. Working video and Voxalike imports have separate limits shown in the interface; `.dubline` archives have no aggregate size ceiling. Keep backups before deleting scenes or clearing application data.

My Settings lets the desktop host choose another storage drive. Updates preserve the chosen workspace and profile. Setup installs for the current Windows user; Portable runs from its extracted folder. Steam builds use Steam updates.

## Run from source

Use **Node.js 20.1 or newer** (CI uses Node.js 24):

```bash
git clone https://github.com/dmbai009/dubline.git
cd dubline
npm ci
npm start
```

For a standalone browser server, run `npm run start:server` and open <http://localhost:3000>. Windows users can also use `start.bat` and `share.bat`. The standalone server is intended for trusted groups and does not use the desktop app's PIN protection for media.

## Development

| Directory | Contents |
| --- | --- |
| `src/` | Electron entry points and launcher, server entry point |
| `src/server/` | Room/session logic, imports, projects, exports and network permissions |
| `src/public/` | Browser UI, styles, locales and shared audio/data models |
| `test/` | Unit and server integration tests |
| `e2e/` | Browser scenarios with isolated temporary servers/media |
| `tools/` | Build scripts, native Electron checks and QA utilities |
| `resources/` | Branding, Windows helpers and third-party license provenance |
| `docs/` | Portable project format and release history |

```bash
npm run check
npm test
npm run test:e2e
npm run test:electron:editor
npm run test:electron:ui
npm run test:electron:hosting
npm run test:electron:workflow
```

Browser tests require Chrome or Edge; set `CHROME_PATH` if detection cannot find it. Tests use temporary data/media directories. Standalone development keeps existing workspace data in `data/` and media in `public/uploads/` and `public/packs/`; these runtime folders are ignored by Git and separate from `src/public/`.

On Windows, `npm run dist:win:unpacked` builds `dist/win-unpacked/`. `npm run dist` builds the core, Setup and Portable ZIP. Artifacts and generated QA output are not source files. GitHub Actions runs syntax, unit/server, all browser shards and native Electron checks. Release CI prepares a verified draft without automatically publishing it.

The portable file boundary is documented in [Project format](docs/project-format.md). Contributions and licensing requirements are in [CONTRIBUTING.md](CONTRIBUTING.md).

Inspired by Voxalike and The Choicer Voicer. Built with Electron, Node.js, Express, Socket.IO and browser audio/video APIs.

## License

DubLine is distributed under the [DubLine Source License 1.0](LICENSE).
This is a **source-available license**, not an OSI-approved open-source license.

Previous versions and revisions of DubLine that were released under the MIT License remain available under the MIT License. Starting from the repository revision that introduced the DubLine Source License 1.0, DubLine is distributed under the DubLine Source License 1.0 unless explicitly stated otherwise.

The transition is defined by that repository revision, independently of any
version number. Existing MIT permissions for earlier published code remain
valid; old commits, tags, and releases are unchanged. The original MIT text is
retained in [LICENSE-MIT-LEGACY](LICENSE-MIT-LEGACY) for historical reference,
not as an alternative license for the current revision.

**Licensing boundary:** commit
`b05b1adbd5a0a6337a9a5434683bbfffb1fc88aa` introduced DubLine Source License
1.0 and is the first revision covered by it (inclusive). Its parent,
`0bd90a879a40904a9648b77cc93504811ab2dd1c`, is the last revision before the
transition and retains its MIT License.

- You may read, copy, fork, and modify the source for the uses allowed by LICENSE.
- Personal, educational, research, and other noncommercial use is allowed.
- Companies and other organizations may use DubLine internally, including for
  their own business operations.
- Commercial distribution, resale, and commercial SaaS or hosted services
  based on DubLine require prior written permission from **dmbai009**.
- Source forks must be identified as unofficial. Third-party builds shared
  with others must use a different product name and branding and must not
  claim to be official DubLine. The DubLine name, logo, icons, and brand are
  not licensed with the code.

For contributions and the rights required to use and relicense them, see
[CONTRIBUTING.md](CONTRIBUTING.md) and Section 7 of LICENSE. For commercial or
branding permission, contact [dmbai009](https://github.com/dmbai009) and obtain
a written agreement.

Third-party dependencies remain under their own licenses; see
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES). Electron builds include readable
project and third-party notices under `resources/licenses/` in the extracted
application. LICENSE contains the full terms, disclaimer of warranty, and
limitation of liability.
