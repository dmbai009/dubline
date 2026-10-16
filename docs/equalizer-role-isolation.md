# Equalizer, dragging and isolated role effects

The eleventh palette item is a five-band graphic equalizer. Fixed bands at
100 Hz, 300 Hz, 1 kHz, 3 kHz and 10 kHz offer −12…+12 dB in 0.5 dB steps.
The outer bands are shelves; the middle bands are peaking filters (Q 0.8).
Its card has an enable switch and five compact vertical sliders. Double-click
uses the existing slider reset behavior. A flat or disabled EQ bypasses DSP
exactly. Non-flat EQ uses the existing offline chain, final loudness correction
and peak protection for audition, playback, stems and video export. Radio and
other existing algorithms are unchanged; effect/budget limits remain 8/4/12s.

Palette items retain click/keyboard activation and can be dragged into an empty
chain or between cards. A themed ghost follows the pointer; neighboring cards
animate into place; the workspace scrolls when held near its top/bottom edge.
The preview changes only the DOM until a valid drop. Escape,
pointer cancellation, blur or dropping outside restore the draft. Pointer capture
and stable container focus preserve cancellation after repeated drags.

Existing Edit Mode role handles now move whole rows strictly vertically within
the timeline, with animated displacement of neighbors and edge scrolling. Cue
positions, selection, mix and timing remain unchanged. Escape/blur/cancellation
restore the order; pointer drop and Alt+Up/Down use the existing durable editor
queue, revisions, leases and Undo. Dub Mode editing rules are unchanged.

Role presets carry an explicit optional `role` field in the existing catalogue.
They are not listed in take selectors and cannot be applied to takes, even with a
forged request. General preset mutations cannot update/remove/rename them. The
role editor's Apply directly publishes its one source, with current role rights,
role/source revisions, strict disk rollback and immutable retry receipts.
The role editor uses a compact single-column workspace without the preset sidebar
or an icon picker. Its Apply button explains source updates in its hover tooltip;
take and library editors retain their existing preset controls and icon picker.
The role editor's flow shows only the role's draft chain, independently of the
selected audition take's own effects. Audition still uses the selected take's
complete resulting sound; take settings are never written into the role source.

Take preset create/rename refuses an existing role name with a rename warning.
When role creation/rename conflicts with an existing ordinary preset, only that
preset's label changes to a unique `name (preset)` (or numbered suffix). Its ID,
links, authorship and sound are preserved. A role rename/Undo updates its bound
source's name and role marker. Presets belonging to deleted roles remain isolated.

Read-time migration separates legacy direct take references to role presets into
exact private snapshots, preserving effects, IDs, pitch, exclusions, history and
trash without touching media or mix. Roles borrowing a generic take preset or
another role's source also receive an independent snapshot. Migration is idempotent and does not add
catalogue entries, so a full library can still be opened. Legacy generic presets
and raw role chains retain their previous rendering path.

New EQ/role metadata requires project format 15 and client voice capability 5.
Formats 1–14 remain readable; scenes without these features keep their lowest
applicable format. Downgraded manifests and older room clients are refused before
they can discard settings. Personal audio preferences remain outside the project.

Checks: `equalizer-role.test.js`, `role-workflow.test.js` and the existing model,
project and server suites; `e2e/equalizer-role.e2e.js` exercises actual Web Audio,
pointer events, source updates, forbidden take links, name collision, project
round trip and restart. `tools/equalizer-role-qa.js` uses Playwright for six
themes, EN/RU/UK, 1/4/8 cards, narrow/zoomed dialogs, inherited-role flow and
vertical track dragging. Screenshots remain under ignored `audit/equalizer-role`.
Native smoke exercises the source Electron app without building a distribution.

Local verification (2026-10-17): 470 unit/server tests and the 94-case affected
browser profile passed. Electron chains smoke passed actual capture, RNNoise,
EQ/pitch audition, listener PCM comparison and v15 project export. Playwright
passed 63 screenshots/geometry checks, including palette drag/autoscroll at
100/150% scale and vertical track displacement. No distribution was rebuilt.

Compact role editor follow-up: the equalizer/role and inspector-preset browser
suites passed 14/14, including hidden role icon controls, localized Apply tooltip,
restored take sidebar and source publishing. Playwright passed the 63-check visual
profile again with the 860px role dialog, four-card rows, six themes and narrow/
zoomed layouts. This follow-up did not rebuild a distribution.

Role-flow regression: two real uploaded takes reproduce a rejected role-name
preset followed by a saved take-only Echo. Before the fix, the empty role flow
incorrectly displayed Echo; its stored chain and source remained unchanged.
After the fix, all 25 equalizer/role and voice-chain browser tests passed. The
final 9-case equalizer/role rerun also verifies Echo remains visible in the take
editor and absent in the role editor. No distribution was rebuilt for this fix.
