// Pointer capture keeps a scrub continuous beyond the empty row/ruler bounds.
(() => {
  let active = null;
  window.bindTimelineScrub = (area, emptyTarget = () => true) => {
    area.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !emptyTarget(event) || !studioCanTransport() || active) return;
      event.preventDefault(); area.setPointerCapture(event.pointerId);
      window.transportScrubbing = true;
      const sessionId = session.activeSessionId, origin = event.clientX, box = area.getBoundingClientRect();
      let pending = event.clientX, frame = null, moved = false, done = false;
      const paint = final => {
        frame = null;
        if (session?.activeSessionId !== sessionId || !studioCanTransport()) return;
        video.currentTime = Math.max(0, Math.min(editorVideoDuration(), DublineTimeline.coordinate(pending, box.left, pxPerSec)));
        window.sendHostSync?.(!final);
      };
      const move = next => { pending = next.clientX; moved ||= Math.abs(pending - origin) > 4; if (frame === null) frame = requestAnimationFrame(() => paint(false)); };
      const finish = endEvent => {
        if (done) return; done = true;
        if (frame !== null) cancelAnimationFrame(frame);
        window.transportScrubbing = false;
        if (endEvent.type === 'pointerup') { pending = endEvent.clientX; paint(true); }
        else if (session?.activeSessionId === sessionId) window.sendHostSync?.(false);
        area.removeEventListener('pointermove', move); area.removeEventListener('pointerup', finish); area.removeEventListener('pointercancel', finish); area.removeEventListener('lostpointercapture', finish); window.removeEventListener('blur', finish);
        if (area.hasPointerCapture(event.pointerId)) area.releasePointerCapture(event.pointerId);
        if (moved) { area.dataset.scrubDragged = String(performance.now()); }
        active = null;
      };
      active = { finish, sessionId }; paint(false);
      area.addEventListener('pointermove', move); area.addEventListener('pointerup', finish); area.addEventListener('pointercancel', finish); area.addEventListener('lostpointercapture', finish); window.addEventListener('blur', finish);
    });
    area.addEventListener('click', event => { if (performance.now() - Number(area.dataset.scrubDragged || -1000) < 500) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
    area.addEventListener('dblclick', event => { if (performance.now() - Number(area.dataset.scrubDragged || -1000) < 500) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  };
  socket.on('session_updated', () => { if (active && active.sessionId !== session?.activeSessionId) active.finish({ type: 'scene' }); });
})();
