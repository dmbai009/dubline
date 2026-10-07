# 1.4 regression coverage audit

Baseline: current main / 2f5e4a2, including the post-release Workshop external-link fix. Audit covers user behavior rather than line coverage. Validation commands and latest local results are recorded in [the testing guide](../TESTING.md).

| Area | Behavioral coverage after implementation | Limits |
| --- | --- | --- |
| Launcher / Electron | launcher and desktop browser E2E; editor, host, guest, portable smoke tools; native project smoke for New Single Player, save/close, Open in solo/multiplayer, invalid open rollback; external-link unit/native checks | Native OS picker is substituted in automated project smoke; physical picker UX remains manual |
| Rooms / connectivity | room/security/reliability E2E and integrity tests: host/join, PIN, permissions, reconnect, recording disconnect, nickname migration, claims, active/inactive scenes; workflow14 Single isolation and promotion | Real WAN/VPN conditions vary by network |
| Import / library | audit-integrity/Workshop tests and media/workflow E2E: local/Voxalike, source isolation, library replacement, atomic invalid import; direct-media E2E for exact ZIP/media hash, CORS, version/hash mismatch, timeout, cancellation and fallback | Direct tests inject network responses; public service CORS is not controlled by Dubline |
| Editor | studio/audit/workflow14: roles/rename, create/double-click target exclusion, click seek with zoom/scroll, drag/left+right resize, keyboard/Shift/Alt, inspector, multiselect/mixed tracks, relative/atomic role movement and Undo, video bounds and visual boundary, axis lock, local role heights | Feel and rendering require visual inspection |
| Recording | audit-integrity/room/studio/reliability: MediaRecorder, repeat takes, sequence ordering, delayed/queued uploads, deletion, reconnect, rename, permissions, trims/effects/alignment; project reopen; ADR timing, volume destination isolation and persistence | Fake microphone; physical device/acoustic behavior is manual |
| Project audio | audio unit tests/workflow and six-case actual-sample export matrix: Original/Background/Dub, volume to 150%, mute/solo/offsets/duck, monitoring separation, permission/revision sync, restart/session persistence, source selection | Hardware monitoring quality is manual |
| Export | media/workflow/reliability: WebCodecs and fallback, correct channels, FFmpeg decoded video/audio, stems, effects/offsets, scene isolation, stable snapshots, errors; workflow14 renders after solo→multi→solo | Subjective playback on other players/devices remains manual |
| Projects | projects.test.js: complete assets/metadata round-trip, Unicode/quoted multiline captions, embedded selection, processing/mix/alignment, snapshot revision consistency; bad schema/version/path/CRC/hash/size/missing assets; rollback, real FFmpeg media, auth, stale requests, restart; projects/workflow14 E2E and native project smoke | One active scene/current takes; no pending device blobs/history; video 300MB, streamed archive without aggregate cap |
| Dialogs / settings | workflow14 and editor smoke: centering, Enter/Escape, Tab trap, restore focus, shared text/confirm API, EN/RU/UK, visible disabled guest values, editable collaborative mix, local ADR constraints/preferences | Long localized layouts and physical keyboard feel need visual QA |
| Themes / coverage | studio theme switching and visual QA screenshots; readable light role blocks/header/dialogs, role boundary stripes; labeled current-take Dub coverage and local height resize/reset | Full theme redesign deferred |

## Gaps closed and spec/test conflicts

The initial gaps were portable/cross-mode continuation, native launcher project open, consistent bounds on every editing path, relative mixed-role movement, reusable confirms/focus, ADR local constraints, and verified Workshop direct fallback. Added behavioral coverage at existing layers without another product architecture.

The old oversized-export test created a cue past a 12-second video, contrary to the new duration invariant. It now imports a real 620-second compact video and legal 601-second cue, preserving the original export-size guard assertion. The browser harness now accepts application confirms because native confirms were deliberately replaced; confirm behavior itself is tested with auto-confirm disabled. A restart project test now waits for authoritative loaded session before choosing the file, preventing a stale binding race in test setup.

No uncovered release-critical data-integrity path was intentionally dropped. Automation does not cover physical microphones/headphone loudness, subjective group workflow, every external network/provider, or subjective playback; these are explicit release checklist items.

Large disk IO: projects-stream.test.js exercises real >400 MiB save/open, ZIP64, bounded RSS, immutable snapshots, auth/integrity/cleanup failures, protected downloads and the separate video budget.

Proxy/source + smoother ducking: video-proxy.test.js and e2e/proxy.e2e.js cover >1 GiB IO, 720p proxy, complete v2 archive, original codec/packet-preserving MP4/MKV export, original audio/subtitles, host/privacy/cancellation and gain continuity. Validation commands and limitations: TESTING.md.

Storage folder: electron-storage.test.js and native/storage launcher checks cover immediate/deferred copy, persistence, large-file memory bounds, actual disk-boundary migration, source retention on failure, destination/junction safety and final original-video export after migration.

Clip mixing: author/host permissions after release/reclaim; atomic bulk across roles; mixed values and absolute assignment; invalid/session/revision/URL conflicts; non-destructive rerecord/delete; effect dry/wet endpoints and user pitch; real gain/pan in preview, playback, stereo stems and final mix; live ramps, muted ducking and pending-processing cancellation; format-3 save/open/restart with legacy 1/2 defaults. Covered by take-mix.test.js, e2e/take-mix.e2e.js and tools/electron-take-mix-smoke.js.

## Media / presence hardening additions

| Requirement family | Implementation / behavioral coverage | Limits |
| --- | --- | --- |
| Scene isolation / identity | sessionScope; nickname ACK and same-client recovery; stale dialog/audio/recording/delta torture in editor-hardening and media-presence-hardening suites | Real WAN varies |
| Durable edit intent / leases | IndexedDB reload recovery, epoch/receipt review, atomic caption/timing/assignment/structural leases; server idempotency tests | IndexedDB-unavailable mode is RAM-only |
| Verified delivery | Manifest/chunk hashing, corruption/resume, partial seeding/ranges, aggregate limits, playback/rarest scheduler and terminal readiness; transfer-utils + browser suites | External public-service CORS is uncontrolled |
| Cursor / navigation | Semantic scoped presence with bounded direct/fallback channels, local visibility and jump; Ctrl/Cmd+F, filters, minimap/footer and pointer capture | No full timeline virtualization |
| Audio / wave performance | Actual sample WSOLA checks, raw/processed byte budgets, interval indexes, workers/fallback, visible cue jobs, dynamic lanes/DPR/playhead | Generated scenes are not episode benchmarks |
| Snapshot / project save | One-use bounded barrier, freeze/force/cancel, shared stream serializer, destination-side verified commit, format-4 retake and old-format defaults | OS picker UX / physical huge archives are manual |
| Desktop routing | Real secondary process; host shared switch and remote guest local import; existing history kept; host-only narrow preload | Automated confirmation is substituted |
| Distribution / updater | One core; explicit marker/manifest; Setup differential and Portable patch/full/locked-file rollback/crash journal; strict managed scope and hashes | Local B is never a public release |
| Associations / coexistence | HKCU ownership, UserChoice unchanged, uninstall preserves foreign/Portable; same-profile Setup/Portable request handoff | Windows default selection remains OS UX |
| Loading / cleanup | EN/RU/UK split/lazy retry, lazy ZIP, text compression, hidden rendering cadence, diagnostics and conservative orphan GC | Optional hardware acceleration/transfer graph deferred |

Durable editor intent now survives reload; the earlier page-memory limitation above
is historical. Run/results distinction and physical/manual limitations are in the
[testing guide](../TESTING.md).

Native snapshot delivery additionally tests real preparing/writing/finalizing/commit
progress, safe cancellation and preservation of an existing destination.
