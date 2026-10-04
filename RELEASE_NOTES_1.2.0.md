## What's new

- Collaborative Edit Mode: create, resize and move source lines, edit captions, arrange role tracks, and undo your own changes with Ctrl+Z.
- Separate Edit and Dub Modes, switched by the host for the whole room; recorded takes can still be aligned while dubbing.
- Voxalike-compatible ZIP export with scene video, backing audio and INI/WAV files for each line.
- Voxalike Workshop import by pack link, with validated archives cached on the host for reuse.
- Random Cast distributes speaking roles among online players and skips empty tracks.
- Blind Mode hides other players' takes, or just your own, until the host reveals them.
- One-second recording preparation by default, adjustable from 0 to 5 seconds, including lines at the start of the video.
- Six visual themes, video download progress in the lobby, and a refreshed inspector.
- Expanded video view and video-only fullscreen, including during watch-together; low-resolution video fills the available area without changing its aspect ratio.
- More reliable collaborative editing: revision-checked changes and deletion, consecutive Undo, lost-reply recovery, and session-bound queued actions.
- Edited line lengths survive reloads and server restarts; pack export uses a consistent scene snapshot, and completed takes retain their original session and timing.

## Verification

- 34/34 unit tests passed.
- 69/69 end-to-end tests passed.
- Packaged Windows smoke tests passed on the release EXE, both locally and through a live Cloudflare tunnel, including a PIN guest, editing, Undo, recording, Blind Mode and ZIP export.
