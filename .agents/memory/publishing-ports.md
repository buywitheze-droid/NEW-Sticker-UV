---
name: Publishing port constraint
description: Why development-only port mappings must not be exposed for this app's Autoscale publishing.
---

Keep only the application port externally mapped when publishing on Autoscale.

**Why:** Replit documentation restricts Autoscale to one external port. An investigation found an extra development HMR mapping alongside a failed publish that compiled and uploaded successfully but produced no startup logs. The mapping was invalid regardless of the missing terminal error; do not assume successful compilation establishes publishing readiness.

**How to apply:** When publishing stops after image upload with no runtime logs, check external port mappings as well as startup behavior. Development HMR already uses the Express server connection, so it does not need a separately exposed port here. Treat the next publish, not a local build, as confirmation that the publishing failure is resolved.