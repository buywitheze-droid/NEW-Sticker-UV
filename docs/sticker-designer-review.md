# Sticker designer: shape, proof, and ordering review

## Implementation verification

86 automated tests and the production build passed. Real-browser checks passed for all six shape presets, standard/single-artboard downloads, custom oval/rounded sizes and artwork placement, gang-sheet and individual-item exports. Local contour worker/cache parity tests passed. Imported-PDF, locked-path, and live offload output are not certified by these checks. Recommendations below remain proposals.

## Scope and evidence

This is a **code-grounded product/production review**, not a claim that an ordering
system or the proposed fixes have shipped. It describes the current client paths
visible in this repository; it is not a live-print validation. Geometry work may
be happening separately. Keep its verified results in the final implementation
summary rather than treating the recommendations below as completed work.

Primary paths inspected: `client/src/pages/sticker-maker.tsx`,
`client/src/builders/spot-uv/{image-editor,controls-section,preview-section,gang-sheet-panel}.tsx`,
`client/src/builders/spot-uv/lib/{shape-outline,contour-outline,contour-worker-manager,pdf-parser,gang-sheet}.ts`,
`client/src/lib/{design-document,gang-sheet-document}.ts`, and the offload entry
points. The page mounts `ImageEditor` in `gangsheet` mode with spot colors enabled.
No competitor feature or production pricing assumption is needed for this review.

## What a customer can do today

1. Upload raster artwork, or a PDF/SVG that is rendered for editing. The PDF
   importer can detect an existing named cut path; SVG and PDFs without such a
   path follow the ordinary generated-cut workflow.
2. Set width/height in **inches** (with aspect lock and size presets), edit
   artwork, select Contour or Shape, choose fills/spot layers, inspect a canvas
   preview, and download a single-design PDF. The editor can save a design for
   an authenticated user (`serializeDesign`).
3. Add a snapshot of the current design to an in-memory gang sheet. Each item
   starts at quantity 1; Fill Sheet increases copies of the **last** item.
   The panel offers quantity controls, sheet presets, individual-item PDFs,
   gang-sheet PDF, single-artboard download, and authenticated Save & Download.
4. These are design/prepress and downloadable-asset actions. The inspected
   sticker page/panel does **not** present a material SKU, die-cut versus
   kiss-cut purchase selection, price, shipping, cart, payment, or submitted
   order. A PDF download or saved gang sheet is not an order confirmation.

### Shape means cut geometry, not the artwork silhouette

- **Contour:** `strokeSettings.enabled` drives an image/alpha-derived trace
  through `processContourInWorker`. Shape detection and settings influence
  tracing; the cached result contains cut paths, dimensions, offsets and
  preview paths. The single-design PDF emits a vector spot-color cut path via
  `downloadContourPDF`. Reprocessing before export/add-to-sheet is intended to
  avoid using a debounced, stale preview cache. Exact silhouette quality still
  depends on alpha, background removal, source resolution, and trace behavior.
- **Shape:** `shapeSettings.enabled` is mutually exclusive with generated
  contour in the controls. It constructs a circle, oval, square, rectangle or
  rounded counterpart around/over artwork. `calculateShapeDimensions` uses
  artwork size and shape offset; optional width/height overrides, radius,
  rotation, image scale/offset, fill and bleed affect presentation. The shape
  PDF uses a generated vector cut path (`downloadShapePDF`). Choosing Circle
  does not mean the image itself has become circular; it chooses a cut
  boundary and clips/fills the print image within that design.
- **Imported cut PDF:** `handlePDFUpload` keeps page coordinates untrimmed when
  a cut path is detected. Controls show its detected label and suppress the
  ordinary generated-shape settings; `handleDownload` takes the
  `generatePDFWithVectorCutContour` branch *before* standard contour/shape
  export, using extracted page-coordinate paths and a rasterized image. It
  creates a new PDF with a vector Separation cut path; it does not promise
  byte-for-byte preservation of all original PDF constructs. Relabeling an
  imported path is not changing its physical geometry.
- **Locked contour:** a separate optional `lockedContour` is serialized with
  designs and can be drawn as an additional labeled path in contour/shape
  exports. It is not the same thing as the detected PDF cut path or the active
  Shape selection. Neither the mere presence of this state nor its on-screen
  badge proves a gang-sheet copy retains that extra path.
- **No cut path:** single-design download asks for confirmation before a
  design-only output. Adding to a gang sheet creates a rectangular footprint
  with `noCutPath` so the packer can place it without emitting a cut path.
  That rectangle is a packing bound, not a die line.

### Units, sizing and bleed need explicit labels

- Editor width/height, contour margin, shape offset/radius, shape overrides,
  sheet dimensions, gap, and edge padding are modeled in **inches**; PDF
  drawing converts to 72 points/inch. Raster rendering uses an effective DPI
  or a 300-DPI shape clipping canvas. Imported PDF paths are extracted in page
  pixels and converted to PDF points using the imported page size/DPI.
- The generated contour code includes a `0.10`-inch page margin around traced
  bounds (`bleedInches`); `generateShapePathPointsInches` adds `0.10` inch on
  every side of shape dimensions. The shape-export PDF also has a 0.10-inch
  outer page allowance. **Page allowance is not automatically printed color
  bleed**: `bleedEnabled`/`bleedColor` control a separate shape artwork
  treatment. A white or transparent region outside a cut path is not artwork
  extended through the trim. These relationships should be verified per output
  mode rather than presented to buyers as a universally guaranteed bleed.
- Shape dimensions and the image dimensions are distinct. The gang-sheet
  packer uses `contourData.widthInches/heightInches`, i.e. item footprint
  including allowance, while the visual cut path can lie inside that box.
  Sheet default is 48 × 12 inches, with presets through 48 × 60, 0.25-inch
  default edge padding and minimum contour gap of 0.25 inch. A quoted sticker
  size should specify whether it refers to final cut size, artwork, or outer
  packed footprint, not silently interchange them.

### Preview is not a press proof

`PreviewSection` is a canvas presentation of artwork, cutline and spot-color
state; it also draws gang-sheet placements. The exported PDF follows separate
rendering/spot-vector code and can choose a higher-resolution source than the
preview. Preview is useful for composition, not evidence that bleed, named
Separation colors, path closure, clipping, DPI, or every placed copy is correct
in the actual file. A production proof needs to be derived from the **same
exported artifact** that is submitted, with explicit cut/bleed overlays and
preflight checks. Neither the editor preview nor clicking Download records
customer approval.

### Ordering and persistence risks

- Quantity in the panel means **copies to pack on this gang sheet**, not an
  independent commerce quantity. `packGangSheet` uses rectangular bounds and
  returns placements plus overflow. It may rotate items; it does not nest
  interlocking silhouettes. `expandSettingsToFit` grows sheet height through
  presets when adding/changing copies; Fill Sheet packs the last-added design.
- When a request exceeds the available height, the panel may clamp to a
  calculated maximum with a short warning. Manually choosing a smaller preset
  can create overflow; the UI warns, but export/save are disabled only when
  there are **zero** placements. Both PDF calls receive the placement list,
  while Save & Download records `totalQuantity` from requested item quantities.
  Thus an incomplete sheet can be downloaded/saved and its metadata can
  disagree with printed copies. A commerce handoff must reject unresolved
  overflow and reconcile requested, placed and billed quantities.
- `handleAddToGangSheet` asks the contour worker even for a PDF with an
  existing cut path, then snapshots cached generated geometry if available,
  or a rectangular fallback. The gang-sheet item model does not carry the
  imported PDF's `cutContourPoints` or `lockedContour`. The single-PDF cut
  preservation branch therefore cannot be assumed to survive Add to Gang
  Sheet. Treat imported-cut gang-sheet output as **unverified** until a test
  inspects the actual PDF separations and geometry.
- A saved design stores source-asset reference and editor settings (including
  locked contour and spot tags), not an immutable approved press PDF. Saving a
  gang sheet uploads the generated PDF plus sheet dimensions, item count and
  total quantity; the current editor's `gangSheetItems` are component state,
  not a persistently reloadable itemized cart. Reopening a design or editing
  the source later is not equivalent to reopening an approved order revision.
- Existing White/Gloss/CutContour spot-name collision checks are useful, but
  a valid spot name alone does not certify path position or printability.

## Proposed customer flow (not implemented)

| Stage | Customer decision | Production contract / feedback |
| --- | --- | --- |
| 1. Material | Choose an offered material/finish, with explicit constraints for white ink, clear stock or special inks where relevant. | Show only supported combinations; tie selection to a real catalog/pricing rule, not a free-text PDF property. |
| 2. Cut type | Choose die-cut individual stickers or kiss-cut-on-sheet (or another actually supported process). | Explain backing/edge difference. Map the choice to validated cut-path semantics; do not infer it solely from a spot name such as `KissCut`. |
| 3. Size and artwork | Enter **final trim dimensions** and upload/edit artwork; choose traced contour, geometric shape, or vetted imported cut. | Display trim size, artwork extent, allowance and bleed separately, with actual measured bounding box and DPI/edge warnings. Preserve imported paths or request explicit conversion. |
| 4. Quantity | Request copies per design, or a sheet count when sheet-based production is the product. | Preview exact placed/remaining counts, sheet count and any rotation; never quietly truncate. Price the deliverable unit consistently. |
| 5. Proof | Review a render generated from the finalized PDF, cutline and bleed toggles, magnified edge views and production warnings. | Require explicit approval of an immutable revision/hash; block critical preflight failures. Warn that color on screen is indicative, not a calibrated color guarantee. |
| 6. Order | Confirm itemized material, cut type, dimensions, quantity, price, proof revision and delivery details. | Create an order record tied to the approved PDF asset; return a real order identifier and status, not a download toast. |

This is an opportunity to stand out through **geometry the buyer can trust**:
one coherent measurement model across designer, sheet, proof and order; visible
cut-vs-print separation; a traceable approved artifact; and a clear explanation
of what will arrive. Do not advertise unsupported material/process options.

## Ranked improvements with acceptance criteria

### P0 — production correctness and truthful handoff

1. **Make cut-source selection explicit and consistent** (generated contour,
   generated shape, imported cut, or no cut). Benefit: buyers cannot unknowingly
   receive a different die line on sheet versus single download. Acceptance:
   each item carries its cut-source and path geometry in one normalized
   inch-based representation; imported multi-path cuts and any intentional
   locked secondary path are either preserved across preview/single/sheet
   export or visibly rejected; automated PDF inspection compares bounds,
   count, labels and closure after rotation. No rectangular fallback is
   presented as a real cut.
2. **Fail closed on overflow and quantity disagreement.** Benefit: no paid or
   saved job silently drops copies. Acceptance: export/save/order block while
   `overflow > 0` or an item is unplaceable; the UI names affected designs and
   requested/placed/remaining counts; an explicit add-sheet/reduce-quantity
   action resolves it; PDF placement count and persisted totals match.
3. **Introduce export-artifact preflight and approval gate.** Benefit: what
   customers approve is what production receives. Acceptance: the final PDF
   is checked for required named separations, valid closed finite cut paths,
   expected page/trim dimensions, cut/print alignment and minimum printable
   resolution; failures block order, warnings require acknowledgement; proof
   and order reference the same versioned asset/hash.
4. **Validate bleed and size semantics per mode.** Benefit: fewer white halos,
   clipped artwork and wrong-size stickers. Acceptance: UI labels trim,
   artwork and outer sheet footprint separately; a measured cut-to-print
   coverage check flags insufficient bleed at every edge; single, shape,
   imported PDF and gang-sheet outputs are verified against the stated trim
   size within an agreed print tolerance.

### P1 — make ordering usable after production correctness

5. **Build a constrained product configurator and checkout handoff.**
   Benefit: the designer becomes an order path rather than a file generator.
   Acceptance: material/cut-type/size/quantity combinations use a real
   supported catalog; pricing and fulfillment terms are shown before
   approval; server validates the same selections and stores them with the
   approved artifact; confirmation exposes order ID and line items.
6. **Persist a recoverable, itemized job draft.** Benefit: users can return
   without reconstructing a multi-design sheet. Acceptance: authentication
   round-trip restores item sources, settings, quantities, cut-source/version,
   spot selections and sheet settings; missing assets are explicit errors;
   edits invalidate prior proof approval and trigger fresh packing/preflight.
7. **Provide a production-oriented proof UI.** Benefit: users understand the
   physical result before approval. Acceptance: exported-PDF render shows
   togglable art/trim/bleed/backing views, dimensions, per-item placed counts,
   and an explicit “approve this revision” step; distinguish screen mockup
   from file-based proof and disclose color limitations.

### P2 — differentiation and operational polish

8. **Offer guided contour repair and useful warnings.** Benefit: difficult
   artwork can be corrected without hiding risky edges. Acceptance: surface
   tiny islands, holes, narrow bridges, excessive nodes and transparent
   background ambiguity; show affected regions and reversible user choices;
   verified PDF matches the chosen preview geometry.
9. **Expose sheet efficiency without promising silhouette nesting.**
   Benefit: buyers can make informed size/quantity choices. Acceptance:
   compare supported sheet sizes and number of sheets, show utilized area
   and unplaced count, preserve minimum clearance, and make any rotation
   visible in the proof.
10. **Add production traceability and accessible controls.** Benefit: fewer
    support disputes and easier repeat ordering. Acceptance: revision history
    links decisions, asset hash, preflight and approval to each order; keyboard
    and screen-reader users can select cut source, inspect warnings and approve
    without relying only on color or canvas imagery.

## Test matrix for implementation and release review

| Input / scenario | Preview and measurements | Export and order invariant |
| --- | --- | --- |
| Opaque raster with white background; transparent irregular PNG | Compare Shape vs Contour and background removal; examine thin details | Correct cut source; no accidental full-page box; adequate art beyond cut |
| Circle, oval, square, rounded rectangle; overrides and rotation | Trim vs artwork vs packed bounds labeled; rotated dimensions correct | Closed named vector path, correct radius/size and image alignment |
| PDF with one or multiple existing cut paths; custom cut label | Imported path displayed without generating a substitute | Single and gang sheet preserve intended path geometry/labels or reject explicitly |
| Locked secondary contour; White/Gloss spot layers | Distinguish secondary from primary cut and show collisions | Expected distinct separations; never silently lose or merge a path |
| Tiny, huge, low-resolution or edited artwork | DPI, effective print size, holes/islands and bleed warnings | No NaN/out-of-bounds cuts; no silent scaling or false approval |
| Mixed items, rotations, last-item Fill Sheet, max sheet height | Requested, placed, remaining and sheet utilization visible | All copies present or export/order blocked; metadata equals PDF count |
| No-cut-path design | Preview says “no cut”; footprint distinguished | Design-only output intentional; no phantom CutContour separation |
| Save/reopen/edit after approval; unauthenticated user | Draft/approval status explicit | Approved revision immutable; edits require a new proof; missing source surfaced |

Measure PDF paths and separations programmatically **and** visually inspect a
render of the exported file at trim edges. Cover both local worker and offload
trace outputs with the same geometry contract. Tests in this repository are
useful starting points, not proof of live-device print accuracy.

## Sequencing and deployment boundary

1. Freeze a documented cut/trim/artwork coordinate contract and reproduce
   current single-versus-sheet and overflow cases; add artifact-level tests.
2. Complete and verify geometry fixes in every selected trace path, then
   normalize imported/locked/generated geometry and eliminate silent
   fallback. Recheck preview-to-PDF equivalence and print bleed.
3. Enforce quantity/overflow and export preflight before any order handoff.
4. Add catalog/price/order persistence, then versioned proof approval and
   recoverable drafts; polish guided repair and optimization afterward.

The browser can trace via an offload service when healthy, otherwise fall back
to worker/main-thread paths (`contour-worker-manager.ts`). A repository-side
fix does **not** prove the live VPS is updated. Deployment of the live offload
contour service is separately blocked pending access/coordination; do not
describe it as fixed until the deployed endpoint/version is identified and
tested with the same acceptance cases. This review changes documentation
only; verified implementation results belong in the parent delivery summary.