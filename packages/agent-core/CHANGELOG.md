# @scream-cli/agent-core

## 0.6.6

### Patch Changes

- Add subagent.started lifecycle event for TUI visibility of "spawning → running" transition. Fix step_uuid crash from out-of-order streaming events. Palette constant renaming, fixed-bottom caching, Glob formatting, and misc TUI cleanups.

## 0.6.5

### Patch Changes

- 4000613: Make verification and code review opt-in instead of mandatory.

  - Updated the default system prompt so the agent decides whether to run verification/review based on the user's intent.
  - Skipped verification gates for non-development tasks such as installing/configuring skills, changing settings, and pure Q&A.
  - Removed the hard convergence gate that forced a turn to continue whenever unverified working-set paths existed.
  - Adjusted the summary guard so it no longer treats unverified paths as "meaningful work" on its own.

## 0.6.4

### Patch Changes

- Expose the unified `/skill` command (with `plugin`, `plugins`, `skill`, and `skills` aliases) for browsing installed skills and installing plugin packages. Add `pluginId` to skill summaries, `injectPlugin`/`ejectPlugin` session APIs, and a built-in marketplace fallback.

- Allow deleting manually installed skills from `/skill`: pressing `d` on a non-plugin skill now removes the skill's installation directory (including bundled sub-skills) from disk and updates the running session's skill registry. The Skill Center now also shows a loading spinner while installed skills and marketplace entries are being fetched, so the screen no longer appears frozen after running `/skill`.
