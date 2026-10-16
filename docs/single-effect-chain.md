# One own effect chain per take

Pitch now also has an ordered effect card; new pitch-stage scenes use project
version 14 and voice capability 4. Legacy scalar pitch remains compatible. See
[Pitch as an effect stage](pitch-stage.md) for the current editor and migration.

A session has one shared `voicePresets` catalogue. Admitted participants can create
preset entries; the creator, host and moderators can manage them. A claimed role's
owner may also change its effects and its same-named preset. See
[Role presets and selection](role-preset-workflow.md) for current permissions,
automatic role presets, bulk inspector assignment and spatial Shift selection.

The inspector links a chosen preset to the take. It replaces the complete own
chain, including preset pitch, after confirmation if any selected take has settings.
Role inheritance, manual clip mix, trim, alignment, original files and history are
preserved. Removing the link keeps the audible own chain as an independent copy.

The editor shows the entire own chain as editable stages. Its first stage/parameter,
pitch or order edit freezes the linked chain into a private variant and displays
“(modified)”. Applying a take saves only its variant. Applying a role now publishes
its chain to the shared preset named after that role, after confirmation. Save as preset creates a
new catalogue entry from this exact own chain and selects that new link in the
draft; applying the draft remains explicit. Update source preset publishes the
draft to the original catalogue entry after impact confirmation and a revision/
permission check. Other independent variants keep their sound. Ordinary links,
including existing recordings, historical takes and role references, stay live.

Inherited role processing precedes the take's one own chain. Take inheritance can
be disabled. Applying a role automatically creates or updates its named preset;
old independent role definitions remain a compatibility role preset without
rewriting their audio or filling an already-full session catalogue.

## Representation and compatibility

`voicePresetId` identifies either the live entry or the origin of a private variant.
`presetModified: false` resolves only that preset; `effects` must be empty.
`presetModified: true` resolves only the stored snapshot, with optional origin
metadata. A modified snapshot never adds its origin's effects or follows its pitch.
An absent flag is the legacy preset-plus-extras reader. At room loading and project
staging, legacy overlays become private complete snapshots with their current
sound/pitch. Main takes, histories and trash are included. Duplicate role IDs are
made distinct with inherited exclusions remapped, preserving the resolved sound.
Original single-effect and independent role definitions remain readable.

New metadata requires portable project version 13 and client capability 3. Projects
1–12 remain readable. A scene without the new representation still emits its lowest
applicable version. Old readers cannot mistake a private snapshot for another
overlay: older-version manifests reject the flag, and incompatible clients are
refused before entering/mutating a scene. Legacy flattened chains can retain up to
16 stored stages, including disabled stages; the existing eight-active-stage,
four-heavy-stage and twelve-second-tail budgets remain enforced atomically.

No new sound engine, room protocol, mutation queue or audio files are introduced.
Voice changes retain existing immutable operation receipts, exact take identities,
revision conflicts, snapshot barriers and strict disk-write rollback. Catalogue
updates validate active, historical and trashed combinations before any write.
Unknown acknowledgements retain the captured request; publishing cannot be closed
or overlapped by a second local Apply while its result is unresolved.

## Verification

`single-chain.test.js` covers resolution, frozen variants and pitch, legacy/portable
migration, history, trash, duplicate role IDs/exclusions, bounded disabled stages,
ownership, stale revisions and unchanged original references/mix. Existing voice,
preset, inspector, history and clip-mix browser suites exercise real sockets,
recordings, PCM, failed writes, immutable lost-ACK recovery, project save/open and
restart. Copy/append UI expectations were updated to whole-chain replacement;
legacy wire readers remain covered independently.

`node tools/single-chain-workspace-qa.js` uses Playwright against a real isolated
studio. It asserts private edits, cancel/confirm shared publishing, actual PCM
changes on linked recordings, new preset/icon creation, role order, inheritance,
unchanged recorded bytes/trim/history, drag cancellation and compact geometry.
It captures 60 screenshots across EN/RU/UK, all six badge themes, inspector widths
280/540/900, 1/8-stage four-column editors at 1280×720, and narrower windows
through 640 px with 150% zoom. Generated media, logs and images are
local ignored artifacts in `audit/single-chain-workspace`.

Automated PCM/geometry checks do not establish subjective listening quality or
physical microphone/touch-device behavior. No GitHub release is implied.

## Current local validation

- Syntax and whitespace checks pass. The full unit/server suite passes 418/418.
  The nine focused single-chain cases include a production disk save/open of a
  600-line scene with three historical variants per recording: its valid legacy
  metadata is 3,185,620 bytes and the migrated metadata is 5,292,820 bytes. The
  user approved increasing the bounded metadata budget from 4 to 8 MiB; media,
  schema counts and DSP budgets stay unchanged. The previous approval blocker
  and failing compatibility regression are resolved.
- The effect workspace now fits four smaller cards per row at the normal dialog
  width; narrower widths use three/two/one columns. Maximum dialog height is
  780 px, with the existing pinned preview/actions and scrolling body.
- In a take's signal path, inherited role stages collapse into a separately
  tinted badge naming the role preset. Its stages do not appear as own effects.
  Bypassed role processing stays visible as a dashed disabled badge. The role
  editor continues to show the actual chain being edited.
- Playwright checks card bounds and four-column geometry with 1/8 effects, role
  badge naming and enabled/bypassed states, six themes/three languages, narrow
  100/150% layouts and drag commit/cancellation across rows. It also retains real
  private/shared-edit, PCM, icon, inheritance, history and unchanged-byte checks.
  The inspector's existing 86-state Playwright matrix remains available.
- Prior native capture/RNNoise/private audition/listener parity, project 13 and
  production Electron UI checks passed. They include process restart, scoped
  audio permissions, output selection, RU/EN/UK, three sizes and 150% zoom.

Logs and screenshots are ignored local artifacts. No installer/release/push is
implied by source tests or a local unpacked build.

Final compact-workspace verification: 95/95 affected browser scenarios across
seven suites pass; all 60 workflow/badge captures and the 86-state inspector
matrix pass. The fresh Windows unpacked build passes its packaged worker,
levels, audition/frozen-export smoke and 12 native screenshot checks. All 146
owned public/server assets match its ASAR; the packaged metadata limit is
8,388,608 bytes. ASAR SHA-256: fdb863c0bbffc85fd11a85f258a601a5f0f21c9124d18eadf6b665c494b31e78.
