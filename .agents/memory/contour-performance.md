---
name: Print-resolution contour performance
description: Preserve exact offsets without radius-squared work at print resolution.
---

Evaluate tracing performance at full export resolution and normal margin widths, not only on small preview masks.

**Why:** The Hootz artwork exposed a stall at circular dilation: supersampling turns a modest margin into a large-radius disk, and stamping that disk at every filled pixel requires hundreds of billions of repeated writes. Switching the final proof to export geometry exposed this cost in the editor.

**How to apply:** Use exact distance-based dilation rather than per-pixel disk stamping. Keep a large, dense-mask performance regression alongside pixel-for-pixel reference checks; do not hide the problem by shrinking customer dimensions or lowering final proof resolution. Local fixes do not update the separately deployed offload service.

Treat Emboss Studio as an optimization reference, not a drop-in definition of a sticker cut.

**Why:** Its fast trace-once/vector-offset approach is useful, but its outer-only tracing discards interior holes and can leave disconnected artwork as separate cuts. Those semantics differ from our hole support, protected peer components, and bridge/inlet safety rules. Replacing those rules for speed risks restoring the missing-artwork bug.

**How to apply:** Reuse protected artwork geometry across margin edits without bypassing component selection or safety cleanup. Keep Zero Hero's exact edge/Bezier behavior separate. Compare warm-cache results against fresh results across margins, styles, holes, and edited pixels, and report first-trace versus repeat-edit timings separately.

Preserve polygon precision when optimizing Clipper: prefer integer-origin translation over reducing the coordinate scale.

**Why:** Reducing quantization precision appeared harmless in isolation but changed downstream smoothing decisions on Hootz, shifting some boundaries by nearly one source pixel. Centering coordinates instead retained the original boundary to floating-point precision while allowing small enough shapes to use Clipper's faster arithmetic.

**How to apply:** Compare completed cut geometry, not merely intermediate offset error. Keep large-coordinate/full-range support for shapes that cannot fit the fast range; do not sacrifice accuracy to force it.
