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

Match the studio to the active editor's visual style, not the generic theme defaults.

**Why:** The user found the separate dark studio unfamiliar. The active editor's appearance differs from the base shared-component theme, so inheriting those defaults alone does not achieve consistency.

**How to apply:** Compare with the visible editor before styling studio panels and portaled controls. Keep technical inputs collapsed and make it clear that a successfully decoded original does not automatically need rebuilding.

Contrast recommendations are warnings, not substitutes for real QR decoding.

**Why:** The original 4.5:1 hard gate rejected readable brand colors and pressured customers to recolor their QR. That threshold is conservative guidance, not a universal QR requirement.

**How to apply:** Allow chosen colors only when exact payload and output-size pixel verification pass. Warn about low print contrast; never silently recolor. Color edits invalidate earlier checks and should be shown as awaiting a new preview, not already failed.

Protect customer-selected logo artwork wherever it appears, without automatically moving, shrinking, recoloring, or removing it.

**Why:** Customers use center and corner branding. A readable replacement is not a successful repair if it loses that branding. Finder overlap alone does not prove an unchanged protected region is unreadable.

**How to apply:** Preserve the selected pixels, including alpha, through the final source commit, not only the preview. Warn about corner overlap and rely on exact-content/output verification. Test saved logo appearance as well as QR decoding.

Popular-logo recognition may stage a clean replacement, but never save one automatically or override a customer's logo choice.

**Why:** The user approved automatic replacement in the preview, with explicit Apply and an unchanged-original fallback for uncertain brands. A QR destination or brand-colored patch alone is not evidence of its logo.

**How to apply:** Require strong visual evidence against curated assets; describe supported variants honestly. Preserve manual choices across delayed recognition, offer Restore original, and verify actual QR output before applying. General auto-preview for all edits was separately declined.

Explicit Keep-logo detection locates artwork; it does not choose a replacement.

**Why:** The user approved finding the area automatically when enabling protection while retaining its original pixels. This is distinct from the previously approved automatic clean-replacement suggestion.

**How to apply:** Respect an existing selection, use strong visual matches only for a missing area, retain manual fallback, and do not automatically preview or apply a repair from this action.

Compare preserved logo ink with the original ink, not the outer badge rectangle.

**Why:** Curated glyphs have white padding; assuming their colored pixels fill the entire badge causes false preservation failures, especially with non-square artwork dimensions.

**How to apply:** In exported-image tests, measure the original colored pixel bounds and compare them with the repaired output. For cancellation tests, hold a real recognition response rather than relying on seeing a brief loading state.