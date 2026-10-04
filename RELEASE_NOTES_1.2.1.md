## What's new

- Millisecond-accurate timing in the editor and imported Voxalike, ASS, SRT and VTT lines; timestamps with three decimal places now save correctly.
- Short subtitle cues keep their original duration during import, editing and Voxalike pack export.
- Unsaved editor drafts survive room updates and line selection changes. Conflicting edits preserve your draft and show the latest server version; typing while a save is pending no longer loses the newer text.
- Clear inline explanations for missing, reversed, too-short or overly precise line timings.
- Recording preparation is adjustable in 0.1-second steps. Lines near the beginning receive the full configured buffer, and canceling preparation clears pending playback and speech timers.
- Voxalike pack export shows line-by-line progress, processes one export at a time per host, and keeps the correct ZIP filename when the scene changes during export.

## Verification

- 38/38 unit tests passed.
- 81/81 end-to-end tests passed.
- Packaged Windows smoke tests passed on the release EXE, both locally and through a live Cloudflare tunnel, including a PIN guest, millisecond form editing, draft preservation, Undo, five-second preparation, recording, Blind Mode and ZIP export.
