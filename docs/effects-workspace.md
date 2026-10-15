# Effect workspace and unprocessed microphone capture

The role, individual-take and common-preset editors share one wide workspace. Sound controls, numbered cards and a direct nine-effect palette occupy the main panel. Preset selection, assignment, optional pitch, saving and catalogue actions stay visible in the side panel. The fixed footer retains audition, cancellation and Apply. Echo parameters are inline. Switches use the current theme, with visible keyboard focus. Existing author/moderator rights, private drafts, shared presets, confirmation and receipt recovery remain authoritative.

The signal path uses the same resolved draft as audition, including inherited role effects and linked presets. Arrows and numbered cards show processing order; a return arrow denotes a new row. At 1600×900 the one- and eight-effect views fit without body scrolling in all six themes and EN/RU/UK. Narrow or zoomed windows stack panels and scroll the body while keeping the footer visible.

Dragging lifts a card under the pointer, animates an insertion placeholder and previews numbering. Pointer capture belongs to the stable chain container, so moving its children cannot interrupt the gesture. Only release inside the chain changes the local draft; no drag event is broadcast. Escape, blur, capture loss and editor/scene closure cancel the gesture. Existing move buttons support keyboard operation. Reduced-motion preference disables movement animation and card rotation.

Browser microphone noise/echo processing has been removed from settings, localization and runtime preference state. The old local enable preference is discarded. Recording, device fallback and permission requests explicitly set `noiseSuppression`, `echoCancellation` and `autoGainControl` to false. Even a caller passing true cannot re-enable them through the capture boundary. This does not remove WebRTC media delivery or cursor connections. RNNoise retains its existing author-scoped postprocessing, private preview, save-on-settings-exit and original recording bytes; its card occupies the former browser-processing position. My own auto-ducking no longer inherits the extra top margin from its former shared card.

## Actual verification, 2026-10-15

- Syntax check: PASS.
- Unit/server checks: 406/406, 7 suites, 34.3 s.
- Final affected browser profile: 80/80, 5 suites, 102.4 s. Includes voice chains, scene presets, live presets, RNNoise and clip mixing, with actual DSP, author rights, confirmation, lost acknowledgements, history, archives and theme/locale checks.
- Playwright: PASS against the actual Chromium studio. 72 scope/count/theme/language layouts, four narrow 150% views, two drag screenshots, a 150% reduced-motion drag and the settings view; 80 retained screenshots plus the diagnostic latest-layout image. Assertions cover no desktop body scroll, no horizontal overflow, visible footer, all stage switches, pointer-following geometry, local-only ordering, preserved per-instance amounts, cancellation, actual capture constraints and RNNoise/auto-duck placement. Representative dark/light, one/eight-effect, drag and settings screenshots were also visually inspected.
- Native UI: PASS with production main/preload, actual capture/output selection, profile restart, RU/EN/UK, three window sizes, native 150% zoom and fullscreen seek.
- Native Electron capture/RNNoise/listener parity/private preview/levels/quality/project 11: PASS.
- Final packaged worker/audition/frozen-export check and 12 native layout screenshots: PASS.
- Windows unpacked build: PASS; all 144 owned packaged JS/CSS/HTML files match source, and the RNNoise bundle is byte-identical.

The first visual passes exposed vertical clipping at eight stages and pointer capture loss when moving the captured card. The final implementation fixes both; the final Playwright run passes. Desktop layout refinements also corrected inherited modal centering/header spacing and duplicate emoji/icon presentation. Existing dropdown behavior tests now exercise a dedicated dialog fixture and the visible preset controls; actual effect interactions use the direct palette.

The ASAR SHA-256 is `3d861e7c1963d855e1f55e01a3e0efe84aa000f89a0d38c6920a375981bb0a2a`. The unchanged RNNoise bundle SHA-256 is `e6958293a0118bf9860cb2753332f7562531cc987c914552c426cd7d7180a63e`.

Logs, screenshots and packaged proof remain local under ignored `audit/effects-workspace*`. Test data uses isolated temporary profiles and generated media, not original user projects. Real touch input, physical microphone acoustics, screen-reader experience and Firefox/Safari remain manual coverage. This change does not publish an installer or alter the application version/license.

## Reproduce the visual check

Install the QA-only browser driver without changing the application dependencies:

```powershell
npm install --prefix audit/fx-tools --no-save --package-lock=false playwright-core
node tools/effects-workspace-qa.js
```

The script attaches Playwright to the isolated Chrome/Edge test browser and exercises the real studio, then closes it and cleans up its server fixture. Normal regression commands and Electron tests are documented in TESTING.md.
