---
name: Spot selection persistence during background detection
description: Keep live customer White/Gloss choices authoritative over delayed analysis snapshots.
---

Background detection may enrich artwork geometry, but must not overwrite newer customer spot selections.

**Why:** Large artwork leaves time for customers to select White/Gloss before QR metadata or region detection completes. A delayed reset can look like a scrolling bug even though scrolling never changes selection state.

**How to apply:** Reset extraction only when actual source pixels change, not when metadata is added to the same image. Merge late region geometry into current selections; newly discovered regions inherit whole-color choices, and existing explicit false region flags remain false. Keep worker-mutated objects separate from rendered state and discard results from replaced artwork.