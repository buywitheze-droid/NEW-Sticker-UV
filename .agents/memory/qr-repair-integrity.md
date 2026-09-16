---
name: QR repair integrity
description: Why QR repairs are explicit source edits with exact-content verification, not export-time styling.
---

QR repairs must preserve decoded content exactly; only a manually identified recovery region may use content explicitly supplied by the user.

**Why:** A QR can look correct while pointing somewhere different. The original repair toggle also changed colored artwork to black and white through inconsistent export renderers.

**How to apply:** Keep repairs opt-in and commit approved pixels through the print-source edit contract, with Undo. Disable legacy export-time QR substitution for repaired artwork. Verify real pixels after relevant resampling, not merely a generated module matrix. Digital verification is not a guarantee for every printer, material, clipping operation, or phone.

Treat scan cancellation, timeout, and an exhausted scan with no results as different outcomes.

**Why:** Automatic server fallback previously made unproductive scans last minutes and obscured whether a code was absent or processing had failed.

**How to apply:** Bound work, isolate concurrent scan jobs, discard stale results, and offer explicit deeper scanning and manual recovery without guessing unreadable content.

Keep the customer-facing QR repair flow simple; technical controls are optional.

**Why:** After receiving the full studio, the user explicitly asked for it to be extremely simple to use. Exposing all engine capabilities at once does not meet that goal.

**How to apply:** Prefer choosing a code, previewing its fix, and applying it. Keep original-color defaults and verification intact; reveal advanced print settings and manual recovery only when needed.

Contrast recommendations are warnings, not substitutes for real QR decoding.

**Why:** The original 4.5:1 hard gate rejected readable brand colors and pressured customers to recolor their QR. That threshold is conservative guidance, not a universal QR requirement.

**How to apply:** Allow chosen colors only when exact payload and output-size pixel verification pass. Warn about low print contrast; never silently recolor. Color edits invalidate earlier checks and should be shown as awaiting a new preview, not already failed.