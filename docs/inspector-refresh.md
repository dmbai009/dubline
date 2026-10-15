# Adaptive inspector and compact effect editor

Follow-up: current single-chain behavior is in single-effect-chain.md. The latest workspace is up to 1,160 × 780 px; its sidebar expands without reducing the previous chain area. History now belongs to Recording below mic gain; see studio-ux-fixes.md. Historical implementation notes and measurements follow.


The inspector now groups the existing controls into recording, voice, clip mix and history/review sections. Groups use thin separators rather than large cards. Container queries select one, two or three columns from the panel's available width; the existing splitter now allows up to 960 px. Narrow layouts retain vertical scrolling and all existing gain, recording, claim, original-preview, pin/history, quality, retake, trim/shift, volume and pan controls. Edit Mode retains its form, timing protection, leases and private caption drafts. Changing the language rebuilds labels while preserving the unsaved form and caret.

The common role/take/preset editor is capped at 1,060 px wide and 840 px high, with smaller stage rows, inline Echo controls, a direct effect palette and a compact preset sidebar. Narrow windows stack panels; the body scrolls independently of the audition/Apply footer. Dragging retains its floating card, animated insertion and keyboard alternatives. Focus now stays on the stable chain container during dragging, so Escape cancels the gesture even when moving DOM nodes or disabling the last palette button at the eight-stage limit.

## Inspector preset selection

The inspector's selector attaches an existing scene preset through `voicePresetId`. It retains all individual stages, their strengths and parameters, inheritance/exclusions, manual pitch, clip gain/pan and trim. Switching an existing link requires confirmation. Removing the link explicitly detaches it, freezing its stages and optional pitch without changing the sound. Combined resource limits reject incompatible additions; no stage is silently discarded. The full editor remains available for individual processing and creating/editing common presets. Save as new captures the linked stages together with individual extras rather than saving an empty chain.

Assignment uses `voice_update` through the existing durable editor journal, exact take identity/mix revision, preset revisions, server authorization and atomic validation. No optimistic audio is published. Missing acknowledgements recover the original operation receipt; final resync confirms authoritative state. Unknown requests remain in the existing recovery UI and block duplicate assignment. Read-only, unrecorded, busy and unavailable controls remain disabled.

## Preset icons and compatibility

Preset `icon` is optional bounded presentation metadata, selected from twelve built-in values. It is separate from DSP settings and does not invalidate sound caches. Creation/common editing saves it with the preset; sound-only updates and rename preserve it. Selecting the default voice icon omits the field. User-supplied SVG, URLs and arbitrary keys are rejected.

Projects with icons explicitly use format 12, with the audio/reference fields of format 11. Readers retain formats 1–11, and scenes without icons keep the lowest applicable older format. Older-version manifests cannot smuggle icon metadata. Existing recordings and references are unchanged. Runtime capability `voiceVersion: 2` supports icons; ordinary live/level scenes still accept version 1. Creating icon metadata is refused while a version-1 participant is connected, and icon scenes refuse older clients with the existing update explanation.

## Timeline filters

The obsolete `timelineRoleFilter`, its option rebuilding, event handlers, stored single-role predicate and search/minimap dependencies are removed. Scope, multiple role choices, per-line overrides, status, search, own retakes and temporary reveal remain. Legacy `saved.role` no longer acts as a hidden filter; saved multiple-role choices/status/overrides still restore.

## Verification

Local checks on 2026-10-15:

- Syntax check: PASS.
- Unit/server suite: 409/409, seven suites, 37.3 s. Includes bounded icons, authorization/preservation, format-12 round trip/staging and rejection of old-version metadata.
- Existing affected browser profile: 127/127, seven suites, 150.4 s: editor hardening, live presets, media/presence/filter controls, take history, clip mixing, preset UI and voice chains.
- Final affected browser rerun: 67/67, four suites, 94.8 s, after the final editor-label and linked Save-as-new refinements. Includes the six new cases below; these overlapping runs are not independent totals.
- New inspector browser cases: 6/6, including safe link/replacement/detach, foreign author rights, old-client gating, icon creation/project export, legacy filter restoration and unsaved caption/caret across resize and language change.
- Playwright: 86 real-studio screenshots and functional assertions. Dub/Edit at panel widths 280/360/540/900, three themes and EN/RU/UK; unrecorded/foreign/multi-selection views; role/take editors with one/eight stages at two viewport widths; drag/ Escape; actual linked selection, immutable lost-ACK recovery, original history/pitch/effect preservation and icon creation. Representative dark/light, narrow/wide, compact-editor and drag captures were visually inspected.
- Native Electron workflow: actual microphone capture, RNNoise, private audition, browser-listener parity, levels/quality and portable format 11 PASS. Native UI functional check also passes production main/preload, actual device selection, profile restart, three locales/window sizes, 150% zoom and fullscreen seek.

The initial regression pass caught one remaining callback to the deleted role-dropdown builder; it is removed and the 127-case rerun passes. Visual testing additionally caught the drag-focus cancellation issue and mixed-language cached editor labels. Tests retain the new behavior without weakening authorization, chain limits or original-audio checks. The eight-stage visual fixture uses a clean take so its combined chain remains valid.

The Windows unpacked build passes source equality for all 146 owned JS/CSS/HTML files. Its final packaged worker/audition/frozen-export check and 12 native layout screenshots pass. ASAR SHA-256: `601aaf3ad59887d34dc0d1c680bb4ac9aab2e4f81a984136b334b39536fa107a`. The RNNoise bundle remains byte-identical (`e6958293a0118bf9860cb2753332f7562531cc987c914552c426cd7d7180a63e`).

The complete browser suite was not rerun in this pass. Logs, screenshots, source-package proof and temporary fixtures remain local under ignored `audit/inspector-*`; real user projects were not used. Physical touch input, screen readers and subjective physical-device audio remain manual checks. Application version and license remain unchanged; no GitHub release is created by this work.

Reproduce visual verification with `npm run qa:inspector` after the same QA-only Playwright driver setup described in [effects-workspace.md](effects-workspace.md). Normal browser checks include `e2e/inspector-presets.e2e.js` in `test:e2e` and `test:ui`.
