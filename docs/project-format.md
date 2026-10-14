# Dubline Project formats 1–10

An archive uses the `.dubline` extension and a standard ZIP container. `project.json` is UTF-8 JSON with `format: "dubline-project"`, required `formatVersion` from 1 through 10, `project`, and `assets`. The serializer is `server/projects.js`; it never exports raw room persistence.

## Manifest

`project` contains title, scene kind, editor mode, ordered role names, nickname-based role claims, lines, media selection, shared mix, external source metadata, and take alignment corrections. Each line retains its numeric ID, role, caption, start/end, individual claim, optional reference asset, and one current take. A take carries its asset reference, author, audio/recorded start, trim bounds/enabled flag, pitch, and effect.

Media references point to assets in `media/` or `recordings/`. Video is required; external Original, Background / M&E, the base background source, reference voices, and embedded track files are included when referenced. A source used in several places is included once. Embedded track selection/labels and the known/unknown video audio state survive. Unknown audio state is reprobed using the existing media pipeline on open.

Each asset declares its archive path, byte size, and SHA-256. All referenced assets must exist and every declared asset must be referenced. Hashes establish internal consistency, not the identity or trustworthiness of a project author.

`takeLatency` stores author-to-milliseconds corrections used by the existing recordings. On import it belongs to the new session, so another room's current microphone correction does not shift imported takes. The existing delay adjustment tool can update that session correction; nickname migration carries it along. Device selections, microphone processing preferences, local monitoring, and ADR preferences are not portable project state.

## Save/open

Saving captures metadata and immutable disk copies synchronously before asynchronous ZIP generation. Files are hashed/read in bounded chunks; production IO uses server/project-archive.js (yazl/yauzl). Collaborative edits, source switches, take deletion, and take replacement during generation cannot produce mixed revisions. Missing media fails save explicitly.

Opening validates ZIP entry paths/count/sizes/types, the format/version, bounded schema, references, CRC and SHA-256 before staging files. FFmpeg then checks the staged video and audio can be read. The server rechecks session identity and host rights before committing generated paths and starting a fresh session. Failed validation removes staging and leaves existing sessions untouched. Imported recordings get fresh session/sequence identities; old queued requests cannot target them.

Runtime credentials, PIN/passwords, host/client IDs, online players, sockets, chat, P2P progress, waveform caches, editor Undo/trash history, and pending browser upload queues are excluded. Each archive contains the active scene; other room sessions can be saved separately. Save uses a bounded participant-readiness barrier and freezes mutations during capture. Pending editor/take queues and unsaved inspector drafts are considered. Retry/Cancel preserve drafts; explicit Force snapshots current server state and reports unavailable/pending participants. Device-only recordings are never invented as server state.

## Current limits and compatibility

- No fixed aggregate compressed/expanded .dubline size limit. Working video is limited to 300 MB, independently of other media/recordings; the embedded original in version 2 is exempt. The UI explains this before import/open/save. ZIP64 is generated automatically when needed and accepted by the disk reader.
- Manifest: 4 MB; at most 2,000 lines/roles and 10,000 archive entries; captions retain the existing 2,000-character limit.
- Imported media uses generated filenames, preserving Unicode in JSON rather than trusting original archive filenames. Absolute, traversal, backslash, encoded/drive paths, duplicate entries, symlinks, and executable files are rejected.
- Save/open currently requires host rights and an exact session binding. Existing desktop PIN/media gates and guest restrictions are unchanged.
- Save/open/download use bounded streams and temporary disk files. Saving needs free disk space for immutable copies and ZIP; synchronous snapshot/hash may briefly pause the server on slow storage. Browser downloads and native file open avoid whole-archive buffers. Completion/failure/disconnection cleans temporary data; an OS/process crash can leave temporary files.
- Projects without an original emit version 1. Projects with a proxy/source pair emit version 2 and require media.originalVideo (MP4/MKV/WebM asset reference) plus originalVideoName. Version-1 manifests cannot add those fields silently. Both readers validate all assets; prior app versions reject version 2 explicitly.

Single Player and Multiplayer share this format. Launcher open uses the same transaction as working Files UI open. The archive mode does not force the runtime mode. FFmpeg confirms the actual staged video duration; out-of-media source timings are rejected before publishing a session. Cross-mode browser and native Electron workflows are covered in e2e/workflow14.e2e.js and tools/electron-project-smoke.js.

Validation commands and large-project coverage are documented in [the testing guide](../TESTING.md).

The original is staged/probed as video and must match the working duration within 250 ms (container/audio padding tolerance). It receives a generated source_video filename that static HTTP refuses; the session stores its URL internally, and publicRoom exposes only presence, name and size. Both copies participate in immutable archive snapshots and session cleanup. No relinking is needed for a complete archive.

## Clip mix in version 3

When any clip has non-default volume, pan or effectAmount, the writer emits format 3. Each take then requires finite numeric volume (0–3), pan (−1–1) and effectAmount (0–1). Defaults are 1, 0, 1. Fields describe non-destructive gain, stereo pan and dry/wet preset blend; user pitch stays separate. Original/proxy media can be present using the version-2 source rules, but a source original is optional in version 3. Runtime takeMixRevision is excluded and starts fresh on import. Format-1/2 manifests import missing mix fields as defaults; non-default clip mixes may not masquerade as those older versions. Default mixes still emit format 1 (no original) or 2 (original embedded). Older apps explicitly reject format 3.

## Retake marker in version 4

When a recorded line has Needs Retake, the writer emits format 4 and includes its boolean needsRetake flag. The flag requires a recorded take. Format 4 retains format-3 clip fields and optional original/proxy assets. Formats 1/2/3 import missing markers as false; they cannot silently contain a true marker. Archives without retake markers keep the lowest applicable version 1/2/3. Older readers explicitly reject format 4. Runtime locks, cursors, readiness, pending operations and update state remain excluded.

## Retake comments and Telephone in version 5

When a line contains a retake comment or selects the Telephone effect, the writer emits version 5. A line's optional `retakeComment` is a string of at most 1000 UTF-16 code units, requires `needsRetake: true` and an existing recorded asset, and is displayed as text. Requests without comments still use version 4. The additional effect identifier is `telephone`. Formats 1–4 remain readable without loss of media, claims or clip settings; older readers reject version 5 explicitly.

Runtime `retakeRevision`, receipts, notification acknowledgements, personal filters and local comment drafts are excluded. Imported requests start at revision zero inside the new session identity. The next successfully stored take closes the request and clears its comment atomically. Playback/export apply the same bounded speech-window level correction to processed effects relative to their own dry source; `none` remains unchanged. Original take bytes are never rewritten. Existing projects may therefore sound different when using an effect, particularly Radio; subjective listening remains a release check.

## Bounded take history in version 6

Scenes with previous takes or a pinned main take use version 6. Each line retains its single `take` plus a `takeHistory` array of zero to three variants, newest deactivation first. Both main and historical variants contain a stable `id`, boolean `pinned`, optional numeric `createdAt`/`duration` (null when unknown), the declared audio `asset`, author, alignment/trim and all version-3 processing/mix settings. Historical variants also have nullable `archivedAt`. A line without main audio uses `asset: null`, `id: null`, `pinned: false`; its history remains valid. Duplicate variant IDs, duplicate assets within a line, missing/unsafe references, invalid settings and over-limit arrays are rejected before extraction. Uploads retain the 20 MB per-take limit; portable archives preserve their existing streaming size rules, including legacy shared media assets. Historical authors participate in the exported take-latency map.

All historical audio participates in the same immutable disk snapshot, hash/size validation, bounded archive streaming and import rollback as the main take. No Blob/base64, upload IDs, reservation counters or history revisions enter the portable format. Formats 1–5 still open with empty history and unpinned main takes; scenes without history/pins continue to emit the lowest applicable version. Older readers reject version 6 explicitly.

Runtime replacement archives the current take, evicting only the oldest unpinned historical variant when necessary. Three pinned variants require exact-main/revision consent to discard an unpinned main; four pinned variants block replacement. Restoring moves assets between slots, preserves per-version settings/pins and closes the old active retake request. Deleting main audio retains history. Timeline playback and final audio/video/Voxalike exports still use only main audio.

Room state is written atomically and flushed before unused owned `line_*` files are unlinked. Live/persisted room and trash references plus active download/export readers protect shared files. Failed writes roll back metadata; disk cleanup errors retain files and are reported. Conservative orphan collection retains its existing grace period. Inspector-only controls use scene-bound revisions and existing operation receipts; restore/delete-main invalidate unaccepted reservations, with conflicting local recordings kept in the existing queue for explicit retry.

## Legacy microphone profiles in versions 7/8 (read only)

Legacy profiles retain their bounded algorithm-1/1024/513-bin validation, author matching and take-reference checks before extraction. After validation, import discards the spectral profiles and noiseProfileId from current and historical takes. Original bytes, author, identity, history, pins, timing, trim and voice settings remain intact. Legacy author entries migrate to disabled RNNoise at 60%; no old acoustic profile is interpreted as a neural model. Existing on-disk rooms, inactive sessions and trash use the same idempotent migration. Current writers never emit profiles or bindings.

## Voice effect chains in version 8

Scenes with role definitions or explicitly edited individual chains emit version 8. `project.roleEffects` maps existing role names to `{ pitch, effects }`, without runtime revisions. Each ordered effect has a unique per-chain instance `id`, a supported `type`, boolean `enabled`, finite `amount` in 0–1 and validated `parameters`. Echo accepts delay 0.03–0.8 seconds and feedback 0–0.7; other effects currently use empty parameters. Role definitions are stored once, not copied into lines.

Each active and historical take stores `effects`, `pitchMode` (`inherit`/`override`), `inheritRoleEffects` and `excludedRoleEffectIds`. The existing pitch field retains the explicit value. Role and take pitch do not sum. Exclusions reference role instances; stale exclusions are inert. Maximum eight entries per level, eight active combined stages, four heavy stages and 12 seconds of combined tails are validated against every active/historical take. Disabled stages and duplicate types with distinct IDs are preserved.

All version-6/7 history, noise, trim, identity, pin and audio-asset rules still apply. Format 8 may omit noise state when no profiles exist. Formats 1–7 remain readable: a legacy effect becomes one effective stage with its existing amount, and existing pitch remains explicit. The legacy single-stage renderer preserves Monster and old effects' sound. New chain fields and Echo cannot be written into a legacy version. Original media/recordings are never rewritten during migration or export. See [voice-effects.md](voice-effects.md).

## RNNoise author settings in version 9

Scenes with any RNNoise author entry emit format 9, retaining all version-8 role, individual and historical chain fields. project.noiseReduction contains schemaVersion 2, engine rnnoise, engineVersion 2025.1.5, the pinned modelVersion, dspVersion 1 and actors. Each nickname maps to exactly enabled (boolean) and strength (finite 0–1). Runtime revision is excluded and starts at zero on import. Unknown metadata, profile fields, take noiseProfileId, invalid or oversized author dictionaries fail validation before extraction. No model or derived Wet PCM is stored inside the project; the application supplies the pinned bundled model.

Settings resolve by each take's recordedBy, independently of current role owners. Export snapshots contain one immutable confirmed author-state snapshot. Local previews/drafts are excluded. Projects without RNNoise author entries continue to emit the lowest applicable format; formats 1–8 are still accepted.


## Scene voice presets in version 10

Format 10 requires a scene-local `voicePresets` catalogue, alongside the validated RNNoise and chain/history fields from format 9. Each entry contains id, name (1–80 characters), ordered effects, optional pitch (−12…+12), createdBy and a positive safe-integer revision. The catalogue is limited to 50 entries. Presets never contain media, timing, mix, RNNoise state or another scene catalogue. Applying a preset copies settings into the ordinary role/take schema with new effect IDs; no persistent preset reference is stored in a take. Later catalogue changes do not alter applied takes.

Formats 1–9 import an empty catalogue and reject a hidden voicePresets field. Format 10 is emitted only for a nonempty catalogue; otherwise the writer retains the lowest existing applicable format. Entry revisions preserve catalogue version history; editor-operation receipts remain runtime-only.
