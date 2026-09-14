---
name: Preview stability during pixel edits
description: Preserve visual continuity without allowing stale contour geometry into production output.
---

Treat the last rendered preview bitmap separately from valid contour/export data during pixel edits.

**Why:** Increasing image resolution can require asynchronous contour regeneration. Clearing the displayed bitmap for intermediate processing states causes visible jumps; retaining export geometry instead would risk downloading the old contour with new artwork.

**How to apply:** Preserve the completed visible frame while processing, but invalidate geometry used for export immediately. Metadata-only updates must not restart the same contour request. Size the canvas from a layout box independent of the bitmap's intrinsic dimensions, and match its drawable content box so pointer coordinates remain aligned.

Do not infer an enhancement from unchanged `File` identity, or finish its busy state merely when pixel generation completes.

**Why:** Print-resolution edits create a replacement file as well as a replacement image. A same-file guard silently fails on these edits; tests that start observing after processing finishes miss the intermediate plain-image/contour transitions.

**How to apply:** Track enhancement explicitly through the final rendered preview, including debounced contour adjustments. Test the entire busy-to-ready transition and worker requests, not only the settled image. Keep lightweight display work separate from export-quality caches.