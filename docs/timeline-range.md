# Private time selection and fragment export

Dub Mode only: drag empty role space, ruler or the empty timeline below the roles to
select time in either direction. The range is distinct from cue/multi-selection.
The ruler and tracks show its boundaries in theme colors; the compact toolbar shows
start, end, duration, Export range and Clear range. A single empty-space click seeks
and clears it; double-click selects the actual whole video, excluding the visual
tail. Escape clears the range after closing an open timeline search.

Space and the main Play button start at the range boundary when the playhead is
outside it, resume inside it, and pause at its end. Playing again after completion
starts at the left edge. Recording and individual take previews keep their existing
paths. Watch Together keeps its host authority; range selection is personal, while
ordinary host transport commands still use the existing synchronization protocol.

The stable timeline scroller owns pointer capture, including when shared updates
replace rows. Edge dragging scrolls horizontally. Blur/cancel restores the previous
range. Width/zoom changes repaint the same times. Scene/video and mode changes clear
it. There is no storage, room mutation, project field or portable format change.
Edit Mode retains its existing scrub, double-click creation and cue gestures.

## Export

Files → Export includes Entire video / Selected range. Selecting a range defaults
to the latter; the explicit Entire video choice retains the ordinary export. The
chosen range is copied into the export snapshot before asynchronous rendering, so
later personal selection changes cannot alter an active job.

For a partial range, video must be re-encoded to avoid GOP/keyframe snapping.
Working-version and Original-source modes preserve source dimensions and use a
source-aware bitrate; Custom retains its selected bounds/format/FPS. A non-WebM
original produces H.264/MP4 for a fragment, including MKV originals. The UI explains
the re-encoding; full-video Original and Working exports still copy their video
packets. Boundaries follow source video frame precision; audio is cropped on the
48 kHz sample grid and output timestamps start at zero.

The browser WebCodecs path decodes only the selected interval (with required
keyframe pre-roll). Host-original export passes validated range/encoding options
through the existing authorized server export, FFmpeg and private download ticket.
Existing acceleration/fallback, cancellation, leases, hidden-take rules and streamed
native file commit remain in use. A runtime without the needed video/audio encoder
shows an explicit unsupported message for partial export; its existing full-video
real-time fallback remains available.

The windowed audio mixer retains absolute scene source offsets, effects, take
latency, pan, duck curves and limiter warm-up, then slices the selected sample
interval. It uses the same eight-second window grid as a full export. Progress and
size estimates use fragment duration. Take preparation remains bounded and may
prepare takes outside the range to retain their effect-tail/ducking context.

## Checks

`e2e/timeline-range.e2e.js` exercises real pointer gestures, Space/end/replay,
double-click, cancellation, fractional zoom, role widths, participant isolation,
Edit Mode creation, audio crop equality, guest WebCodecs output and host FFmpeg
output. Files are demuxed and decoded to check their duration/zero origin.
`test/video-export-range.test.js` checks numeric bounds and estimation.
`npm run test:electron:video-export` includes the native streamed fragment save.
Actual completed validation is recorded in the task report; commands listed here
are coverage entry points, not claims about an unrun CI or build.

Local validation (2026-10-16): syntax check and 453 unit/server tests passed.
The initial export/progress/reliability/role-width/1.4 workflow profile passed
59/59; after extending coverage, the final range plus studio UX profile passed
19/19 (12 range cases). Native streamed video export, including a fragment, and
native recording/RNNoise/project workflow passed. Playwright captured 18 screenshots
across Graphite, Light and Ocean at 1920/100%, 1280/125% and 960/150%, verified
range geometry and confirmed the new toolbar does not increase the workspace's
existing minimum width. Very narrow windows at enlarged UI scale retain the
existing horizontally scrollable workspace. These are local source checks;
packaging and remote CI are separate validation steps.

The range clock and its export/clear actions are in the existing footer immediately before zoom controls, without an extra timeline row. Narrow layouts use labelled icon actions.
