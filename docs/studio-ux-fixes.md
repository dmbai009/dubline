# Studio UX corrections (2026-10-15)

The session, recording, history, preset and audio-processing architecture is unchanged. Portable project format remains 13; no stored recordings, history or effect settings are migrated by this pass.

## Effects and inspector

- The dialog grows from 1,060 to 1,160 px, preserving its 780 px height cap. A 228–328 px responsive sidebar takes only the added width. Narrow panels retain the former chain area and stack below 700 px. Preset/icon selectors use separate full-width rows. Delete uses the danger color; four compact stages still fit on a wide row.
- EN/RU/UK use line/реплика/репліка for effect and quick-preset settings, with singular/plural Save labels. Actual recorded-take and history terminology stays intact.
- Voice uses the same heading element, typography and alignment as Recording. Empty role summaries and the redundant Configure role button are absent. Linked role presets show their name and inheritance status only. Audio inheritance/order is unchanged.
- History belongs to Recording directly after mic gain. Ordinary listening, pinning, restore and deletion keep their existing scene/identity/revision/permission checks. Play is green, Delete red, Restore uses a checked-document icon. The separate historical A/B dialog, actions, strings and script are removed.
- Silence trimming is a keyboard-accessible themed switch. It retains the original acknowledged set_takes_props action, permission rules, trim bounds and original bytes. Narrow rows wrap before controls overlap.

## Timeline and collaboration

- The optional sequence recorder, modes, acceptance state and upload callback are removed. One green Next line button uses a small pure navigation model: later unrecorded owned lines in the current role, earlier lines in that role, then the earliest unrecorded line in another owned role. Single Player uses the existing effective ownership of all available roles. Foreign ownership, pending capture and live recordings are respected. Selection/scroll/seek reuse revealTimelineLine; saved filters stay unchanged. No automatic capture, claims or new keyboard shortcut is introduced.
- Recorded lines requesting a retake use the same warning token as the minimap, retaining selection, live/pending borders and author badges.
- The native scrollbar corner uses the current panel background.
- Role effect buttons precede ellipsized role names instead of colliding with progress counts.
- Completion checks sit between the avatar and nickname. Expanded cards have no redundant completion row; compact cards retain their existing icon summaries. Ordinary host/moderator/own badges, network statistics and activity text remain. Moderators use a monochrome blue shield with an explicit contrasting light-theme palette.
- Copy link and PIN shares the PIN/visibility row for Cloudflare, Porthole and VPN. Provider behavior and copy contents are unchanged.

## Dropdown and fullscreen geometry

The old dropdown divided its measured width by integer-rounded offsetWidth to infer zoom, then rewrote its width in ResizeObserver. At fractional scale this fed rounding error back into layout. Positioning now derives cumulative CSS zoom independently of popup geometry and bases placement direction on content height. Pointer hover only changes the active option; keyboard navigation still scrolls it into view. Full selected text is available in the button tooltip.

Fullscreen captions use ResizeObserver on the actual transport (including wrapped rows), preserving the selected subtitle font and multiline content. The visible panel adds its measured height plus the existing gap; the idle class removes the offset. The bottom transition follows the transport fade and is disabled with prefers-reduced-motion. Ordinary embedded-video captions are unaffected.

## Verification

- Unit/server: 422/422, including six new chronological navigation cases.
- Affected existing browser profile: 39/39 (workflow/export/history/inspector).
- Additional affected profile: 62/62 (dropdowns, effect chains, invitation, collaboration and initial UX regressions).
- Final dedicated UX profile after the trim follow-up: 6/6, including actual trim save/restore and unchanged bytes, Single Player, role wrap/filter reveal, all export selectors at fractional zoom and two real fullscreen sizes.
- Playwright driver: tools/ux-fixes-qa.js. It checks the real studio, all six themes and EN/RU/UK, 280/480/640/900 px inspector panels, one/eight effects, full selected preset text, 16 consecutive-frame export-text measurements at 100/125/150%, invitation providers and fullscreen captions with reduced motion. The final pass produced 62 screenshots. Local screenshots/measurements are under audit/ux-fixes.
- The existing inspector Playwright matrix also passes: 86 screenshots, real preset/ACK behavior, rights, themes/locales, adaptive layout, and drag cancellation.

Actual external tunnel connectivity and subjective microphone quality are outside these visual corrections. Test servers use isolated generated media, never real user scenes.

Production Electron UI smoke also passes: the actual main/preload, scoped audio permissions, capture/output selection, process restart, three native sizes, RU/EN/UK, 150% zoom, invitation expansion and fullscreen seeking.

## Uniform toggles follow-up

All remaining checkbox fields now share the theme’s rounded toggle appearance, including native export completion sound, local-duck activation, role-filter selections, trash selections and inherited-stage exclusions. Existing native checked/disabled/indeterminate states, labels, keyboard focus and change handlers remain intact. Labels reserve 8 px between control and text. Radio groups retain their mutually exclusive mode behavior. Mixed values are centered, and reduced-motion disables toggle transitions.

The additional Playwright matrix produces 56 screenshots across six themes, EN/RU/UK, the completion/duck/role-filter controls and 640 px / 150% layouts (tools/toggle-workspace-qa.js). The dedicated browser regression checks real keyboard changes of the export sound preference and selection/filter behavior. Native-only export markup is explicitly exposed for the isolated browser geometry checks; no native bridge or application behavior is replaced in production.

Final toggle checks: syntax PASS; dedicated UX browser profile 7/7; UI cleanup profile 25/25 after retaining compact participant status summaries. Native guest export PASS (picker/cancel, MP4/WebM streaming, saved-file signal and cleanup). The other four affected suites passed in the 86-case combined run; its one compact-status failure was corrected and the complete 25-case suite rerun successfully.
