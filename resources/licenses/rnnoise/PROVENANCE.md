# RNNoise in DubLine

- Wrapper: `@shiguredo/rnnoise-wasm@2025.1.5`, Apache-2.0.
  https://github.com/shiguredo/rnnoise-wasm
- Wrapper source commit: `318dfdecdc2ddf3b33fe01a89ed8273ba0374ddc`.
- RNNoise source: Xiph, BSD-3-Clause, commit
  `70f1d256acd4b34a572f999a05c87bf00b67730d`.
  https://github.com/xiph/rnnoise
- Official default model archive SHA256:
  `0a8755f8e2d834eff6a54714ecc7d75f9932e845df35f8b59bc52a7cfe6e8b37`.
- Published JS/WASM bundle SHA256:
  `e6958293a0118bf9860cb2753332f7562531cc987c914552c426cd7d7180a63e`.
  The bundle is byte-identical to NoiseLab's pinned runtime, including its model.
- Processing adapter/resampling is adapted from NoiseLab (MIT),
  https://github.com/dmbai009/noiselab, commit
  `f0f5feaadf00918cbe362d3b31cb49e07d6b041d`.

Full code notices are retained alongside this file. Ordinary application use
requires no external model/CDN download. Native code uses the package's default
model, not an alternative filter.

The exact published upstream model archive was previously hash-verified in
NoiseLab. It has no separate license text in its generated weights. Applying
the RNNoise repository's BSD license to those particular weights remains an
inference, not a separately confirmed model grant. Unrestricted commercial
redistribution is not asserted; clarification from Xiph/Jean-Marc Valin remains
a release consideration. This does not change DubLine's own project license.
