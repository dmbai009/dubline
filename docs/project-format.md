# Dubline Project formats 1 and 2

An archive uses the `.dubline` extension and a standard ZIP container. `project.json` is UTF-8 JSON with `format: "dubline-project"`, required `formatVersion: 1` or `2`, `project`, and `assets`. The serializer is `server/projects.js`; it never exports raw room persistence.

## Manifest

`project` contains title, scene kind, editor mode, ordered role names, nickname-based role claims, lines, media selection, shared mix, external source metadata, and take alignment corrections. Each line retains its numeric ID, role, caption, start/end, individual claim, optional reference asset, and one current take. A take carries its asset reference, author, audio/recorded start, trim bounds/enabled flag, pitch, and effect.

Media references point to assets in `media/` or `recordings/`. Video is required; external Original, Background / M&E, the base background source, reference voices, and embedded track files are included when referenced. A source used in several places is included once. Embedded track selection/labels and the known/unknown video audio state survive. Unknown audio state is reprobed using the existing media pipeline on open.

Each asset declares its archive path, byte size, and SHA-256. All referenced assets must exist and every declared asset must be referenced. Hashes establish internal consistency, not the identity or trustworthiness of a project author.

`takeLatency` stores author-to-milliseconds corrections used by the existing recordings. On import it belongs to the new session, so another room's current microphone correction does not shift imported takes. The existing delay adjustment tool can update that session correction; nickname migration carries it along. Device selections, microphone processing preferences, local monitoring, and ADR preferences are not portable project state.

## Save/open

Saving captures metadata and immutable disk copies synchronously before asynchronous ZIP generation. Files are hashed/read in bounded chunks; production IO uses server/project-archive.js (yazl/yauzl). Collaborative edits, source switches, take deletion, and take replacement during generation cannot produce mixed revisions. Missing media fails save explicitly.

Opening validates ZIP entry paths/count/sizes/types, the format/version, bounded schema, references, CRC and SHA-256 before staging files. FFmpeg then checks the staged video and audio can be read. The server rechecks session identity and host rights before committing generated paths and starting a fresh session. Failed validation removes staging and leaves existing sessions untouched. Imported recordings get fresh session/sequence identities; old queued requests cannot target them.

Runtime credentials, PIN/passwords, host/client IDs, online players, sockets, chat, P2P progress, waveform caches, editor Undo/trash history, and pending browser upload queues are excluded. Each archive contains the active scene; other room sessions can be saved separately. Save waits for the requesting user's queued takes to finish uploading; recordings still pending on another participant's device are not part of server state.

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
