---
name: Signed shape margins
description: Negative shape margins intentionally crop artwork without rescaling it.
---

Shape margins may be negative so users can cut into their artwork. Changing the margin changes cut geometry, not artwork size or image scale. It resets Custom Cut Size overrides so those overrides cannot silently prevent the slider from working.

**Why:** The user explicitly requested a slider to enlarge or shrink preset shapes, including cutting into the design. This is intentional cropping, unlike accidental contour expansion that spends a purchased-size allowance.

**How to apply:** Keep the signed numeric entry and slider consistent, limit shrinking before the cut dimensions reach zero, and use the same geometry for proof and export. Explain that margin changes reset custom cut dimensions.
