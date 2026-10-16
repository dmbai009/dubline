# Personal role column width

The timeline role column defaults to its existing 180 CSS pixels. Drag the right
edge of any role label or the ruler corner to resize all labels together. The
upper limit is 400 CSS pixels and at most 55% of the actually visible timeline
width. Narrow windows and UI zoom clamp the displayed width without overwriting
the preferred width; widening the window restores it. Double-click the edge to
reset. A focused edge also accepts Left/Right, Home and End.

`dubline_role_column_width` is a device/browser preference in localStorage. It is
not part of room events, scene persistence or portable project manifests. Missing,
invalid or unavailable storage retains a working default.

The existing `labelWidth` geometry and one CSS variable move the ruler, role/audio
labels, cue origins and playhead together. A drag updates geometry without
rebuilding cue elements, changing pixels per second or seeking. It exits automatic
whole-scene fitting when the user changes the width, preserving the current scale.
Minimap viewport and audio/collaborator overlays refresh from the same width.
Pointer capture belongs to the stable scroller so a role redraw does not lose the
gesture. Cancel/lost capture/blur restore the previous preference.

Validation: `node --test e2e/timeline-role-column.e2e.js` checks actual mouse drags,
both modes, shared alignment, unchanged cue DOM/data/time/zoom/selection, bounds,
cancel, reload, participant isolation, 100/125/150% zoom, narrow-to-wide restoration,
ordinary ruler seeking and reset. Playwright visual QA captured 18 states across
Dub/Edit, 1920/1280/960px, those zoom levels and Graphite/Light/Ocean themes under
`audit/role-column-visual/` (local artifacts, not distributed).

A separate regression starts with Whole scene at a wide column, narrows the
column and then redraws the timeline as a room update would. Its unchanged scale
remains a valid zoom floor until an explicit zoom, viewport change or scene switch.
