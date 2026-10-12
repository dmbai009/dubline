const MAX_COMMENT = 1000;
function normalize(line) {
  const active = !!line.audioUrl && line.needsRetake === true;
  const comment = active && typeof line.retakeComment === 'string' ? line.retakeComment.slice(0, MAX_COMMENT) : '';
  const revision = Number.isSafeInteger(line.retakeRevision) && line.retakeRevision >= 0 ? line.retakeRevision : 0;
  const changed = line.needsRetake !== active || line.retakeComment !== comment || line.retakeRevision !== revision;
  Object.assign(line, { needsRetake: active, retakeComment: comment, retakeRevision: revision });
  return changed;
}
function clear(line) {
  line.needsRetake = false; line.retakeComment = '';
  line.retakeRevision = Math.min(Number.MAX_SAFE_INTEGER, (line.retakeRevision || 0) + 1);
}
module.exports = { MAX_COMMENT, normalize, clear };
