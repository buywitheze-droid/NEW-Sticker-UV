---
name: Authentication account linking
description: Rules for adding third-party sign-in without splitting a user's saved designs across accounts.
---

Third-party sign-in may link to an existing internal account only when the identity provider cryptographically verifies the normalized email address. Keep the internal account ID stable across login methods.

**Why:** Saved designs and related records belong to the internal account ID. Creating a second account for the same verified person would make existing work appear lost, while trusting an unverified email would enable account takeover.

**How to apply:** For any future identity provider, validate provider-issued identity data server-side, require a provider-verified email before email-based linking, never overwrite an existing password, and preserve the same internal account/session model.