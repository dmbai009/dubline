# Subtitle-only export and compact range controls

Files → Export contains a subtitle card between character WAV stems and the editable
Voxalike pack. Three ordinary themed buttons carry localized format explanations:

- SRT: broad player/editor compatibility; role names are visible bracketed text prefixes.
- ASS: roles use the actor field rather than displayed text; recommended for DubLine/Aegisub.
- VTT: web-player captions with voice tags; role names remain separate from displayed text.

All formats export the **whole scene**, independently of the private video fragment,
role filters and cue selection. They contain only captions, timing and character names;
they do not include video, recordings, claims, effects or room credentials. Export is
host-only and uses the existing confirmed snapshot barrier, including its pending-edit,
unsaved-draft and explicit cancellation behavior. No video rendering is needed.

The existing custom video/subtitle importer accepts the result into a new session.
SRT/VTT entities are decoded once after markup removal; multiline text and WebVTT
voice names are preserved. Ordinary ASS imports retain their existing cleanup.
ASS's standard timestamps use centiseconds. Ignored per-cue DubLine comments keep
exact millisecond times, actor names and literal caption text for a direct round-trip.
Those comments are trusted only when their SHA-256 matches the unchanged Dialogue;
editing/reformatting the Dialogue elsewhere falls back to its actual standard content.
The exporter provides basic styling; it cannot restore styling already discarded by
an earlier import. Playback compatibility follows the target player's format support.

New sessions carry the internal `captionsCleaned` migration flag, preventing legacy
ASS cleanup from rewriting newly imported or edited plain text on server restart.
This does not change the portable project schema or expose recording assets.

Private range time/export/clear controls now occupy the existing footer immediately
before zoom. They do not add another timeline row. Narrow footer controls retain
accessible labelled icon actions; Edit Mode range/gesture behavior is unchanged.

Validation:

- `npm run check`: passed; `npm test`: 458 passed, no failures or skipped tests.
- `node --test subtitle-export.test.js timing.test.js test/server.test.js`: 16 passed.
- `node --test e2e/subtitle-export.e2e.js`: 10 passed, actual downloaded blobs imported
  into another room/project with Unicode roles, overlaps, literal markup, line breaks,
  exact times and no takes, plus server restart, authorization and footer geometry.
- `node --test e2e/timeline-range.e2e.js`: 12 passed.
- Final combined subtitle/range/1.4 project workflow profile: 34 passed, no failures
  or skipped tests, including recorded solo/multiplayer project reopen/export.
- `tools/subtitle-export-qa.js`: 72 Playwright screenshots, six themes, EN/RU/UK,
  narrow layouts and 150% scaling. Screenshots remain local under audit/subtitle-export.

Windows unpacked builds and GitHub publication are performed on explicit request.
