# scream-code

## 0.6.4

### Patch Changes

- Expose the unified `/skill` command (with `plugin`, `plugins`, `skill`, and `skills` aliases) for browsing installed skills and installing plugin packages. Add `pluginId` to skill summaries, `injectPlugin`/`ejectPlugin` session APIs, and a built-in marketplace fallback.

- Allow deleting manually installed skills from `/skill`: pressing `d` on a non-plugin skill now removes the skill's installation directory (including bundled sub-skills) from disk and updates the running session's skill registry. The Skill Center now also shows a loading spinner while installed skills and marketplace entries are being fetched, so the screen no longer appears frozen after running `/skill`.
