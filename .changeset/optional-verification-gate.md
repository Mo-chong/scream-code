---
'@scream-cli/agent-core': patch
---

Make verification and code review opt-in instead of mandatory.

- Updated the default system prompt so the agent decides whether to run verification/review based on the user's intent.
- Skipped verification gates for non-development tasks such as installing/configuring skills, changing settings, and pure Q&A.
- Removed the hard convergence gate that forced a turn to continue whenever unverified working-set paths existed.
- Adjusted the summary guard so it no longer treats unverified paths as "meaningful work" on its own.
