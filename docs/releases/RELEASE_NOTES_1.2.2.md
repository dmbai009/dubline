## What's new

- Editor drafts merge changes instead of blocking: if a different field of the line you are editing changes (another player's edit, or your own drag, arrow keys or Undo), your draft takes the new value and stays saveable.
- A real conflict appears only when the same field was changed on both sides, and you can now choose "Keep my version" to save your draft over the latest one, or load the latest version.
- Voxalike pack export is cancelled as soon as the host closes the tab or loses the connection, instead of finishing a ZIP nobody receives.
- Each room has its own pack export slot, so hosts of different rooms on one browser server no longer block each other (at most two exports run at once, because the ZIP is built in memory).
- Subtitle cues with a missing, reversed or zero-length time are counted on import: the host sees a warning and the room chat gets a notice.
- The room password end-to-end test now waits for each answer, removing an intermittent failure.

## Verification

- 39/39 unit tests passed.
- 83/83 end-to-end tests passed.
- Packaged Windows smoke tests passed on the release EXE, both locally and through a live Cloudflare tunnel, including a PIN guest, editing, Undo, recording, Blind Mode and ZIP export.
