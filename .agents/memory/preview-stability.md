---
name: Preview stability during pixel edits
description: Preserve visual continuity without allowing stale contour geometry into production output.
---

Treat the last rendered preview bitmap separately from valid contour/export data during pixel edits.

**Why:** Increasing image resolution can require asynchronous contour regeneration. Clearing the displayed bitmap for intermediate processing states causes visible jumps; retaining export geometry instead would risk downloading the old contour with new artwork.

**How to apply:** Preserve the completed visible frame while processing, but invalidate geometry used for export immediately. Metadata-only updates must not restart the same contour request. Size the canvas from a layout box independent of the bitmap's intrinsic dimensions, and match its drawable content box so pointer coordinates remain aligned.