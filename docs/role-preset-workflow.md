# Role presets, bulk assignment and spatial selection

The multi-selection inspector offers the same quick preset picker as a single
line. Its label states the editable count out of the full selection. Participants
can assign their own recordings and owned unrecorded lines; host/moderator rights
remain unchanged. Foreign recordings are excluded from a participant's inspector
operation. A bulk replacement requires confirmation, links one complete own chain
to each eligible line and preserves inheritance, exclusions, clip mix, trim,
timings, history and original audio. Detach keeps the current own sound. Future
recordings retain the line's selected preset. Different preset links display Mixed.

The request uses the existing durable editor queue. It captures the selection,
scene, exact take identity, mix revision and source/destination preset revisions
before confirmation. The client checks the captured selection again; the server
checks every target and the resolved DSP budget before changing anything. One
stale or unauthorized target rejects the entire request.

## Applying effects to roles

The host, moderators, Single Player and a participant holding a complete role
claim can open its effect editor. Holding only an individual line does not grant
role editing. Rights are checked in the shared client permission helper and on
every server mutation; the editor closes after ownership is lost.

Apply to role directly creates or updates its isolated preset, carrying an
explicit `role` name binding. Existing and future inheriting lines hear updates.
The role editor has no private-variant warning or general take-preset library;
its icon remains editable. Repeated Apply updates the same source. Role presets
are excluded from take selectors and rejected by server take mutations and the
general preset mutation endpoint. A new role owner can update the previous
owner's source through the role editor without acquiring other roles' rights.

Creating or renaming a take preset to an existing role name is refused with a
rename warning. Forged confirmation metadata cannot create a role binding. If a
role is created/renamed after a same-named ordinary preset, that ordinary preset
receives a unique ` (preset)` suffix. Its ID, effects, take links and authorship
remain unchanged. Role rename and Undo move the explicit role binding with it.

Role binding and catalogue updates use one strict disk transaction and the same
immutable operation receipt. Failure restores both catalogue and role state;
retrying a known operation cannot create another entry or increment twice. The
existing catalogue count and resolved-chain budgets remain enforced.

## Shift selection

Shift-click uses the original clicked cue as its anchor. On one track it selects
only that track's cues between the endpoints. Across tracks it selects cues whose
time intervals overlap the endpoints' time range and whose tracks fall between
the endpoint tracks in the current visual order. Numbering and array order do
not determine membership. Hidden filtered cues are excluded. If the filter hides
the anchor, the next Shift-click starts a new one. Changing scenes resets it.
Ctrl/Command selection and Shift-drag microphone alignment retain their behavior;
clicking a foreign take with Shift does not start a latency edit or show its error.
Both Dub and Edit modes use the same selection rule.

## Compatibility and verification

The isolated role binding and equalizer use project format 15 and voice capability
5; earlier project formats remain readable. Legacy direct take references to a
role preset become independent exact snapshots, including archived takes and
trash. Borrowing another role's source is also detached without changing sound.
Pure old role chains retain their audio path until explicitly applied. See
`equalizer-role-isolation.md` for current verification.

`role-workflow.test.js` covers spatial bounds, ownership, reserved role names,
conflicts, automatic preset creation and preservation of a borrowed source.
`e2e/role-workflow.e2e.js` covers real Shift clicks and filters, three participants,
automatic publication, owner transfer, bulk future/current takes, warnings,
rollback, immutable retries, stale bulk rejection, project export and restart.
The suite is included in both CI browser commands. Current verification results
are recorded in `equalizer-role-isolation.md`.

`node tools/role-workflow-qa.js` uses Playwright against an isolated studio to
check bulk controls at 280/540/900 px in six themes and three languages, both
modes, 100/150% zoom and localized isolated-role editors. Screenshots remain
in ignored `audit/role-workflow`. No build, push or release is implied.
