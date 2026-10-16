# Original reference playback

In video + subtitles scenes the inspector's compact Original button auditions
the selected original source from 0.5 seconds before the line to 0.5 seconds
after it. Scene duration, actual media duration and shared source offset clamp
the bounds. The existing Original source selector and external-original priority
are reused. An embedded soundtrack displayed as Background when there is no
separate backing remains the original source.

If no original exists and only a separate Background source remains, the listener
must explicitly approve using it as a reference. Dubline cannot infer whether it
contains dialogue or only music/M&E. Approval is private, bound to the current
room, scene and source URL, and held only for the page lifetime. It never updates
the room, project or audio routing.

Voxalike packs retain their existing `originalAudioUrl` file playback. These
already-cut files are not replaced by scene audio, padded or re-extracted. A
missing file reference does not silently fall back to the pack's backing track.

Scene references use one streaming media element in the existing preview
lifecycle, registered with the current output device. Project/personal track
mute, solo, volume, ducking and dub effects are bypassed; personal master volume
and global mute remain effective. Playback is at original speed. The local video,
backing and takes pause first; pressing Original again stops it. Timeline play,
take preview, recording and scene changes clean up the reference. Metadata waits
are cancellable and bounded, timers/listeners are released and stopped media is
unloaded. A delayed request cannot restart an obsolete reference.

References do not change source selection, offsets, project mix or takes and are
never included in exported audio/video. Export continues to use the shared mix.
The inspector's primary actions use 28px buttons for both scene kinds; a short
Take label keeps long participant names in its tooltip instead of enlarging the
button. Narrow panels can wrap the action row.

Coverage: `original-reference.test.js` covers source priority, ambiguous backing,
padding and offsets. `e2e/original-reference.e2e.js` imports an actual video/SRT,
checks native media playback and guest access, mute/solo bypass, master volume,
bounded stop, private backing approval, cancellation and Voxalike file behavior.
`tools/original-reference-qa.js` checks both pack kinds, own/foreign takes, 280/
360/540px inspectors, three themes and EN/RU/UK using Playwright. Generated
screenshots and logs stay in ignored `audit/original-reference`.

Local verification (2026-10-17): 473 unit/server tests and syntax checks passed.
The affected browser profile covered 80 cases: 34 inspector/history/reference
cases passed, then the studio rerun passed 46/46 after updating the compact-label
expectation and an older test's obsolete global Shift-range expectation. The
dedicated final reference suite passed 6/6, including mix refresh during playback.
Playwright checked 109 layouts/screenshots. No distribution, commit or push was
created by this change.
