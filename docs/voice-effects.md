# Role and take voice effect chains

Role definitions are stored once in scene-scoped `roleEffects`. Each named role has `pitch`, ordered `effects` and a runtime revision. A take retains an ordered individual `effects` array, `pitchMode`, `inheritRoleEffects`, and `excludedRoleEffectIds`. Instance IDs are stable ASCII IDs, independent of array positions; duplicate types are supported. Disabled and zero-amount instances retain their parameters. Exclusions refer only to role-instance IDs and never copy the role definition into the take.

`public/voice-chain-model.js` resolves the effective pitch and inherited/individual stages for playback, previews and exports. Individual pitch replaces role pitch; it is not added. Existing takes without chain fields use a single-stage adapter and retain their explicit pitch. New takes use pitch inheritance. Existing `effect`/`effectAmount` fields remain readable until a chain is explicitly edited; they are compatibility fields rather than a second active processor.

## Audio

The common path is raw take → cached RNNoise Wet/intensity blend → effective pitch → role stages → individual stages → existing volume/pan/mix. Each stage receives the preceding stage's output and blends its own input with its wet output. Disabled stages are skipped. Multi-stage rendering applies speech-level correction once at the chain output, against its pitched clean input, then limits peaks. The original one-stage renderer remains the exact compatibility path, including Monster's internal pitch and old dry/wet behavior.

Echo uses finite feed-forward delay taps. Delay is 0.03–0.8 seconds, feedback is 0–0.7, default 0.22/0.35. Successive taps decay by feedback; the last tap is bounded by a 0.001 amplitude threshold. This avoids Web Audio feedback cycles' extra render-quantum latency. Other effect algorithms retain their existing behavior. Stage tails are added in order; dry trim is applied before the first effect and is not repeated on generated tails. Timeline indexing includes tails when seeking. Video soundtrack output is limited to video duration; effects within that boundary are not cut at original speech end.

Limits are eight stored instances per level, eight active instances in the resolved chain, four active Monster/Cave/Thoughts instances, and at most 12 seconds of tails. Each effect-processed mono buffer is bounded at 64 MiB. Two offline effect jobs may run concurrently, with up to 16 waiting. These limits are conservative resource bounds, not a claim that every maximal chain sounds good. Invalid settings are rejected before persistence; processing failure is visible and exports refuse missing processed takes. Existing raw/processed caches remain 128/256 MiB. Keys include effective order, amounts, parameters, pitch, trim and noise settings; inert instance identities are omitted. Draft preview is uncached and serialized/debounced. Role changes refresh only dependent recordings whose effective configuration changed; live catalogue edits select new resolved keys while bounded old buffers remain usable by independent copies and frozen exports.

## Inspector and preview

A collapsed voice summary keeps ordinary recording controls compact. It opens the role/take editors; hosts/moderators can also open a role editor from the track's existing label, including an empty role. Both Dub and Edit inspectors use the same controls. Pointer dragging supports mouse/touch, and Up/Down buttons provide keyboard alternatives. One slider per instance, enable/delete, duplicate effects and Echo parameters edit a local draft. No intermediate slider or drag events are broadcast.

Scratch preview uses the existing raw/processed pipeline with a private AudioContext and no shared edits. A/B bypasses pitch and voice effects while retaining the saved noise setting. Replacement buffers preserve playback position with a 30 ms crossfade. Loop bounds include audible tails and exclude discarded trim. Only accessible samples are listed, respecting Blind Mode; no microphone is requested. Closing, disconnecting or changing scene/take/role stops preview and cancels stale work. A role without takes can be configured but has no audition sample.

## Authority, lifecycle and conflicts

`voice_update` uses existing authenticated scene middleware, snapshot barriers and operation receipts. Role edits require `canModerate`; individual edits reuse `takeMix.canEdit`, preserving author/host/moderator permissions after role reassignment. Requests capture scene, role revision or take ID/URL/mix revision and character. Batches validate every member and resolved active/historical combination before applying anything. Strict room persistence precedes the ACK; failed writes roll back. Lost ACKs retry the same operation ID once, and uncertain/conflicting results stay visible for review.

Bulk replace/append/clear/inheritance are explicit actions with count confirmation. Append, clear and inheritance preserve pitch; preset append may explicitly opt into a pitch override. Bulk replacement preserves each take's existing pitch/mode, inheritance and exceptions unless the user explicitly edits those controls. Mixed values are shown; append starts a separate empty draft rather than appending the first selected take's existing chain. Draft audition previews the chosen operation on its sample. It does not change trim, alignment, volume, pan, author, pins, audio identity or retake comments. No DSP edit archives a new audio file.

Take history extracts/activates deep copies of all individual chain fields. Role settings stay live rather than being copied into history. Restoring an old take uses that take's own settings and the current role definition. Rename moves the one shared definition; merging keeps the target role definition, including an empty target. Editor Undo retains role-definition transitions and refuses to overwrite a later role edit. Deleting a track stores its definition with trash/Undo data and removes it from active roles. Shared scene persistence and project import/export retain the state.

## Portable format

Format 8 stores `project.roleEffects` once and the per-take chain/inheritance fields for main and historical takes. Runtime role revisions reset on import. Formats 1–7 stay readable, preserving the old single-effect sound through the adapter. Scenes without new chains may still emit the lowest applicable legacy version. Invalid types, IDs, parameters, resource limits and role references fail validation before extraction. Audio assets are unchanged, hashed and captured by the existing archive snapshot.

Video export snapshots freeze effective configurations per take, including server lease snapshots; later role edits cannot change an in-progress mix. Fast, original/custom video and WAV stems share processing. Standard editable Voxalike packs keep their existing format and export behavior; chain metadata belongs in `.dubline`.

## Manual acceptance

Use `node tools/voice-chain-listening.js` to prepare ignored local voice examples from the previously authorized local samples. `dry` is the same saved voice without effects; **no artificial noise is added**. Listen to Robot→Echo vs Echo→Robot, Telephone→Cave, Monster→Echo and repeated Radio. Check whispers, shouting, quiet endings, partial amounts and tails. Old effects deliberately retain their established coloration.

Check real microphone recordings, six themes, all three languages, narrow windows, native 100/125/150% scaling, touch dragging, role reassignment and host/moderator conflicts during a real group session. Numerical tests do not establish subjective quality or full Safari/Firefox device compatibility. External tunnel/VPN routing is unchanged and is not claimed as fully tested here.


## Scene presets and editor controls

The inspector exposes one chain editor for effects and pitch; volume, pan, trim, shift and take history retain their existing controls. Legacy effect/pitch/effectAmount data still adapts into a chain. The editor keeps its header and Apply/Cancel footer visible while its main body scrolls. Preview plays once by default; Loop remains an explicit local choice. Missing samples disable only audition and use the shared keyboard/hover explanation. Dirty close/reload or preset replacement offers Save, Do not save and Continue editing.

Scene presets are stored in scene-local voicePresets. New explicit voicePresetId links resolve their current definition; Copy Replace/Append and all format-10 applications remain independent snapshots. Any admitted participant may create one; its creator, host or moderator may rename, update or delete it. The protected voice_preset_update operation binds scene/revision/actor, uses immutable receipts, persists before broadcast/ACK and rolls back disk failures. Other participants receive the catalogue in snapshots and deltas. Unknown client results retain the original operation and expose Check result / retry rather than send a new mutation.

Save as preset captures the draft independently of applying the role/take. Applying a preset first changes only the local draft, with replace or append and an explicit optional pitch override (off by default). Inheritance and individual exceptions remain active. All selected targets must fit the combined chain limits; no stage is silently truncated. New instances are deep copies with fresh IDs, including distinct IDs for every take in a bulk operation. Catalogue update/deletion never changes already applied audio settings.

See [live presets and workflow validation](live-presets-workflow.md), the historical [copy-presets validation](ui-presets-integration.md), and [project formats](project-format.md).


## Live bindings and optional level correction

Resolution order is inherited role definition (including its optional linked preset), take preset, then individual extras. take.usePresetPitch opts into linked pitch; individual/role pitch otherwise retains its existing meaning. Common Save validates current, historical and trashed dependants atomically. Detach freezes effective settings with independent instance IDs and preserved inherited exclusions. Used deletion explicitly detaches all references and retains editor Undo restoration. Catalogue rename alone preserves the private sound draft. Frozen exports capture resolved voice and shared level choices.

Optional per-take level correction follows voice DSP and precedes manual volume/pan. It measures the existing buffer in one bounded worker and returns a numeric gain; toggling it never reruns RNNoise or voice effects. Playback, noise/effect audition, A/B and offline/windowed export share it. It defaults off, limits correction, avoids near-silent/ambiguous noise boosts and leaves the existing limiter active. It is not certified programme normalization or a subjective quality classifier.


## Wide effect workspace

Role, individual-take and common-preset editing use the same responsive workspace, with sound controls and numbered effect cards on the left, a visible preset panel on the right and audition/apply controls in a fixed footer. Effects are added directly from a nine-choice palette; Echo fields and preset management stay visible. The signal path resolves inherited and linked stages using the same draft as audition. Theme-colored switches enable stages. Cards drag with a pointer-following ghost and an animated insertion placeholder; only release inside the chain changes the local draft. Escape, blur, capture loss and scene closure cancel the gesture. Move buttons support keyboard use. Narrow/zoomed windows stack the panels and scroll the body while retaining footer access. See [visual verification](effects-workspace.md).
