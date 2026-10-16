# DubLine UI, effect chains and scene presets

Implementation and validation: 2026-10-14–15, based on main at `6d625be`. DubLine's existing license and application version 1.4.0 are unchanged. Existing local documentation notes were preserved.

## Interface changes

RNNoise audition now plays once, within `audio.takeBounds`, and returns to Listen on completion. Pressing Listen again starts at the beginning. Manual stop and natural completion invalidate pending preview refreshes. Strength/effect changes during playback retain position and the existing 30 ms crossfade; the cached RNNoise Wet is reused. With effects is a standard switch and affects only local audition, including effective pitch and inherited/individual chains.

A missing own recording disables audition and explains why through the existing `setControlHelp` hover/focus surface. The same pattern covers effect-chain audition without an accessible sample. A missing/unloadable existing file is a processing error, rather than the explanation for having no recordings. The first recording activates audition automatically. No microphone-calibration flow was added.

Needs Retake is a standard switch. Its comment stays visible and read-only for ordinary participants. Legacy local author drafts cannot conceal the authoritative retake reason. Existing notification, counter, conflict revisions, durable editor queue and replacement-recording cleanup remain intact.

The single and multiple-selection inspectors retain volume, pan, trim, take shift, original playback, recording controls and history. Effect, effect amount and pitch now have one editing surface in the chain editor. The legacy fields remain in serialization/model adapters; old single-effect projects continue to resolve correctly. The compact summary describes active inherited and individual stages, with a full description available on expansion.

The chain dialog separates header, scrollable settings and a persistent audition/Apply/Cancel footer. Presets occupy a collapsible group at the end of the main body, so expanding management cannot push Apply outside a small window. Effect cards retain drag, keyboard Up/Down, enable, amount, delete and Echo parameters. Preview defaults to a single play, with explicit Loop still available. Changing locale also updates the dynamic title, scope text and current audition/preset status.

Closing a changed draft or replacing it with a preset offers Save, Do not save and Continue editing. An unchanged close asks nothing. Modal close restores its initiating focus when the element still exists. A failed preparation clears the unusable audition buffer while keeping editing available. An unconfirmed `voice_update` retains its immutable request, freezes draft editing and checks the original receipt before retry; known recovery resynchronizes the authoritative scene.

## One dropdown component

`public/dropdown.js` and `dropdown.css` adapt single-value selects throughout the studio, including audio devices, filters, role/line choices, effects, presets and audition samples. Native selects remain the source of options/value and the existing input/change interface. Multiple/listbox selects retain native semantics.

The visible combobox uses one popup/listbox with selected and disabled states, mouse choice, arrows, Home/End, type-ahead, Enter, Escape, Tab/Shift+Tab and visible focus. Lists of ten or more options offer search. Programmatic value/selectedIndex/option.selected updates and dynamic option changes update the visible control. Choosing the already selected option emits no new mutation.

The popup uses the browser top layer where supported, flips above low anchors, limits height and scrolls. It remains inside its containing dialog or declared dropdown surface, preventing an option click from closing a parent role picker. Layout accounts for interface zoom. The shared tooltip surface also stays inside modal dialogs. Theme colors come from DubLine variables.

## Scene preset model and synchronization

`voicePresets` belongs to one session through `SESSION_FIELDS`, empty-session defaults, active snapshots, switching, persistence and portable import/export. It is neither a global library nor localStorage data.

The catalogue is bounded to 50 entries. Each entry has:

- A unique ASCII ID, name of 1–80 characters and creator nickname.
- An ordered, deep-copied effects array with instance ID, type, enabled, amount and validated parameters.
- Optional finite pitch in −12…+12 and a positive safe-integer revision.

No media, timing, take identity, required role name, volume/pan, noise settings or other-scene data is permitted inside preset settings. The existing voice-chain validator enforces eight stored stages, eight active resolved stages, four heavy active stages and the existing tail limit.

Save as preset captures the current editor draft before the name dialog and saves that snapshot independently of applying the role/take. Explicitly discarding the role/take draft cannot undo a separately confirmed preset save. Update/delete confirms the selected preset ID/revision captured before the prompt.

Applying a preset changes only the local draft until ordinary Apply. Replace and append preserve stage order and parameters and generate independent instance IDs. Bulk append preserves each selected take's own chain; the server generates distinct IDs for newly copied stages in each take. Pitch application is an explicit switch, off by default. Inherited role effects and individual exceptions remain active. Every selected target must satisfy the combined chain limits; a failed application leaves the whole draft unchanged and never truncates stages.

Applied settings are ordinary take/role data, with no live preset reference. Updating or deleting the catalogue entry cannot change previously applied takes, including their history. RNNoise settings and original audio files are unaffected.

## Server authority and durability

`voice_preset_update` uses authenticated scene middleware, the existing snapshot freeze and `editorOperations.registerMutation` receipts. It supports create, rename, update and delete:

- Any admitted participant in a loaded active scene may create.
- The creator, host or moderator may manage an entry.
- Current entry revision must match; stale updates fail instead of overwriting.
- The preset API cannot modify recordings. Applying uses the existing `voice_update` take ownership/identity/revision validation.

Strict disk persistence precedes broadcast and ACK. Failed writes restore the prior catalogue/timestamp and active snapshot. New participants receive the current catalogue in the scene snapshot; current participants receive `voice_presets_updated`. A nickname change transfers creator identity and advances the entry revision. Normal scene switching never carries the old catalogue into a new scene.

The UI retains an unconfirmed immutable preset operation, retries the same ID and consults `editor_operation_status`. While its outcome is unknown, further catalogue mutations remain disabled and Check result / retry stays available. There is no new competing editor-operation protocol.

`set_needs_retake` now authorizes only `canModerate` on the server. Recording authorship and role ownership do not grant this permission. Direct Socket.IO requests from those ordinary participants are rejected. Retake requests continue to use the existing durable editor queue and revision rules. Recording a new authorized take still clears the request automatically.

## Portable projects

The writer emits format 10 only for a nonempty scene preset catalogue. It includes the validated RNNoise, chains and history schema plus explicit `voicePresets`; runtime editor receipts/drafts are excluded. Formats 1–9 remain readable and import an empty catalogue. Older versions reject a hidden preset field. Without presets, the lowest applicable existing format remains in use.

Real save/import/reopen/restart tests verify the catalogue, effects, author metadata and original recording hashes. A fresh scene has an empty catalogue; returning to the previous scene restores its library. See [project formats](project-format.md).

## Changed implementation areas

| Area | Files |
| --- | --- |
| Shared dropdown and preset UI | `public/dropdown.js`, `public/dropdown.css`, `public/voice-preset-ui.js`, `public/voice-preset-model.js` |
| Existing studio interface | `public/noise-ui.js`, `public/retake-requests.js`, `public/voice-chain-ui.js`, `public/voice-chain.css`, `public/ui.js`, `public/control-help.js`, `public/action-help.js`, `public/dialogs.js`, `public/timeline-navigation.js`, `public/snapshot-barrier.js`, `public/index.html`, `public/locale/en.js`, `public/locale/ru.js`, `public/locale/uk.js` |
| Server and project data | `server/voicePresets.js`, `server/voiceChains.js`, `server/rooms.js`, `server/projects.js`, `server/sessionScope.js`, `server/sockets/roles.js`, `server/sockets/room.js` |
| Automated checks | `voice-preset.test.js`, `test/dubbing-workflow.test.js`, `e2e/ui-presets.e2e.js`, `e2e/collaborative-dubbing.e2e.js`, `e2e/take-mix.e2e.js`, `e2e/voice-chain.e2e.js`, `tools/electron-noise-reduction-smoke.js`, `tools/electron-ui-cleanup-smoke.js`, `tools/electron-project-smoke.js`, `tools/electron-smoke.js`, `tools/voice-chain-listening.js`, `package.json` |
| Documentation | `README.md`, `PRODUCT.md`, `ARCHITECTURE.md`, `BEHAVIOR.md`, `TESTING.md`, `docs/project-format.md`, `docs/voice-effects.md`, `docs/regression-matrix.md`, this report |

No new runtime dependency was required. The runnable local build is `dist/win-unpacked/Dubline.exe`; keep the unpacked distribution directory together. The validated local build accompanies these source changes.

## Validation and corrected regressions

Verified results:

| Check | Result |
| --- | --- |
| Unit/server/model suite | 378/378, no skips |
| Complete browser regression suite | 485/485 across 38 suites, no failures/skips; 1,008.5 seconds |
| Focused presets/chains/mix browser profile | 47/47, no skips |
| Actual RNNoise browser scenarios | 17/17, no skips |
| Native RNNoise and voice chains | PASS, actual capture, one-shot audition, cached Wet, listener PCM comparison and project v9 |
| Native project and clip mixing workflows | PASS, chain editor and save/open across modes |
| Recovery and collaboration browser checks | 34/34, no skips |
| Final scene-preset/UI browser suite | 21/21, no skips; lost ACKs, disk rollback, nickname ownership, scene switching, format 10, six themes, 80-character preset labels and EN/RU/UK at 150% |
| Native interface workflow | PASS, actual capture/output selection, restart, three locales, narrow windows and 150% |
| Rebuilt packaged Windows application | PASS, actual recording, local RNNoise, guest shared preset, project roundtrip, source/proxy import and video/ZIP export |
| Static checks and patch whitespace | PASS |
| Packaged source/model proof | All 11 checked source files match the final ASAR; RNNoise retains its verified 4,827,304-byte artifact and SHA-256 |

The complete browser rerun passed after correcting the collaboration tests to exercise the visible dropdown and host/moderator retake permissions, and waiting for the host admission/media-readiness gate before the restart/scene-return test. The final targeted preset suite also passed with the dynamic-locale status assertion and maximum-length preset label geometry checks.

The packaged smoke workflow explicitly answers the existing P2P consent prompt before opening the effect dialog, matching the actual user flow. No consent or media authorization gate was weakened.

Regression work included preserving distinct bulk chains and copied IDs, keeping Escape inside a dropdown, avoiding popup reconstruction on unrelated DOM updates, retaining the parent role picker during selection, translating dynamic editor labels/status, keeping tooltips visible during keyboard-induced scrolling, clamping popups/tooltips at 150% zoom, protecting unconfirmed operations and keeping legacy unauthorized comment drafts from masking a current request. Existing tests that expected removed effect/pitch controls now use the chain editor; their recording, mix, history, permission and persistence assertions remain. Native geometry checks measure the visible dropdown rather than its hidden source select. Native capture checks await the existing media-readiness gate and verify natural preview completion instead of indefinite looping.

All test servers/profiles use temporary data. Real rooms, uploads and user recordings were not used as mutable fixtures. Local screenshots/logs remain ignored under `audit/ui-presets` and existing native QA directories.

## Preview-status CI follow-up

The CI follow-up on 2026-10-16 reads the dynamic preview status text and locale
key in one browser evaluation. Reading them in separate protocol requests could
compare the old Preparing text against the new Ready key. A regression holds a
real preview result, changes locale, then releases it between reads and verifies
both complete states. Production preview/localization behavior is unchanged.

The native workflow fixture also waits for the admitted media transfer, actual
decoder readiness, completed seeks and the ordinary audible-source preparation
gate before starting recording in that same browser turn. A transient refusal
during microphone acquisition is retried only while recording remains idle.
The original timeout and the requirement to produce a real recorded take remain;
application buffering/permission checks are unchanged.

The peer-disconnection/corruption fixture gates every HTTP Range request until
its required peer bytes arrive, rather than only the first request. A real peer
handshake is deliberately delayed past the fallback grace. Transfer integrity,
durable chunks, canonical HTTP repair and the separate fallback-latency assertion
remain checked with the original timeouts. Production P2P behavior is unchanged.

## Remaining manual acceptance

Check physical microphones/output devices and hot-plugging, screen-reader announcements, touch, real remote/tunnel sessions, Firefox/Safari and subjective speech/effect quality. Automated multi-user Chrome and production Electron tests establish software behavior; they do not replace physical-device or WAN acceptance. Existing RNNoise model provenance/licensing considerations remain in [the RNNoise report](rnnoise-integration.md).
