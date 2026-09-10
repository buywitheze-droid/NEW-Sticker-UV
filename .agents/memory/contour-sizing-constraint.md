---
name: Contour sizing constraint
description: Business reason for keeping inlet closing inside the traced contour's original per-side bounds.
---

Inlet closing must stay within the pre-closing contour's bounds on each side, not merely preserve its overall width and height.

**Why:** The supplied contour-fix specification explains that artwork has already been fitted to the customer's purchased size. Expanding or translating the die line outward spends margin reserved by that fit, even if the change looks visually harmless.

**How to apply:** Preserve the envelope rejection and sub-pixel clamp when modifying inlet closing. Do not replace the per-side guard with a width/height comparison or a later resize, which could change the intended artwork size or alignment.