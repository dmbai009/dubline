# Architecture

## Authority and sessions

`server.js` wires Express, Socket.IO, routes, and socket handlers. `server/state.js` owns in-memory rooms and runtime presence. `server/rooms.js` owns session normalization, activation, and persistence. An active session's fields live on the room; `snapshotActive` links them into `room.sessions`. Inactive sessions retain their own lines and media. `SESSION_FIELDS` defines that boundary.

`rooms.json` is internal persistence, written through a temporary file and rename. It includes runtime room administration and must never become the portable project format.

## Client and desktop

`public/index.html` loads plain JavaScript modules in dependency order. `public/state.js` owns client settings; `editor.js` manages session-bound mutation requests and drafts. `studio.js` draws the timeline. Electron's launcher/main process starts the local server and network provider; narrow preload bridges distinguish host and guest capabilities. `server/desktop.js` enforces the desktop host proof and room PIN for media.

## Recording and media

Clients reserve take sequences, capture MediaRecorder audio, and queue pending blobs locally. Server upload authorization, session IDs, and monotonic sequences prevent old uploads from replacing newer takes. Nickname migration updates active/inactive ownership. Pack imports preserve immutable scene media separately from the replaceable library ZIP.

`server/media.js` probes/converts media and extracts embedded tracks. P2P distributes media with host fallback; local media can replace downloads. Source selection and mix normalization are shared by server, browser, and offline renderer through `public/project-audio.js`. Waveform data is a rebuildable cache.

## Export and portable projects

Video and stems render from project audio and current take snapshots. Voxalike export remains a content exchange format.

`server/projects.js` is the explicit portable serialization boundary: ZIP, `project.json`, format identifier, version, an asset table with sizes and SHA-256, and project-only fields. Production disk IO belongs to server/project-archive.js: immutable copies and metadata are captured before asynchronous ZIP generation; yazl/yauzl stream ZIP/ZIP64 with bounded buffers. Import validates headers/schema, CRC, sizes and SHA-256 and stages generated files before publishing a new session. server/project-uploads.js writes authorized multipart files to private disk storage. Fresh session identities prevent requests from the previous scene from mutating an imported project.

Imported session `takeLatency` retains audible take alignment independently of a destination room's current delay map. Playback and offline export use the session correction first; existing room delay behavior remains the fallback. Rename and explicit delay adjustment update imported corrections too. See `docs/project-format.md` for schema details, scope, and limits.

## Runtime modes and shared UI primitives

Single Player is a runtime room flag configured by the Electron server process, outside SESSION_FIELDS and outside the portable manifest. It uses the existing server routes and browser modules. Effective line ownership is the local host; actual role claims and take authors remain project metadata. Remote guests and media requests are refused. Promotion through trusted Electron IPC enables the stored PIN and existing network provider without rebuilding the project. Native project open and HTTP project open share importProjectIntoRoom, including staging, media validation and rollback.

public/timeline-model.js centralizes millisecond bounds, coordinate conversion and relative role movement for browser and server. FFmpeg establishes the authoritative video duration; old persisted cues are fitted to media bounds while preserving captions and recording assets. public/dialogs.js provides askText/askConfirm with native dialog focus handling. Personal controls persist locally; shared controls continue through the existing revision-bound project-audio socket flow.

Workshop import publishes exact archive URL/size/SHA-256 and media expectations. Remote clients validate the direct ZIP and each selected asset, bound download time/size, and otherwise use P2P/HTTP. Scene abort cancels direct download as well. No simultaneous hybrid chunk merger was introduced. See docs/adr/ and docs/project-format.md.

## Solo feedback follow-up

Timeline numbering is derived by public/timeline-model.js and never rewrites line IDs. Hosting selection uses request generations in the renderer and main process; provider detection is shared and cached briefly. Electron allows media/fullscreen for the trusted requesting room origin. The audio picker belongs to the video panel; transport status distinguishes preparing tracks from buffering audio. Server preparation uses a video-bound runtime marker, publishing a boolean for the active video to clients. Waveform canvases use viewport-sized overscan and devicePixelRatio rather than a fixed 1800-pixel limit.

Project download is prepared by POST /api/export-project, then transferred through a short-lived, one-use GET ticket bound to the host cookie. The browser download manager writes directly to disk. Failure/expiry/cancellation/completion releases temporary copies and slots. Direct ZIP POST remains compatible for API callers. Native open passes a file path to the same staged reader.

## Working video and preserved source

server/video-proxy.js prepares oversized custom video imports with FFmpeg, retaining the original in the session as originalVideoUrl/originalVideoName. Only videoUrl and extracted original audio tracks enter playback/P2P. publicRoom omits the original URL; static serving blocks generated source_video filenames, including encoded paths. Compression keeps frame rate/timing, caps H.264 to 720p/300 MiB, validates duration and reports host-bound progress/cancellation.

Projects with an original emit formatVersion 2 with media.originalVideo/originalVideoName; projects without it still emit version 1. Open accepts both, validates original/proxy duration and publishes the source with a protected generated filename. Session snapshots, persistence and deletion include the original.

public/export.js mixes/encodes audio in the existing browser audio graph. For a proxy project the host sends only its encoded soundtrack to server/video-export.js, which streamcopies the frozen original into MP4 or MKV, then issues a cookie-bound one-use disk download. It never falls back to rendering the proxy. Long soundtrack mixing still requires browser RAM.

Auto-duck timing and smooth gain automation are shared in public/project-audio.js: 300 ms anticipatory attack, 150 ms hold, 850 ms recovery. Ordinary room updates retain the scheduled transition; mute remains immediate.


## Desktop storage routing

electron-storage.js stores a version-1 storage.json preference in the unchanged Electron userData profile. Server data/uploads/packs are migrated with disk copies and an atomic preference switch before server startup. Paths within scenes remain relative URLs. Main-frame-only launcher/host IPC selects storage; guest preloads have no such capability. Server environment directories and native cleanup use the selected root. Voxalike temporary export files also use DATA_DIR.

Clip mixing uses public/take-mix.js for shared bounds/defaults and author/host ownership policy. server/sockets/roles.js validates atomic set_takes_props batches against session, audio URL and takeMixRevision. public/audio-fx.js renders the dry/wet effect blend and provides connectTake for a shared gain/stereo-panner path used by public/audio.js and public/export.js. Volume/pan do not invalidate processed audio caches. Version-3 serialization in server/projects.js is explicit; runtime revisions are omitted.
