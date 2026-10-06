---
name: Print-resolution contour performance
description: Preserve exact offsets without radius-squared work at print resolution.
---

Evaluate tracing performance at full export resolution and normal margin widths, not only on small preview masks.

**Why:** The Hootz artwork exposed a stall at circular dilation: supersampling turns a modest margin into a large-radius disk, and stamping that disk at every filled pixel requires hundreds of billions of repeated writes. Switching the final proof to export geometry exposed this cost in the editor.

**How to apply:** Use exact distance-based dilation rather than per-pixel disk stamping. Keep a large, dense-mask performance regression alongside pixel-for-pixel reference checks; do not hide the problem by shrinking customer dimensions or lowering final proof resolution. Local fixes do not update the separately deployed offload service.
