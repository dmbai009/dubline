(function(root) {
  const chain = typeof module !== 'undefined' && module.exports ? require('./voice-chain-model') : root.DublineVoiceChain;
  function inspect(scene, { allow = () => true, availability = {}, quality = {}, processing = {}, pending = 0, sources = [] } = {}) {
    const lines = scene?.lines || [], recorded = lines.filter(line => line.audioUrl).length, retakes = lines.filter(line => line.audioUrl && line.needsRetake).length, issues = [];
    const add = (key, severity, lineId, params = {}) => issues.push({ key, severity, ...(lineId == null ? {} : { lineId }), params });
    if (!scene?.loaded || !scene.videoUrl) add('review.noVideo', 'error');
    if (pending) add('review.pending', 'error', null, { n: pending });
    if (recorded < lines.length) add('review.unrecorded', 'warning', null, { n: lines.length - recorded });
    for (const line of lines) {
      if (!line.audioUrl || !allow(line)) continue;
      if (line.needsRetake) add('review.retake', 'warning', line.id);
      if (!chain.references(line, scene) || !chain.references(chain.role(scene, line.character), scene)) add('review.presetMissing', 'error', line.id);
      else if (!chain.safe(chain.resolve(line, scene))) add('review.chain', 'error', line.id);
      if (availability[line.audioUrl] === 'missing') add('review.missingTake', 'error', line.id);
      if (availability[line.audioUrl] === 'temporary') add('review.retryTake', 'warning', line.id);
      if (processing[line.id] || processing[line.audioUrl]) add('review.processing', 'error', line.id);
      for (const key of quality[line.audioUrl]?.warnings || []) add('quality.' + key, 'warning', line.id);
    }
    for (const source of sources) if (source.key) add(source.key, source.severity || 'error', null, { resource: source.resource });
    return { total: lines.length, recorded, unrecorded: lines.length - recorded, retakes, issues, errors: issues.filter(issue => issue.severity === 'error'), warnings: issues.filter(issue => issue.severity === 'warning') };
  }
  const api = { inspect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DublineSceneReviewModel = api;
})(typeof window === 'undefined' ? globalThis : window);
