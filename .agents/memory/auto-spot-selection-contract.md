---
name: Auto spot selection contract
description: Why automatic spot generation preserves existing selection and print conventions.
---

Auto Spot Layers changes how existing spot selections are made, not the currently configured spot names or ink format. Dedicated naming controls may edit those names.

**Why:** The user explicitly limited automatic selection to selection changes, then separately requested restored White/Varnish name editing and custom CutContour names throughout the app. Preserving names in Auto mode does not mean locking the naming controls. Variable ink strength and printer-specific layering remain outside that approval.

**How to apply:** Generate binary selections over the existing editable color/region domains. Show the final selected areas before Apply and preserve manual refinement. Describe tonal relief as brightness-guided, not inferred 3D depth.

Keep White and Gloss membership separate when tracing regions of the same RGB color.

**Why:** Combining their selected pixels into one RGB raster loses channel identity. Different regions with the same color can then appear in both separations, even though their previews differ.

**How to apply:** Preserve channel identity through internal tracing while retaining external spot names and worker/offload compatibility. Test mixed-channel regions of the same color, including a solid white underbase with partial gloss.