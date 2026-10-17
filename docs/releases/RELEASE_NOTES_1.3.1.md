## What's new

- Fixed Alt + Up/Down moving selected lines between role tracks in Edit Mode.
- Fixed adding roles and renaming roles or scenes in Electron by replacing unsupported native prompts with in-app dialogs. Escape also closes panels while text fields have focus.
- Double-click an empty area of a role track in Edit Mode to create a line at the clicked time and role. The line opens in the inspector, supports Undo, and respects zoom, scrolling and video bounds.
- Delayed take uploads cannot overwrite newer recordings or bring deleted audio back. Uploads, take edits and deletion remain tied to the recorded scene and take, and critical changes persist before acknowledgement.
- Nickname changes preserve claims, take ownership and queued recordings across active and inactive scenes. Starting a new recording requires a server connection; active recordings and queued takes survive a disconnect.
- Replacing a library pack preserves media and downloads used by existing scenes. Invalid imports leave the previous library entry intact, and local playback/export cannot reuse another scene's sources.
- Fixed take-deletion permissions, special role/nickname names, captions up to 2,000 characters, quoted and multiline pack metadata, negative take offsets, 150 % mixer controls and prompter updates after edits.
- Added 39 server/browser regression tests and five native Electron editor checks; the Electron checks also run in CI.

## Verification

- 77/77 unit and server integration tests passed.
- 144/144 browser end-to-end tests passed.
- Native Electron editor smoke tests passed.
- Packaged Windows host, desktop guest, concurrent portable instances and live Cloudflare tunnel smoke tests passed on the exact release EXE.
