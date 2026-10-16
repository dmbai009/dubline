# Pitch as an effect stage

The common role/take/preset editor offers a Pitch card with a -12…+12 semitone
slider, enable switch, deletion and the existing keyboard/pointer ordering controls.
Its position in the chain determines where pitch shifting runs. The former
header pitch slider, inheritance selector and preset include-pitch switch are gone.
There is no separate strength control on a Pitch card; zero and disabled cards
bypass processing. The existing stage limits still apply.

The shared chain schema stores `{ type: 'pitch', amount: 1, enabled, parameters:
{ semitones } }`, with a bounded finite semitone value. Rendering uses the existing
WSOLA/resampling processor, preserves sample count and creates no effect tail.
Live playback, private audition, frozen export and stems use the same renderer.
Role stages precede the take's own stages and respect role inheritance/exclusions.
Existing creator/author/moderator rights, confirmation before shared publication,
revision conflicts and immutable acknowledgement recovery remain in force.

## Compatibility

The old scalar pitch and preset-pitch fields remain a compatibility reader.
Opening and applying an unedited old chain retains its original rendering path,
cache identity and sound. The editor presents an explicit old own pitch as its
first card without changing stored data. Editing/toggling/moving that card expands
it into a real stage and zeros the legacy scalar exactly once. Unrelated effect
edits do not unnecessarily convert legacy audio. Mixed bulk legacy values remain
independent until explicitly replaced; Remove all effects clears own pitch too.
Legacy role pitch remains resolved as before until the role itself is edited.

Presets containing pitch stages replace any former own scalar pitch through both
the full editor and inspector quick assignment. Shared presets remain live until
privately edited; pitch edits cannot silently change other recordings.

Projects containing the stage use portable version 14 and media remains unchanged;
projects 1–13 remain readable and scenes without stages retain their lowest
applicable format. Older project versions reject a smuggled pitch stage. Client
voice capability 4 is required whenever the scene catalogue, roles, takes,
history or trash contains the stage, so older clients cannot silently drop it.

## Verification

`voice-chain.test.js` covers parameter bounds, bypass, legacy editor adaptation,
role ordering, client capability and version-14 take/history/preset round trips.
`e2e/pitch-stage.e2e.js` uses real Web Audio and sockets to check ±12 frequency,
duration, zero/disabled parity, order-dependent PCM, private/shared presets,
author rights, role bypass, restart, old-client refusal, exact legacy-cache
preservation and inspector assignment over a legacy scalar pitch.

Existing chain/preset/inspector/mix suites use the new card controls while keeping
recording bytes, history, shared publishing, rollback and lost-ACK assertions.
`tools/pitch-stage-qa.js` uses Playwright in a real isolated studio: 58 screenshots
cover 1/4/8 cards, six themes, EN/RU/UK, 640/900/1280-pixel windows and 150% scale.
It checks four-column card geometry, dialog bounds and removed header controls.
Screenshots and logs stay local in ignored `audit/pitch-stage` paths. No release,
rebuild or publication is implied by source verification.

Local results: syntax/whitespace checks pass; the full unit/server run passes
461/461, followed by passing focused model/compatibility checks after the final
preset-replacement adjustments. The final six-suite browser profile passes
76/76 with no skips. The native Electron chains smoke passes real capture,
RNNoise, pitch-card audition, listener PCM parity and version-14 project export.
