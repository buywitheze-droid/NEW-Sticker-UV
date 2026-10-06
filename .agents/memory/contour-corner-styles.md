---
name: Contour corner styles
description: Scope of corner smoothing and local/offload compatibility for sticker proofs.
---

Corner style is independent of margin: Sharp skips extra smoothing; Balanced preserves significant turns while smoothing gradual sections; Rounded adds smoothing. New designs default to Balanced. Do not silently rewrite saved selections.

**Why:** The user found the scattered-design smoothing overly rounded and requested explicit control without changing the border size. Circular offset geometry and narrow-notch safety are separate from cosmetic smoothing; Sharp does not imply unlimited needle-like corners or a mitered offset.

**How to apply:** Keep proof, export and saved settings consistent. Explicit styles must stay on the local tracing core until the separately deployed offload service advertises compatible behavior. Never silently send a style to an older service that ignores it. Zero-margin tracing and detected geometric primitives bypass this post-offset smoothing stage.
