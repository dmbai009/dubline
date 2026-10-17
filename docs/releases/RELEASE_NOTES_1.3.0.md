## What's new

- Studio audio tracks: Original, Intershum / M&E and Dub sit on the timeline with cached waveforms and captions that say where each source comes from. The Audio group starts collapsed, so the role tracks with the lines stay in view.
- One shared project mix: volume (up to 150 %), mute, solo, auto-ducking and millisecond source offsets are saved with the session, synchronized between players and used by video export and character stems.
- My monitoring: a private listening mix that never changes the export. A player without the right to change the project mix is switched to it automatically when they move a level, mute or solo.
- Shared and personal auto-ducking: the project setting is used by everyone and by export; each player can turn on their own auto-ducking for what they hear.
- Flexible scene import: video is required; original audio, Intershum / M&E and subtitles are optional. Video-only scenes open in Edit Mode. The import form has themed file pickers in the interface language.
- Permanent transport under the video: play/pause, ±3 seconds, time, expanded view and fullscreen; Space, J/K/L and F respect text fields and Watch Together host rights.
- Optional ADR cues: three beeps one second apart with the silent fourth beat at the line start, re-timed to the video once playback really starts. Cues go only to the speakers, never into takes or exports.
- Tighter lip sync for separate audio sources: small drift is corrected by a slightly faster or slower source instead of audible jumps.
- Compact participants: initials, status icons and download progress stay visible in the collapsed lobby; microphone delay moved to Settings.
- English on first launch; the chosen language persists in the browser and the desktop app, including for desktop guests.
- Safer recording and exports: playback failures stop recording with a clear notice, exports use one snapshot of levels, timing and takes and report unavailable audio, and recording and video export cannot overlap.
- An import larger than the limit is refused before any file is read into memory; videos whose audio tracks cannot be read are retried with growing pauses.
- Portable builds unpack every launch into its own folder; folders left by a crashed launch are cleaned up on a later start.

## Verification

- 59/59 unit tests passed.
- 123/123 end-to-end tests passed.
- Packaged Windows smoke tests passed on the release EXE: locally, through a live Cloudflare tunnel, the desktop guest (language bridge) and two portable instances running at once.
