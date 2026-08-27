/**
 * The `[features]` keys SKS seeds, and the ones it strips.
 *
 * Stripping is destructive in one direction only: deleting the line for a flag
 * Codex STILL supports restores Codex's own default, which is `true` for every
 * stable flag. The previous hand-maintained list had drifted to include nine
 * live flags — `computer_use`, `browser_use`, `browser_use_external`,
 * `image_generation`, `in_app_browser`, `guardian_approval`, `tool_suggest`,
 * `plugins`, and `multi_agent` — so a user's explicit `= false` was deleted and
 * silently reverted to `true`.
 *
 * Only flags Codex reports as `removed`, or does not know at all, belong in
 * REMOVED_CODEX_FEATURE_FLAGS: Codex ignores those, so deleting them is inert
 * cleanup. `codex features list` is the authority, and
 * `test/unit/codex-feature-flags.test.mjs` pins both lists against the vendored
 * Codex binary so they cannot rot again.
 */
export const MANAGED_CODEX_FEATURE_FLAGS = Object.freeze(['hooks', 'fast_mode', 'apps'])

export const REMOVED_CODEX_FEATURE_FLAGS = Object.freeze([
  // unknown to Codex 0.150.1 (multi_agent_mode was stage `removed` in 0.147
  // and has since left the table entirely; `multi_agent` itself is stable)
  'fast_mode_ui',
  'codex_hooks',
  'multi_agent_mode',
  // stage `removed` in Codex 0.150.1
  'remote_control',
  'codex_git_commit',
  'plugin_hooks',
  'js_repl'
])
