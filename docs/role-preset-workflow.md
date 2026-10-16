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

Apply to role confirms publishing and automatically creates a shared library
entry with the exact role name, or updates that entry in place. The role becomes
a live reference. A generic preset used as a starting point is copied into this
named entry, leaving the generic source unchanged. Existing/future inheriting
lines and all other live references to the named entry hear its updates; private
modified variants retain their own sound. Repeated Apply does not add duplicates.

Manually creating or renaming a preset to an existing role name shows a warning
explaining the role binding and affected live references. Confirming captures the
role's current revision/reference and requires permission to edit that role.
Creating under an already-used role name explicitly updates its existing named
entry after this warning. Cancelling changes nothing. The server rejects missing
confirmation metadata, stale role bindings, duplicates and unauthorized writes.

A new role owner can update the named preset created by a previous owner. Rename
and delete still require creator/moderator authority, together with role editing
rights for role-named entries. Other roles and general preset management retain
their existing permission rules.

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

No new serialized fields, project version, audio engine or mutation protocol are
introduced by this workflow. Existing independent and linked role chains retain
their sound until explicitly applied. The previous pitch-stage work's format 14
and voice capability 4 requirements remain unchanged.

`role-workflow.test.js` covers spatial bounds, ownership, role-name confirmation,
conflicts, automatic preset creation and preservation of a borrowed source.
`e2e/role-workflow.e2e.js` covers real Shift clicks and filters, three participants,
automatic publication, owner transfer, bulk future/current takes, warnings,
rollback, immutable retries, stale bulk rejection, project export and restart.
The suite is included in both CI browser commands. The full unit/server suite
passes 465 cases; the nine affected browser suites pass 112 cases, followed by
the final ten-case workflow check including hidden-anchor recovery.
The final inspector/preset/workflow rerun passes 38/38 cases, including editor
closure when a claimed role is released. Syntax, locale parity and whitespace
checks also pass.

`node tools/role-workflow-qa.js` uses Playwright against an isolated studio. It
checks bulk controls at 280/540/900 px in six themes and three languages, both
modes, 100/150% zoom, one/eight-stage owner editors and localized publishing
confirmation. Its 27 screenshots and logs are ignored artifacts under
`audit/role-workflow`. Browser checks do not replace a physical microphone or
subjective listening check. No build, push or release is implied.
