---
name: Custom spot name integrity
description: Literal PDF name encoding and reliable custom contour identification.
---

Treat custom spot names as literal user text, not pre-escaped PDF tokens.

**Why:** pdf-lib interprets a literal sequence such as `#20` as an escaped space. Simply calling its name constructor with user text can silently rename a production separation. Content operators and dictionary keys must use the same literal-name encoding.

**How to apply:** Test decoded names against the original input, including literal hexadecimal-looking hash sequences, rather than comparing two equally misencoded tokens.

Do not infer arbitrary custom cutting names from naming patterns alone.

**Why:** The user allows arbitrary CutContour names. A custom name cannot reliably distinguish a cutting separation from White or Varnish on re-import.

**How to apply:** Preserve explicit contour identity in exported PDF metadata and honor that identity during import; retain legacy name recognition for older files.