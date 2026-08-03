import path from 'node:path';
import fsp from 'node:fs/promises';
import { ensureDir, readJson, readText, writeJsonAtomic, writeTextAtomic, mergeManagedBlock, nowIso, PACKAGE_VERSION, exists } from './fsx.js';
import { DEFAULT_RETENTION_POLICY } from './retention.js';
import { DEFAULT_DB_SAFETY_POLICY } from './db-safety.js';
import { isHarnessSourceProject, writeHarnessGuardPolicy } from './harness-guard.js';
import { repairSksGeneratedArtifacts } from './harness-conflicts.js';
import { disableVersionGitHook } from './version-manager.js';
import { coreEngineeringDirectiveReferenceText, coreEngineeringDirectiveText } from './lean-engineering-policy.js';
import { OFFICIAL_SUBAGENT_REVIEW_POLICY_TEXT } from './official-subagent-review-policy.js';
import { AWESOME_DESIGN_MD_REFERENCE, CODEX_APP_IMAGE_GENERATION_DOC_URL, CODEX_COMPUTER_USE_ONLY_POLICY, CODEX_IMAGEGEN_REQUIRED_POLICY, CODEX_WEB_VERIFICATION_POLICY, DEFAULT_CODEX_APP_PLUGINS, DESIGN_SYSTEM_SSOT, DOLLAR_COMMANDS, DOLLAR_COMMAND_ALIASES, DOLLAR_SKILL_NAMES, FROM_CHAT_IMG_CHECKLIST_ARTIFACT, FROM_CHAT_IMG_COVERAGE_ARTIFACT, FROM_CHAT_IMG_QA_LOOP_ARTIFACT, FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT, FROM_CHAT_IMG_TEMP_TRIWIKI_SESSIONS, GETDESIGN_REFERENCE, IMAGEGEN_SOCIAL_SOURCE_POLICY, LEGACY_DOLLAR_SKILL_NAMES, OPENAI_CHATGPT_IMAGES_2_DOC_URL, OPENAI_GPT_IMAGE_2_MODEL_DOC_URL, OPENAI_IMAGE_GENERATION_DOC_URL, PPT_CONDITIONAL_SKILL_ALLOWLIST, PPT_PIPELINE_MCP_ALLOWLIST, PPT_PIPELINE_SKILL_ALLOWLIST, RECOMMENDED_DESIGN_REFERENCES, RECOMMENDED_MCP_SERVERS, RECOMMENDED_SKILLS, RESERVED_CODEX_PLUGIN_SKILL_NAMES, SOLUTION_SCOUT_SKILL_NAME, chatCaptureIntakeText, context7ConfigToml, getdesignReferencePolicyText, imageUxReviewPipelinePolicyText, outcomeRubricPolicyText, pptPipelineAllowlistPolicyText, prefixKnownSksDollarReferences, productDesignPluginPolicyText, sksPrefixedDollarCommand, speedLanePolicyText, stackCurrentDocsPolicyText, triwikiContextTracking, triwikiContextTrackingText, triwikiStagePolicyText } from './routes.js';
import { SKILL_DREAM_POLICY, skillDreamPolicyText } from './skill-forge.js';
import { CODEX_HOOK_EVENT_STATE_KEYS } from './codex-compat/codex-hook-events.js';
import { codexCommandHookCurrentHash } from './codex-hooks/codex-hook-hash.js';
import { buildSksCoreSkillManifest, isCoreSkillName, legacyCoreSkillNames } from './codex-native/core-skill-manifest.js';
import { syncCoreSkillsIntegrity } from './codex-native/core-skill-integrity.js';
import { AUTHORITATIVE_SKS_SKILL_ROOT_REFERENCE } from './codex-native/sks-skill-paths.js';
import { currentGeneratedFileInventory, installCodexAgents, pruneStaleGeneratedFiles, REMOVED_SKS_SKILL_NAMES } from './init/skills.js';
import { reconcileManagedSkillInstallation } from './init/managed-skill-install.js';
import {
  backupInvalidToml,
  inspectOfficialSubagentToml,
  mergeOfficialSubagentConfig,
  officialSubagentConfigOwnershipProof,
  officialSubagentConfigWarnings,
  readInheritedOfficialSubagentConfigText,
  resolveInheritedOfficialSubagentConfigPath
} from './subagents/official-subagent-config.js';
import { escapeRegExp } from './text/regex.js';
export { installGlobalSkills, installProjectSkills, installSkills } from './init/skills.js';

const REFLECTION_MEMORY_PATH = '.sneakoscope/memory/q2_facts/post-route-reflection.md';
const REMOVED_SKILL_TOKENS = new Set(REMOVED_SKS_SKILL_NAMES.map((name) => name.replace(/[^a-z0-9]/g, '')));

function removedSkillSurface(value: any) {
  return REMOVED_SKILL_TOKENS.has(String(value || '').toLowerCase().replace(/^\$/, '').replace(/[^a-z0-9]/g, ''));
}

function currentDollarCommands() {
  return DOLLAR_COMMANDS
    .filter((entry: any) => !removedSkillSurface(entry.command))
    .map((entry: any) => ({ ...entry, command: sksPrefixedDollarCommand(entry.command) }));
}

function currentDollarSkillNames() {
  return DOLLAR_SKILL_NAMES.filter((name: any) => !removedSkillSurface(name));
}

function currentDollarCommandAliases() {
  return DOLLAR_COMMAND_ALIASES
    .filter((entry: any) => !removedSkillSurface(entry.canonical) && !removedSkillSurface(entry.app_skill))
    .map((entry: any) => ({ ...entry, canonical: sksPrefixedDollarCommand(entry.canonical) }));
}
const SKS_GENERATED_GIT_PATTERNS = [
  '.sneakoscope/missions/',
  '.sneakoscope/reports/',
  '.sneakoscope/tmp/',
  '.sneakoscope/cache/',
  '.sneakoscope/arenas/',
  '.sneakoscope/processes/',
  '.sneakoscope/bench/',
  '.sneakoscope/blackbox/',
  '.sneakoscope/logs/',
  '.sneakoscope/state/',
  '.sneakoscope/db/',
  '.sneakoscope/evidence/',
  '.sneakoscope/proof/',
  '.sneakoscope/perf/',
  '.sneakoscope/research/',
  '.sneakoscope/skills/',
  '.sneakoscope/smoke-archives/',
  '.sneakoscope/memory/',
  '.sneakoscope/wiki/indexes/',
  '.sneakoscope/wiki/context-packs/',
  '.sneakoscope/wiki/tmp/',
  '.sneakoscope/wiki/context-pack.json',
  '.sneakoscope/wiki/image-assets.json',
  '.sneakoscope/wiki/image-voxel-ledger.json',
  '.sneakoscope/wiki/visual-anchors.json',
  '.sneakoscope/wiki/last-sweep-report.json',
  '.codex/',
  '.agents/',
  'AGENTS.md'
];
const SKS_SKILL_MANIFEST_FILE = '.sks-generated.json';
const GENERATED_PRUNE_POLICY = 'remove_previous_sks_generated_paths_absent_from_current_manifest';

export const REQUIRED_GENERATED_CODEX_APP_FEATURE_FLAGS = [
  'hooks',
  'fast_mode',
  'apps'
];

export function hasTopLevelCodexModeLock(text: any = '') {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((x: any) => /^\s*\[.+\]\s*$/.test(x));
  const top = (firstTable === -1 ? lines : lines.slice(0, firstTable)).join('\n');
  return /^model_reasoning_effort\s*=/m.test(top);
}

export function hasDeprecatedCodexHooksFeatureFlag(text: any = '') {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((line: any) => line.trim() === '[features]');
  if (start === -1) return false;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[i] || '')) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).some((line: any) => /^\s*codex_hooks\s*=/.test(line));
}

export function missingGeneratedCodexAppFeatureFlags(text: any = '') {
  if (text && typeof text === 'object') return REQUIRED_GENERATED_CODEX_APP_FEATURE_FLAGS.filter((name: any) => text[name] !== true);
  return REQUIRED_GENERATED_CODEX_APP_FEATURE_FLAGS.filter((name: any) => !String(text || '').includes(`${name} = true`));
}

export function hasCodexUnstableFeatureWarningSuppression(text: any = '') {
  return /(^|\n)\s*suppress_unstable_features_warning\s*=\s*true\s*(?:#.*)?(?=\n|$)/.test(String(text || ''));
}

export function assertCodexWarningSuppressed(text: any = '', label: any = 'Codex config') {
  if (!hasCodexUnstableFeatureWarningSuppression(text)) {
    throw new Error(`selftest: ${label} missing suppress_unstable_features_warning`);
  }
}

function reflectionInstructionText(commandPrefix: any = 'sks') {
  return `Post-route reflection: full routes load \`reflection\` after work/tests and before final; DFix/Answer/Help/Wiki/SKS discovery are exempt. Write reflection.md; record only real misses/gaps, or no_issue_acknowledged. For lessons, append TriWiki claim rows to ${REFLECTION_MEMORY_PATH}. Run "${commandPrefix} wiki refresh" or pack, validate, then pass reflection-gate.json.`;
}

export function normalizeInstallScope(scope: any = 'global') {
  const value = String(scope || 'global').trim().toLowerCase();
  if (value === 'global' || value === 'project') return value;
  throw new Error(`Invalid install scope: ${scope}. Use "global" or "project".`);
}

export function sksCommandPrefix(scope: any = 'global', opts: any = {}) {
  return normalizeInstallScope(scope) === 'project'
    ? 'node ./node_modules/sneakoscope/dist/bin/sks.js'
    : (opts.globalCommand || 'sks');
}

function sksHookCommand(commandPrefix: any, hookName: any) {
  return `${commandPrefix} hook ${hookName}`;
}

const MANAGED_HOOKS = {
  SessionStart: [{ hooks: [{ type: 'command', command: null, hookName: 'session-start', statusMessage: 'SKS preparing session context' }] }],
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: null, hookName: 'user-prompt-submit', statusMessage: 'SKS routing prompt and context' }] }],
  PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: null, hookName: 'pre-tool', statusMessage: 'SKS checking tool safety' }] }],
  PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: null, hookName: 'post-tool', statusMessage: 'SKS recording tool evidence' }] }],
  PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: null, hookName: 'permission-request', statusMessage: 'SKS reviewing permission request' }] }],
  PreCompact: [{ hooks: [{ type: 'command', command: null, hookName: 'pre-compact', statusMessage: 'SKS preparing compact context' }] }],
  PostCompact: [{ hooks: [{ type: 'command', command: null, hookName: 'post-compact', statusMessage: 'SKS recording compact context' }] }],
  SubagentStart: [{ hooks: [{ type: 'command', command: null, hookName: 'subagent-start', statusMessage: 'SKS recording subagent start' }] }],
  SubagentStop: [{ hooks: [{ type: 'command', command: null, hookName: 'subagent-stop', statusMessage: 'SKS recording subagent stop' }] }],
  Stop: [{ hooks: [{ type: 'command', command: null, hookName: 'stop', statusMessage: 'SKS checking done gate' }] }]
};

function buildManagedHooks(commandPrefix: any) {
  const hooks: Record<string, any> = {};
  for (const [eventName, entries] of Object.entries(MANAGED_HOOKS)) {
    hooks[eventName] = entries.map((entry: any) => ({
      ...('matcher' in entry ? { matcher: entry.matcher } : {}),
      hooks: entry.hooks.map(({ hookName, ...hook }: any) => ({
        ...hook,
        command: sksHookCommand(commandPrefix, hookName)
      }))
    }));
  }
  return { hooks };
}

const CODEX_HOOK_EVENT_KEYS: Record<string, string> = { ...CODEX_HOOK_EVENT_STATE_KEYS };

export function buildManagedHookTrustStateToml(root: string, commandPrefix: string): string {
  const source = path.join(root, '.codex', 'hooks.json');
  const managed = buildManagedHooks(commandPrefix).hooks;
  const blocks: string[] = [];
  for (const [eventName, entries] of Object.entries(managed) as Array<[string, any[]]>) {
    const eventKey = CODEX_HOOK_EVENT_KEYS[eventName] || eventName;
    entries.forEach((entry, groupIndex) => {
      (entry.hooks || []).forEach((hook: any, handlerIndex: number) => {
        const key = `${source}:${eventKey}:${groupIndex}:${handlerIndex}`;
        const table = `hooks.state."${tomlQuotedKey(key)}"`;
        blocks.push(`[${table}]\ntrusted_hash = "${codexHookTrustedHash(eventName, entry, hook)}"`);
      });
    });
  }
  return `${blocks.join('\n\n')}\n`;
}

export function mergeManagedHookTrustStateToml(existingContent: string, root: string, commandPrefix: string): string {
  let next = String(existingContent || '').trimEnd();
  for (const block of buildManagedHookTrustStateToml(root, commandPrefix).trim().split(/\n\n+/)) {
    const table = block.match(/^\[([^\]]+)\]/)?.[1];
    if (table) next = upsertCodexTrustTomlTable(next, table, block);
  }
  return `${next.trim()}\n`;
}

export function codexHookTrustedHash(eventName: string, entry: any, hook: any): string {
  return codexCommandHookCurrentHash({
    event: eventName as any,
    matcher: !['UserPromptSubmit', 'Stop', 'SessionStart', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact'].includes(eventName) && entry?.matcher != null ? String(entry.matcher) : null,
    command: String(hook.command || ''),
    timeout: Number(hook.timeout || 600),
    async: Boolean(hook.async),
    statusMessage: String(hook.statusMessage || '')
  });
}

function tomlQuotedKey(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function upsertCodexTrustTomlTable(text: string, table: string, block: string): string {
  let lines = String(text || '').trimEnd().split('\n');
  if (lines.length === 1 && lines[0] === '') lines = [];
  const header = `[${table}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  const blockLines = String(block || '').trim().split('\n');
  if (start === -1) return [...lines, ...(lines.length ? [''] : []), ...blockLines].join('\n').replace(/\n{3,}/g, '\n\n');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[i] || '')) {
      end = i;
      break;
    }
  }
  lines.splice(start, end - start, ...blockLines);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function mergeManagedHooksJson(existingContent: any, commandPrefix: any) {
  let root: any = {};
  try {
    root = existingContent?.trim() ? JSON.parse(existingContent) : {};
    if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};
  } catch {
    root = {};
  }
  const managed: any = buildManagedHooks(commandPrefix);
  const currentHooks = root.hooks && typeof root.hooks === 'object' && !Array.isArray(root.hooks) ? root.hooks : {};
  const nextHooks = { ...currentHooks };
  for (const [eventName, managedEntries] of Object.entries(managed.hooks) as Array<[string, any[]]>) {
    const existingEntries = Array.isArray(currentHooks[eventName]) ? currentHooks[eventName] : [];
    const preserved: any[] = [];
    for (const entry of existingEntries) {
      const stripped = stripSksManagedHookEntry(entry);
      if (stripped) preserved.push(stripped);
    }
    nextHooks[eventName] = [...preserved, ...managedEntries];
  }
  return `${JSON.stringify({ ...root, hooks: nextHooks }, null, 2)}\n`;
}

function stripSksManagedHookEntry(entry: any) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.hooks)) return entry;
  const next = entry.hooks.filter((hook: any) => !isSksManagedHook(hook));
  if (next.length === entry.hooks.length) return entry;
  if (!next.length) return null;
  return { ...entry, hooks: next };
}

function isSksManagedHook(hook: any) {
  if (!hook || typeof hook !== 'object' || Array.isArray(hook)) return false;
  const command = String(hook.command || '');
  return hook.type === 'command' && /\bhook\s+(?:session-start|user-prompt-submit|pre-tool|post-tool|permission-request|pre-compact|post-compact|subagent-start|subagent-stop|stop)\b/.test(command) && /\b(?:sks|sneakoscope|sks\.js)\b/.test(command);
}
const AGENTS_BLOCK = [
  '',
  '# Sneakoscope Codex Managed Rules',
  '',
  'This repository uses Sneakoscope Codex.',
  '',
  '## Engineering',
  '',
  ...coreEngineeringDirectiveText().split('\n'),
  '',
  '## Execution',
  '',
  '- Codex native `/goal` is the only persisted goal owner. Goal objectives must state the outcome, scope, constraints, verification, done-when conditions, stop conditions, and non-goals.',
  '- General code-changing work uses the `$Naruto` Codex official subagent workflow; Answer and genuinely tiny DFix work stay lightweight.',
  '- The parent owns decomposition, integration, verification, and the final answer. Delegate only independent slices with disjoint write scopes, reuse capacity across root-owned waves, and never nest subagents.',
  '- Route model by the slice: Luna Max for tiny mechanical work, Sol High for implementation, Terra Max for read-heavy context or direct tool operation, and Sol Max only for focused judgment, risk, or final review.',
  '- Codex 0.145 spawn compatibility: a full-history fork (`fork_turns="all"`, including the omitted/default mode) inherits the parent agent type, model, and reasoning effort. When selecting a custom `agent_type` or overriding `model`/`reasoning_effort`, use `fork_turns="none"` or a positive bounded turn count and carry the complete bounded slice contract in `message`; use full history only with those overrides omitted.',
  '- Route-specific skills own route-specific details. Do not inject unrelated Design, PPT, image, browser, research, DB, or release policy into ordinary work.',
  '- Do not stop at a plan when implementation was requested. Finish and verify, or report a concrete hard blocker.',
  '',
  '## Evidence And Context',
  '',
  '- Prefer current code, tests, configuration, contracts, and specifications over memory. Use Context7 or official vendor docs when external APIs, SDKs, packages, MCPs, or versions matter.',
  '- Keep TriWiki recall bounded: read the current context pack before a stage, hydrate risky or stale claims from source, refresh after material changes, and validate before handoff or final.',
  '- Mock, fixture, synthetic, or capability evidence never proves real execution. Completion claims require relevant checks or an explicit justification for why a check is not useful.',
  '- Final output must summarize the result, verification, and remaining gaps, then run Honest Mode.',
  '',
  '## Safety',
  '',
  '- Preserve user-authored content and unrelated changes. Installed harness files remain immutable outside the Sneakoscope engine source repository.',
  '- Keep trust-boundary validation, secrets, permissions, data integrity, rollback, accessibility, and explicit user requirements intact.',
  '- Database and destructive operations are read-only by default. Live mutation, publishing, deployment, credential changes, and other irreversible external actions require explicit scoped authorization.',
  '- Never fabricate fallback implementations or success evidence. If the real requested path is unavailable, stop with evidence.',
  '- Never run `sks doctor --fix` yourself. When repair is needed, tell the user to run it in their own terminal and wait for confirmation.',
  '- Conflicting third-party Codex harness markers are removed from the live surface only via `sks conflicts cleanup --yes`; a backup is kept under `.sneakoscope/quarantine/other-harness/`.',
  '',
  '## Codex App',
  '',
  `Use \`.codex/SNEAKOSCOPE.md\`, global \`${AUTHORITATIVE_SKS_SKILL_ROOT_REFERENCE}/sks-*\`, \`.codex/hooks.json\`, and SKS dollar commands as the app control surface. Managed SKS skill files are re-resolved by UserPromptSubmit, compact-resume SessionStart, active PreToolUse, and SubagentStart; current files override stale project-local, \`.codex/skills\`, plugin-cache, picker, pre-compaction, and prior-message paths. After a successful remap, read the current file silently without reporting a path mismatch.`,
  ''
].join('\n');

export function agentsBlockText() {
  return prefixKnownSksDollarReferences(AGENTS_BLOCK, [...LEGACY_DOLLAR_SKILL_NAMES, ...legacyCoreSkillNames(), 'from-chat-img']);
}

export async function initProject(root: any, opts: any = {}) {
  const created: any[] = [];
  const installScope = normalizeInstallScope(opts.installScope || 'global');
  const localOnly = Boolean(opts.localOnly);
  const sourceProject = await isHarnessSourceProject(root).catch(() => false);
  const requestedHookCommandPrefix = opts.hookCommandPrefix || sksCommandPrefix(installScope, { globalCommand: opts.globalCommand });
  const hookCommandPrefix = sourceProject ? 'node ./dist/bin/sks.js' : requestedHookCommandPrefix;
  const sine = path.join(root, '.sneakoscope');
  const manifestPath = path.join(sine, 'manifest.json');
  const previousManifest = await readJson(manifestPath, null);
  const preRepairCodexConfig = opts.repair ? await readText(path.join(root, '.codex', 'config.toml'), '') : '';
  if (opts.repair) {
    const repair = await repairSksGeneratedArtifacts(root, {
      resetState: Boolean(opts.resetState),
      preserveCodexAgents: true
    });
    if (repair.removed.length) created.push(`repaired generated SKS files (${repair.removed.length})`);
  }
  const dirs = [
    '.sneakoscope/state', '.sneakoscope/missions', '.sneakoscope/db', '.sneakoscope/bus', '.sneakoscope/hproof', '.sneakoscope/db', '.sneakoscope/wiki', '.sneakoscope/skills', '.sneakoscope/memory/q0_raw', '.sneakoscope/memory/q1_evidence', '.sneakoscope/memory/q2_facts', '.sneakoscope/memory/q3_tags', '.sneakoscope/memory/q4_bits', '.sneakoscope/gx/cartridges', '.sneakoscope/model/fingerprints', '.sneakoscope/genome/candidates', '.sneakoscope/trajectories/raw', '.sneakoscope/locks', '.sneakoscope/tmp', '.sneakoscope/arenas', '.sneakoscope/reports', '.codex', '.codex/agents'
  ];
  for (const d of dirs) await ensureDir(path.join(root, d));
  const sharedIgnoreWanted = !localOnly && await shouldWriteSharedGitIgnore(root, installScope);
  const localExclude = localOnly ? await ensureLocalOnlyGitExclude(root) : null;
  const sharedIgnore = sharedIgnoreWanted ? await ensureSharedGitIgnore(root) : null;
  if (localExclude?.path) created.push(`${path.relative(root, localExclude.path)} local-only excludes`);
  if (sharedIgnore?.changed) created.push(`${path.relative(root, sharedIgnore.path)} SKS generated files ignore`);

  const manifest: any = {
    package: 'sneakoscope',
    version: PACKAGE_VERSION,
    initialized_at: nowIso(),
    no_external_tools: true,
    codex_required: true,
    codex_app_supported: true,
    native_runtime_dependencies: 0,
    installation: {
      scope: installScope,
      default_scope: 'global',
      hook_command_prefix: hookCommandPrefix,
      global_command: opts.globalCommand || 'sks',
      project_command: 'node ./node_modules/sneakoscope/dist/bin/sks.js'
    },
    codex_app: {
      config: '.codex/config.toml',
      hooks: '.codex/hooks.json',
      skills: AUTHORITATIVE_SKS_SKILL_ROOT_REFERENCE,
      project_skills_policy: '.agents/skills is not the authoritative managed SKS install root',
      legacy_skills_dir_removed: '.codex/skills',
      agents: '.codex/agents',
      quick_reference: '.codex/SNEAKOSCOPE.md',
      agents_rules: 'AGENTS.md'
    },
    prompt_pipeline: {
      default_enabled: true,
      dollar_commands: currentDollarCommands().map((c: any) => c.command),
      dollar_skill_names: currentDollarSkillNames(),
      direct_fix_command: '$sks-dfix',
      ppt_skill_allowlist: PPT_PIPELINE_SKILL_ALLOWLIST,
      ppt_conditional_skill_allowlist: PPT_CONDITIONAL_SKILL_ALLOWLIST,
      ppt_mcp_allowlist: PPT_PIPELINE_MCP_ALLOWLIST
    },
    recommended_skills: RECOMMENDED_SKILLS.filter((name: any) => !removedSkillSurface(name)),
    recommended_mcp_servers: RECOMMENDED_MCP_SERVERS,
    design_system_ssot: DESIGN_SYSTEM_SSOT,
    recommended_design_references: RECOMMENDED_DESIGN_REFERENCES,
    skill_dreaming: {
      state: SKILL_DREAM_POLICY.state_path,
      latest_report: SKILL_DREAM_POLICY.latest_report_path,
      min_events_between_runs: SKILL_DREAM_POLICY.min_events_between_runs,
      min_interval_hours: SKILL_DREAM_POLICY.min_interval_hours,
      apply_mode: SKILL_DREAM_POLICY.apply_mode,
      no_auto_delete: SKILL_DREAM_POLICY.no_auto_delete
    },
    harness_guard: {
      enabled: true,
      policy: '.sneakoscope/harness-guard.json',
      immutable_to_llm_edits: true
    },
    harness_conflicts: {
      block_other_codex_harnesses: true,
      hard_blockers: ['OMX', 'DCodex'],
      cleanup_prompt_command: `${hookCommandPrefix} conflicts prompt`,
      human_approval_required: false
    },
    llm_wiki: {
      ssot: 'triwiki',
      coordinate_schema: 'sks.wiki-coordinate.v1',
      voxel_overlay_schema: 'sks.wiki-voxel.v1',
      default_pack: triwikiContextTracking().default_pack,
      context_tracking: triwikiContextTracking(),
      channel_map: { r: 'domainAngle', g: 'layerRadius', b: 'phase', a: 'concentration' },
      continuity_model: 'selected_text_plus_hydratable_rgba_trig_anchors',
      required_pack_shape: 'coordinate_index_with_voxel_overlay',
      migration_model: 'setup_or_wiki_refresh_regenerates_required_voxel_overlay'
    },
    git: {
      local_only: localOnly,
      ignore_path: sharedIgnore?.path ? path.relative(root, sharedIgnore.path) : null,
      ignored_patterns: sharedIgnore?.patterns || [],
      exclude_path: localExclude?.path ? path.relative(root, localExclude.path) : null,
      excluded_patterns: localExclude?.patterns || [],
      versioning: {
        enabled: false,
        bump: 'patch',
        lock: 'git-common-dir/sks-version.lock',
        state: 'git-common-dir/sks-version-state.json'
      }
    },
    database_safety: 'default_safe; $MAD-SKS is the sole scoped SQL-plane execution exception and keeps mission-local write transport, catastrophic-intent binding, read-back proof, and final read-only restoration',
    gx_renderer: 'deterministic_svg_html'
  };
  await writeJsonAtomic(manifestPath, manifest);
  created.push('.sneakoscope/manifest.json');

  const dbSafetyPath = path.join(sine, 'db-safety.json');
  if (!(await exists(dbSafetyPath)) || opts.force) {
    await writeJsonAtomic(dbSafetyPath, DEFAULT_DB_SAFETY_POLICY);
    created.push('.sneakoscope/db-safety.json');
  }

  const policyPath = path.join(sine, 'policy.json');
  if (!(await exists(policyPath)) || opts.force) {
    await writeJsonAtomic(policyPath, defaultPolicy(installScope, hookCommandPrefix));
    created.push('.sneakoscope/policy.json');
  } else {
    const policy = await readJson(policyPath, {});
    await writeJsonAtomic(policyPath, {
      ...policy,
      installation: installPolicy(installScope, hookCommandPrefix),
      git: {
        ...(policy.git || {}),
        local_only: localOnly || Boolean(policy.git?.local_only),
        ignore_path: sharedIgnore?.path ? path.relative(root, sharedIgnore.path) : policy.git?.ignore_path || null,
        ignored_patterns: sharedIgnore?.patterns || policy.git?.ignored_patterns || [],
        exclude_path: localExclude?.path ? path.relative(root, localExclude.path) : policy.git?.exclude_path || null,
        excluded_patterns: localExclude?.patterns || policy.git?.excluded_patterns || [],
        versioning: {
          ...(policy.git?.versioning || {}),
          enabled: false,
          bump: policy.git?.versioning?.bump || 'patch',
          lock: 'git-common-dir/sks-version.lock',
          state: 'git-common-dir/sks-version-state.json'
        }
      },
      versioning: {
        ...(policy.versioning || {}),
        enabled: false,
        bump: policy.versioning?.bump || 'patch',
        trigger: 'manual',
        lock_scope: 'git-common-dir',
        managed_files: ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']
      },
      prompt_pipeline: {
        ...(policy.prompt_pipeline || {}),
        default_enabled: true,
        route_without_command: true,
        dollar_commands: currentDollarCommands().map((c: any) => c.command),
        dollar_skill_names: currentDollarSkillNames(),
        direct_fix_command: '$sks-dfix',
        ppt_skill_allowlist: PPT_PIPELINE_SKILL_ALLOWLIST,
        ppt_conditional_skill_allowlist: PPT_CONDITIONAL_SKILL_ALLOWLIST,
        ppt_mcp_allowlist: PPT_PIPELINE_MCP_ALLOWLIST
      },
      context7: {
        ...(policy.context7 || {}),
        required_for_external_docs: true,
        default_transport: 'remote',
        mcp_config: '.codex/config.toml',
        required_flow: ['resolve-library-id', 'query-docs']
      },
      harness_guard: {
        ...(policy.harness_guard || {}),
        enabled: true,
        policy: '.sneakoscope/harness-guard.json',
        immutable_to_llm_edits: true,
        engine_source_exception_only: true
      },
      harness_conflicts: {
        ...(policy.harness_conflicts || {}),
        block_other_codex_harnesses: true,
        hard_blockers: ['OMX', 'DCodex'],
        cleanup_prompt_command: `${hookCommandPrefix} conflicts prompt`,
        human_approval_required: false
      },
      llm_wiki: {
        ...(policy.llm_wiki || {}),
        ssot: 'triwiki',
        voxel_overlay_schema: 'sks.wiki-voxel.v1',
        default_pack: triwikiContextTracking().default_pack,
        context_tracking: triwikiContextTracking(),
        compression_policy: 'preserve_ids_hashes_sources_rgba_coordinates_for_hydration',
        required_pack_shape: 'coordinate_index_with_voxel_overlay',
        migration_model: 'setup_or_wiki_refresh_regenerates_required_voxel_overlay'
      },
      recommended_skills: RECOMMENDED_SKILLS.filter((name: any) => !removedSkillSurface(name)),
      recommended_mcp_servers: RECOMMENDED_MCP_SERVERS,
      design_system_ssot: DESIGN_SYSTEM_SSOT,
      recommended_design_references: RECOMMENDED_DESIGN_REFERENCES
    });
  }

  function defaultPolicy(scope: any, commandPrefix: any) {
    return {
      schema_version: 1,
      installation: installPolicy(scope, commandPrefix),
      git: {
        local_only: localOnly,
        ignore_path: sharedIgnore?.path ? path.relative(root, sharedIgnore.path) : null,
        ignored_patterns: sharedIgnore?.patterns || [],
        exclude_path: localExclude?.path ? path.relative(root, localExclude.path) : null,
        excluded_patterns: localExclude?.patterns || [],
        versioning: {
          enabled: false,
          bump: 'patch',
          lock: 'git-common-dir/sks-version.lock',
          state: 'git-common-dir/sks-version-state.json'
        }
      },
      retention: DEFAULT_RETENTION_POLICY,
      update_check: {
        enabled: true,
        package: 'sneakoscope',
        prompt_user_before_work: true,
        skip_scope: 'conversation_only'
      },
      versioning: {
        enabled: false,
        bump: 'patch',
        trigger: 'manual',
        lock_scope: 'git-common-dir',
        managed_files: ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'],
        collision_policy: 'explicit_bump_only'
      },
      honest_mode: {
        required_before_final: true,
        verify_goal_evidence_tests_gaps: true
      },
      database_safety: {
        ...DEFAULT_DB_SAFETY_POLICY,
        mad_sks_live_full_access: true,
        mad_sks_gate_module: 'src/core/permission-gates.ts'
      },
      performance: {
        max_parallel_sessions: 2,
        process_tail_bytes: 262144,
        codex_timeout_ms: 1800000,
        prefer_streaming_logs: true,
        eval_thresholds: {
          min_token_savings_pct: 0.1,
          min_accuracy_delta: 0.03,
          min_required_recall: 0.95
        }
      },
      llm_wiki: {
        ssot: 'triwiki',
        coordinate_schema: 'sks.wiki-coordinate.v1',
        voxel_overlay_schema: 'sks.wiki-voxel.v1',
        default_pack: '.sneakoscope/wiki/context-pack.json',
        context_tracking: triwikiContextTracking(),
        compression_policy: 'preserve_ids_hashes_sources_rgba_coordinates_for_hydration',
        required_pack_shape: 'coordinate_index_with_voxel_overlay',
        channel_map: { r: 'domainAngle', g: 'layerRadius_sin', b: 'phase', a: 'concentration' }
      },
      package: {
        zero_runtime_dependencies: true,
        rust_default_runtime: false,
        rust_reason: 'Native Rust binaries would increase package size and break npm install portability. Optional Rust source is provided for future acceleration, but default runtime is dependency-free Node.js.'
      },
      database: {
        guardian_enabled: true,
        live_database_mode: 'read_only',
        destructive_operations_allowed: false,
        mcp_write_tools_allowed: false
      },
      gx: {
        renderer: 'deterministic_svg_html',
        source_of_truth: 'vgraph.json',
        external_image_generation: false
      },
      codex_app: {
        supported: true,
        config: '.codex/config.toml',
        hooks: '.codex/hooks.json',
        skills: AUTHORITATIVE_SKS_SKILL_ROOT_REFERENCE,
        project_skills_policy: '.agents/skills is not the authoritative managed SKS install root',
        legacy_skills_dir_removed: '.codex/skills',
        agents: '.codex/agents',
        quick_reference: '.codex/SNEAKOSCOPE.md',
        agents_rules: 'AGENTS.md'
      },
      prompt_pipeline: {
        default_enabled: true,
        route_without_command: true,
        dollar_commands: currentDollarCommands().map((c: any) => c.command),
        dollar_skill_names: currentDollarSkillNames(),
        direct_fix_command: '$sks-dfix',
        ppt_skill_allowlist: PPT_PIPELINE_SKILL_ALLOWLIST,
        ppt_conditional_skill_allowlist: PPT_CONDITIONAL_SKILL_ALLOWLIST,
        ppt_mcp_allowlist: PPT_PIPELINE_MCP_ALLOWLIST
      },
      context7: {
        required_for_external_docs: true,
        default_transport: 'remote',
        mcp_config: '.codex/config.toml',
        required_flow: ['resolve-library-id', 'query-docs']
      },
      harness_guard: {
        enabled: true,
        policy: '.sneakoscope/harness-guard.json',
        immutable_to_llm_edits: true,
        engine_source_exception_only: true
      },
      harness_conflicts: {
        block_other_codex_harnesses: true,
        hard_blockers: ['OMX', 'DCodex'],
        cleanup_prompt_command: `${commandPrefix} conflicts prompt`,
        cleanup_model_policy: 'inherit_codex_selection',
        cleanup_reasoning_effort: 'high',
        human_approval_required: false
      },
      recommended_skills: RECOMMENDED_SKILLS.filter((name: any) => !removedSkillSurface(name)),
      recommended_mcp_servers: RECOMMENDED_MCP_SERVERS,
      design_system_ssot: DESIGN_SYSTEM_SSOT,
      recommended_design_references: RECOMMENDED_DESIGN_REFERENCES
    };
  }

function installPolicy(scope: any, commandPrefix: any) {
  return {
    scope,
    default_scope: 'global',
    hook_command_prefix: commandPrefix,
    global_install: 'npm i -g sneakoscope',
    project_install: 'npm i -D sneakoscope && npx sks setup --install-scope project'
  };
}

// SKS-managed Codex App feature flags. Seeded as defaults for fresh configs but
// NEVER force-re-enabled on upgrade: force-writing these reverted a user's
// `enabled = false` and blanked/broke the Codex App UI (same rationale as the
// install-helpers path). All are SET-IF-ABSENT below.
// Only flags present in the current official [features] reference. Flags SKS
// wrote before the 2026-07 renewal that no longer exist (remote_control,
// fast_mode_ui, codex_git_commit, computer_use, browser_use, browser_use_external,
// image_generation, in_app_browser, guardian_approval, tool_suggest, plugins) are
// stripped below instead.
const MANAGED_CODEX_FEATURE_FLAGS = ['hooks', 'fast_mode', 'apps'];
const REMOVED_CODEX_FEATURE_FLAGS = [
  'remote_control', 'fast_mode_ui', 'codex_git_commit', 'computer_use', 'browser_use',
  'browser_use_external', 'image_generation', 'in_app_browser', 'guardian_approval',
  'tool_suggest', 'plugins', 'codex_hooks', 'multi_agent'
];

function mergeManagedCodexConfigToml(existingContent: any = '', opts: any = {}) {
  let next = String(existingContent || '').trimEnd();
  next = removeTomlTableKey(next, 'notice', 'fast_default_opt_out');
  next = removeTomlTableKey(next, 'features', 'codex_hooks');
  next = upsertTopLevelTomlBooleanIfAbsent(next, 'suppress_unstable_features_warning', true);
  // Codex App feature flags: SET-IF-ABSENT only (see note above); flags the
  // 2026-07 renewal removed from the schema are stripped.
  for (const flag of MANAGED_CODEX_FEATURE_FLAGS) {
    next = upsertTomlTableKeyIfAbsent(next, 'features', `${flag} = true`);
  }
  for (const flag of REMOVED_CODEX_FEATURE_FLAGS) {
    next = removeTomlTableKey(next, 'features', flag);
  }
  next = removeWholeTomlTable(next, 'user.fast_mode');
  next = removeWholeTomlTable(next, 'profiles.sks-fast-high');
  // Codex 0.145 stabilized opt-in multi-agent V2. Project merge owns the
  // `[features.multi_agent_v2]` table (enabled + concurrency + model overrides).
  next = mergeOfficialSubagentConfig(next, {
    sksOwned: opts.sksOwned === true,
    inheritedText: opts.inheritedText || ''
  });
  for (const block of managedCodexConfigBlocks()) {
    if (block.preserveExisting === true && hasTomlTable(next, block.table)) continue;
    next = upsertTomlTable(next, block.table, block.text);
  }
  // Plugin tables broke the Codex App UI by force-reverting user `enabled=false`.
  // Auto-enable is opt-in only, and even then never overwrites an existing table.
  if (process.env.SKS_MANAGE_CODEX_APP_PLUGINS === '1') {
    for (const [name, marketplace] of DEFAULT_CODEX_APP_PLUGINS) {
      const table = `plugins."${name}@${marketplace}"`;
      if (!hasTomlTable(next, table)) {
        next = upsertTomlTable(next, table, `[${table}]\nenabled = true`);
      }
    }
  }
  return `${next.trim()}\n`;
}

async function mergeGlobalCodexConfigIfAvailable(configText: any = '', configPath: any = '', opts: any = {}) {
  const selectedRe = /(^|\n)\s*model_provider\s*=\s*"codex-lb"\s*(?:#.*)?(?=\n|$)/;
  const home = opts.home || process.env.HOME || '';
  if (!home) return configText;
  const codexHome = opts.codexHome || process.env.CODEX_HOME || path.join(home, '.codex');
  const globalConfigPath = path.join(codexHome, 'config.toml');
  if (configPath && path.resolve(configPath) === path.resolve(globalConfigPath)) return configText;
  const globalConfig = await readText(globalConfigPath, '');
  let next = mergeGlobalMcpServers(configText, globalConfig);
  next = mergeGlobalCodexAppRuntimeTables(next, globalConfig);
  if (selectedRe.test(next) && /\[model_providers\.codex-lb\]/.test(next)) {
    return `${next.trim()}\n`;
  }
  const envPath = path.join(codexHome, 'sks-codex-lb.env');
  if (!(await exists(envPath))) return next;
  const envText = await readText(envPath, '');
  const baseUrl = globalConfig.match(/(^|\n)\[model_providers\.codex-lb\][\s\S]*?\n\s*base_url\s*=\s*"([^"]+)"/)?.[2] || parseCodexLbEnvBaseUrl(envText);
  if (!parseCodexLbEnvKey(envText) || !baseUrl) return next;
  const shouldSelectCodexLb = selectedRe.test(next) || selectedRe.test(globalConfig);
  next = shouldSelectCodexLb
    ? upsertTopLevelTomlString(next, 'model_provider', 'codex-lb')
    : removeTopLevelTomlKeyIfValue(next, 'model_provider', 'codex-lb');
  next = upsertTomlTable(next, 'model_providers.codex-lb', `[model_providers.codex-lb]\nname = "codex-lb"\nbase_url = "${baseUrl}"\nwire_api = "responses"\nenv_http_headers = { "X-Codex-LB-API-Key" = "CODEX_LB_API_KEY" }\nsupports_websockets = true\nrequires_openai_auth = false`);
  return `${next.trim()}\n`;
}

function parseCodexLbEnvKey(text: any = '') {
  return parseShellEnvValue(text, 'CODEX_LB_API_KEY');
}

function parseCodexLbEnvBaseUrl(text: any = '') {
  const value = parseShellEnvValue(text, 'CODEX_LB_BASE_URL');
  if (!value) return '';
  let host = value.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) host = `https://${host}`;
  host = host.replace(/\/+$/, '');
  return /\/backend-api\/codex$/i.test(host) ? host : `${host}/backend-api/codex`;
}

function parseShellEnvValue(text: any = '', key: any = '') {
  const re = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=\\s*(.+?)\\s*$`, 'm');
  const raw = String(text || '').match(re)?.[1]?.trim() || '';
  if (!raw) return '';
  if (raw.startsWith("'")) return raw.endsWith("'") && raw.length > 1 ? raw.slice(1, -1).replace(/'\\''/g, "'") : '';
  if (raw.startsWith('"')) return raw.endsWith('"') && raw.length > 1 ? raw.slice(1, -1).replace(/\\"/g, '"') : '';
  if (raw.includes("'") || raw.includes('"') || /\s/.test(raw)) return '';
  return raw;
}

function mergeGlobalMcpServers(configText: any = '', globalConfig: any = '') {
  let next = configText;
  const re = /(?:^|\n)(\[(mcp_servers\.[^\]\r\n]+)\][\s\S]*?)(?=\n\[[^\]]+\]|\s*$)/g;
  for (const match of String(globalConfig || '').matchAll(re)) {
      const block = (match[1] || '').trim();
      const table = (match[2] || '').trim();
    if (!new RegExp(`(^|\\n)\\[${escapeRegExp(table)}\\]`).test(next)) next = upsertTomlTable(next, table, block);
  }
  return next;
}

function mergeGlobalCodexAppRuntimeTables(configText: any = '', globalConfig: any = '') {
  let next = configText;
  const re = /(?:^|\n)(\[((?:marketplaces|plugins)\.[^\]\r\n]+)\][\s\S]*?)(?=\n\[[^\]]+\]|\s*$)/g;
  for (const match of String(globalConfig || '').matchAll(re)) {
      const block = (match[1] || '').trim();
      const table = (match[2] || '').trim();
    if (!new RegExp(`(^|\\n)\\[${escapeRegExp(table)}\\]`).test(next)) next = upsertTomlTable(next, table, block);
  }
  return next;
}

function removeWholeTomlTable(text: any = '', table: any = '') {
  const lines = String(text || '').trimEnd().split('\n');
  const header = `[${table}]`;
  const start = lines.findIndex((x: any) => x.trim() === header);
  if (start === -1) return String(text || '');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const ln = lines[i];
    if (ln !== undefined && /^\s*\[.+\]\s*$/.test(ln)) { end = i; break; }
  }
  return lines.filter((_: any, index: any) => index < start || index >= end).join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

function removeTopLevelTomlKeyIfValue(text: any = '', key: any = '', value: any = '') {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((x: any) => /^\s*\[.+\]\s*$/.test(x));
  const end = firstTable === -1 ? lines.length : firstTable;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"${escapeRegExp(value)}"\\s*(?:#.*)?$`);
  return lines.filter((line: any, index: any) => index >= end || !keyPattern.test(line)).join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

function upsertTopLevelTomlString(text: any, key: any, value: any) {
  const line = `${key} = "${value}"`;
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((x: any) => /^\s*\[.+\]\s*$/.test(x));
  const end = firstTable === -1 ? lines.length : firstTable;
  for (let i = 0; i < end; i += 1) {
    if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(lines[i] || '')) {
      lines[i] = line;
      return lines.join('\n').replace(/\n{3,}/g, '\n\n');
    }
  }
  lines.splice(end, 0, line);
  return lines.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

function upsertTopLevelTomlBoolean(text: any, key: any, value: any) {
  const line = `${key} = ${value ? 'true' : 'false'}`;
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((x: any) => /^\s*\[.+\]\s*$/.test(x));
  const end = firstTable === -1 ? lines.length : firstTable;
  for (let i = 0; i < end; i += 1) {
    if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(lines[i] || '')) {
      lines[i] = line;
      return lines.join('\n').replace(/\n{3,}/g, '\n\n');
    }
  }
  lines.splice(end, 0, line);
  return lines.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

function hasTopLevelTomlKey(text: any, key: any): boolean {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((x: any) => /^\s*\[.+\]\s*$/.test(x));
  const end = firstTable === -1 ? lines.length : firstTable;
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (let i = 0; i < end; i += 1) if (re.test(lines[i] || '')) return true;
  return false;
}

function upsertTopLevelTomlBooleanIfAbsent(text: any, key: any, value: any) {
  return hasTopLevelTomlKey(text, key) ? String(text || '') : upsertTopLevelTomlBoolean(text, key, value);
}

function hasTomlTable(text: any, table: any): boolean {
  return new RegExp(`(^|\\n)\\s*\\[${escapeRegExp(table)}\\]\\s*(?:#.*)?(?=\\n|$)`).test(String(text || ''));
}

function hasTomlTableKey(text: any, table: any, key: any): boolean {
  const lines = String(text || '').split('\n');
  const header = `[${table}]`;
  const start = lines.findIndex((x: any) => x.trim() === header);
  if (start === -1) return false;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[i] || '')) { end = i; break; }
  }
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (let i = start + 1; i < end; i += 1) if (re.test(lines[i] || '')) return true;
  return false;
}

function upsertTomlTableKeyIfAbsent(text: any, table: any, line: any) {
  const key = (String(line).split('=')[0] || '').trim();
  return hasTomlTableKey(text, table, key) ? String(text || '') : upsertTomlTableKey(text, table, line);
}

function removeTomlTableKey(text: any, table: any, key: any) {
  const lines = String(text || '').trimEnd().split('\n');
  if (lines.length === 1 && lines[0] === '') return '';
  const header = `[${table}]`;
  const start = lines.findIndex((x: any) => x.trim() === header);
  if (start === -1) return String(text || '');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[i] || '')) {
      end = i;
      break;
    }
  }
  const keyPattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
  return lines.filter((line: any, index: any) => index <= start || index >= end || !keyPattern.test(line)).join('\n').replace(/\n{3,}/g, '\n\n');
}

function managedCodexConfigBlocks() {
  return [
    // Preserve existing Context7 credentials; seed remote transport to avoid invalid merged command/url stdio config.
    { table: 'mcp_servers.context7', text: context7ConfigToml('remote').trim(), preserveExisting: true },
    // Profiles use per-file CODEX_HOME overlays owned by auto-review migration; do not emit deprecated profile tables.
    {
      table: 'auto_review',
      text: '[auto_review]\npolicy = "In MAD-SKS launches, allow only the scoped high-risk surfaces approved for the active invocation. The explicit sks mad-sks sql|apply-migration invocation is the SQL-plane approval boundary: execute only requested SQL-plane mutations with mission-local write transport, literal catastrophic-intent binding, read-back proof, and final read-only restoration. Supabase project/account/billing/credential control-plane actions remain denied."'
    }
  ];
}

function upsertTomlTableKey(text: any, table: any, line: any) {
  const key = (String(line).split('=')[0] || '').trim();
  let lines = String(text || '').split('\n');
  if (lines.length === 1 && lines[0] === '') lines = [];
  const header = `[${table}]`;
  let start = lines.findIndex((x: any) => x.trim() === header);
  if (start === -1) {
    const prefix = lines.length && (lines[lines.length - 1] || '').trim() ? ['', header, line] : [header, line];
    return [...lines, ...prefix].join('\n').replace(/\n{3,}/g, '\n\n');
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[.+\]\s*$/.test(lines[i] || '')) {
      end = i;
      break;
    }
  }
  for (let i = start + 1; i < end; i++) {
    if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(lines[i] || '')) {
      lines[i] = line;
      return lines.join('\n').replace(/\n{3,}/g, '\n\n');
    }
  }
  lines.splice(start + 1, 0, line);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function upsertTomlTable(text: any, table: any, block: any) {
  let lines = String(text || '').trimEnd().split('\n');
  if (lines.length === 1 && lines[0] === '') lines = [];
  const header = `[${table}]`;
  const start = lines.findIndex((x: any) => x.trim() === header);
  const blockLines = String(block || '').trim().split('\n');
  if (start === -1) {
    return [...lines, ...(lines.length ? [''] : []), ...blockLines].join('\n').replace(/\n{3,}/g, '\n\n');
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[.+\]\s*$/.test(lines[i] || '')) {
      end = i;
      break;
    }
  }
  lines.splice(start, end - start, ...blockLines);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

  const currentState = path.join(sine, 'state', 'current.json');
  if (!(await exists(currentState)) || opts.force) {
    await writeJsonAtomic(currentState, { mode: 'IDLE', phase: 'IDLE', updated_at: nowIso() });
    created.push('.sneakoscope/state/current.json');
  }

  const agentsMdPath = path.join(root, 'AGENTS.md');
  const existingAgents = await readText(agentsMdPath, '');
  const hasManagedAgentsBlock = existingAgents.includes('BEGIN Sneakoscope Codex GX MANAGED BLOCK');
  if (localOnly && existingAgents && !hasManagedAgentsBlock) {
    created.push('AGENTS.md skipped (local-only existing file)');
  } else {
    await mergeManagedBlock(agentsMdPath, 'Sneakoscope Codex GX MANAGED BLOCK', agentsBlockText());
    created.push('AGENTS.md managed block');
  }

  const generatedCodexConfigPath = path.join(root, '.codex', 'config.toml');
  const existingCodexConfig = await readText(generatedCodexConfigPath, '') || preRepairCodexConfig;
  const configOwnershipProof = officialSubagentConfigOwnershipProof({
    text: existingCodexConfig,
    manifest: previousManifest,
    migrationReceipt: await readJson(path.join(root, '.sneakoscope', 'update', 'migration-receipt.json'), null)
  });
  const configPreviouslySksOwned = configOwnershipProof.owned;
  const configWasFresh = !String(existingCodexConfig || '').trim();
  const existingConfigValidation = inspectOfficialSubagentToml(existingCodexConfig);
  let codexConfigInstall: any;
  if (!existingConfigValidation.ok) {
    const backupPath = await backupInvalidToml(generatedCodexConfigPath, existingCodexConfig, 'project-config-invalid');
    // repairSksGeneratedArtifacts may have removed the path before this stage;
    // invalid user TOML is still restored byte-for-byte and never normalized.
    await writeTextAtomic(generatedCodexConfigPath, existingCodexConfig);
    codexConfigInstall = {
      ok: false,
      status: 'unparseable_config_preserved',
      config_path: generatedCodexConfigPath,
      backup_path: backupPath,
      manual_blockers: ['manual_invalid_project_codex_config'],
      warnings: []
    };
    created.push('.codex/config.toml invalid TOML preserved (manual repair required)');
  } else {
    const inheritedCodexConfig = await readInheritedOfficialSubagentConfigText(generatedCodexConfigPath, {
      home: opts.home,
      codexHome: opts.codexHome
    });
    const inheritedConfigValidation = inspectOfficialSubagentToml(inheritedCodexConfig);
    if (!inheritedConfigValidation.ok) {
      // A malformed inherited CODEX_HOME config is an operator-owned blocker,
      // not an empty layer. Do not derive or write a project config from it.
      // Repair mode may have removed an SKS-generated project config earlier,
      // so restore that project text byte-for-byte while leaving the inherited
      // file untouched.
      if (String(existingCodexConfig || '').length > 0) {
        await writeTextAtomic(generatedCodexConfigPath, existingCodexConfig);
      }
      const inheritedConfigPath = resolveInheritedOfficialSubagentConfigPath(generatedCodexConfigPath, {
        home: opts.home,
        codexHome: opts.codexHome
      });
      const backupPath = inheritedConfigPath
        ? await backupInvalidToml(inheritedConfigPath, inheritedCodexConfig, 'inherited-global-config-invalid')
        : null;
      codexConfigInstall = {
        ok: false,
        status: 'invalid_inherited_global_config_preserved',
        config_path: generatedCodexConfigPath,
        backup_path: backupPath,
        inherited_config_preserved: true,
        inherited_config_error: inheritedConfigValidation.error,
        manual_blockers: ['manual_invalid_inherited_global_codex_config'],
        warnings: []
      };
      created.push('inherited global Codex config invalid and preserved (manual repair required)');
    } else {
      const managedCodexConfig = await mergeGlobalCodexConfigIfAvailable(
        mergeManagedCodexConfigToml(existingCodexConfig, {
          sksOwned: configPreviouslySksOwned,
          inheritedText: inheritedCodexConfig
        }),
        generatedCodexConfigPath,
        { home: opts.home, codexHome: opts.codexHome }
      );
      const managedConfigValidation = inspectOfficialSubagentToml(managedCodexConfig);
      if (!managedConfigValidation.ok) {
        await writeTextAtomic(generatedCodexConfigPath, existingCodexConfig);
        codexConfigInstall = {
          ok: false,
          status: 'unsafe_config_merge_preserved',
          config_path: generatedCodexConfigPath,
          backup_path: null,
          manual_blockers: ['manual_project_codex_config_merge_invalid'],
          warnings: []
        };
        created.push('.codex/config.toml merge skipped (manual repair required)');
      } else {
        await writeTextAtomic(generatedCodexConfigPath, managedCodexConfig);
        codexConfigInstall = {
          ok: true,
          status: managedCodexConfig === existingCodexConfig ? 'present' : 'written',
          config_path: generatedCodexConfigPath,
          backup_path: null,
          manual_blockers: [],
          warnings: officialSubagentConfigWarnings(managedCodexConfig, inheritedCodexConfig)
        };
        created.push('.codex/config.toml');
      }
    }
  }
  codexConfigInstall.ownership_proof = configOwnershipProof;

  await writeTextAtomic(path.join(root, '.codex', 'SNEAKOSCOPE.md'), codexAppQuickReference(installScope, hookCommandPrefix));
  created.push('.codex/SNEAKOSCOPE.md');

  const hooksPath = path.join(root, '.codex', 'hooks.json');
  await writeTextAtomic(hooksPath, mergeManagedHooksJson(await readText(hooksPath, ''), hookCommandPrefix));
  created.push(`.codex/hooks.json (${installScope})`);
  if (codexConfigInstall.ok) {
    await writeTextAtomic(
      generatedCodexConfigPath,
      mergeManagedHookTrustStateToml(await readText(generatedCodexConfigPath, ''), root, hookCommandPrefix)
    );
    created.push('.codex/config.toml hook trust state');
  }

  const { skillInstall, created: skillInstallCreated } = await reconcileManagedSkillInstallation(root, opts.home);
  created.push(...skillInstallCreated);
  const agentInstall = await installCodexAgents(root);
  created.push(`.codex/agents official subagent catalog (${agentInstall.installed_agents?.length || 0})`);
  if (agentInstall.retired_role_cleanup?.removed_count) created.push(`retired SKS-owned agent role files removed (${agentInstall.retired_role_cleanup.removed_count})`);
  if (agentInstall.retired_role_cleanup?.quarantined_user_collision_count) created.push(`retired role-name user collisions quarantined (${agentInstall.retired_role_cleanup.quarantined_user_collision_count})`);
  if (agentInstall.manual_blockers?.length) created.push(`official subagent agent config manual blockers (${agentInstall.manual_blockers.length})`);
  const configInventoryOwned = codexConfigInstall.ok && (configWasFresh || configPreviouslySksOwned);
  const generatedFiles = currentGeneratedFileInventory(skillInstall, agentInstall, {
    includeCodexConfig: configInventoryOwned,
    includeSkillFiles: false
  });
  const generatedCleanup = await pruneStaleGeneratedFiles(root, previousManifest, generatedFiles);
  if (generatedCleanup.pruned.length) created.push(`stale generated files pruned (${generatedCleanup.pruned.length})`);
  manifest.generated_files = {
    schema_version: 1,
    generated_by: 'sneakoscope',
    prune_policy: GENERATED_PRUNE_POLICY,
    files: generatedFiles
  };
  manifest.generated_cleanup = {
    schema_version: 1,
    last_run_at: nowIso(),
    previous_version: previousManifest?.version || null,
    current_version: PACKAGE_VERSION,
    pruned: generatedCleanup.pruned,
    already_absent: generatedCleanup.already_absent || []
  };
  manifest.codex_app.official_subagents = {
    config: codexConfigInstall,
    agents: agentInstall,
    manual_blockers: [
      ...(codexConfigInstall.manual_blockers || []),
      ...(agentInstall.manual_blockers || [])
    ],
    warnings: codexConfigInstall.warnings || []
  };
  await writeJsonAtomic(manifestPath, manifest);
  await writeHarnessGuardPolicy(root);
  created.push('.sneakoscope/harness-guard.json');
  const versionHookCleanup = await disableVersionGitHook(root);
  created.push(versionHookCleanup.hook_removed ? '.git/hooks/pre-commit SKS version guard removed' : `version guard disabled (${versionHookCleanup.reason || 'policy updated'})`);
  return {
    created,
    generated_cleanup: generatedCleanup,
    skill_install: skillInstall,
    agent_install: agentInstall,
    codex_config_install: codexConfigInstall
  };
}

async function ensureSharedGitIgnore(root: any) {
  const patterns = SKS_GENERATED_GIT_PATTERNS;
  const ignorePath = path.join(root, '.gitignore');
  const markerStart = '# BEGIN Sneakoscope Codex generated files';
  const markerEnd = '# END Sneakoscope Codex generated files';
  const managedBlock = `${markerStart}\n${patterns.join('\n')}\n${markerEnd}\n`;
  const current = await readText(ignorePath, '');
  if (current.includes(markerStart)) {
    const re = new RegExp(`${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}\\n?`);
    const next = current.replace(re, managedBlock);
    if (next !== current) await writeTextAtomic(ignorePath, next.endsWith('\n') ? next : `${next}\n`);
    return { path: ignorePath, patterns, changed: next !== current };
  }
  const existing = new Set(current.split(/\r?\n/).map((line: any) => line.trim()).filter(Boolean));
  const missing = patterns.filter((pattern: any) => !existing.has(pattern));
  if (!missing.length) return { path: ignorePath, patterns, changed: false };
  const block = missing.length === patterns.length
    ? managedBlock
    : `${markerStart}\n${missing.join('\n')}\n${markerEnd}\n`;
  await writeTextAtomic(ignorePath, `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${block}`);
  return { path: ignorePath, patterns, changed: true };
}

async function shouldWriteSharedGitIgnore(root: any, installScope: any) {
  if (normalizeInstallScope(installScope) === 'project') return true;
  if (await exists(path.join(root, '.git'))) return true;
  if (await exists(path.join(root, '.gitignore'))) return true;
  return false;
}

async function ensureLocalOnlyGitExclude(root: any) {
  const gitDir = await resolveGitDir(root);
  if (!gitDir) return { path: null, patterns: [] };
  const patterns = SKS_GENERATED_GIT_PATTERNS;
  const excludePath = path.join(gitDir, 'info', 'exclude');
  await ensureDir(path.dirname(excludePath));
  const markerStart = '# Sneakoscope Codex local-only generated files';
  const current = await readText(excludePath, '');
  if (!current.includes(markerStart)) {
    const block = `${markerStart}\n${patterns.join('\n')}\n`;
    await writeTextAtomic(excludePath, `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${block}`);
  }
  return { path: excludePath, patterns };
}

async function resolveGitDir(root: any) {
  const dotGit = path.join(root, '.git');
  if (!(await exists(dotGit))) return null;
  const text = await readText(dotGit, null);
  if (typeof text === 'string') {
    const match = text.match(/^gitdir:\s*(.+)\s*$/m);
    if (match?.[1]) return path.resolve(root, match[1]);
  }
  return dotGit;
}
export function codexAppQuickReference(scope: any, commandPrefix: any) {
  return [
    '# ㅅㅋㅅ',
    `Install scope: \`${scope}\``,
    `Command: \`${commandPrefix} <command>\``,
    `Files: AGENTS.md, .codex/hooks.json, .codex/config.toml, .codex/SNEAKOSCOPE.md, ${AUTHORITATIVE_SKS_SKILL_ROOT_REFERENCE}/sks-* (authoritative managed SKS skills), .codex/agents, .sneakoscope/missions.`,
    `Skill paths: UserPromptSubmit, compact-resume SessionStart, active PreToolUse, and SubagentStart re-resolve files under ${AUTHORITATIVE_SKS_SKILL_ROOT_REFERENCE}/sks-*/SKILL.md. Current files override stale project-local, .codex/skills, plugin-cache, picker, pre-compaction, and prior-message links. Successful remaps stay silent; unresolved skills are never guessed.`,
    `Discover: ${commandPrefix} bootstrap; ${commandPrefix} deps check; ${commandPrefix} commands; ${commandPrefix} codex-app check; ${commandPrefix} codex-app remote-control --status; ${commandPrefix} dollar-commands; ${commandPrefix} pipeline status; ${commandPrefix} pipeline plan.`,
    coreEngineeringDirectiveReferenceText(),
    'dollar-commands:',
    ...currentDollarCommands().map((c: any) => `- \`${sksPrefixedDollarCommand(c.command)}\`: ${c.route}`),
    `Picker skills: ${currentDollarCommandAliases().map((x: any) => x.app_skill).join(', ')}.`,
    'Routing: Answer is read-only, DFix is tiny and lightweight, and general code-changing work uses Naruto with official Codex subagent threads and parent-owned integration.',
    'Subagent context: Codex 0.145 full-history forks (`fork_turns="all"`, including the default) inherit agent type/model/reasoning. Custom `agent_type` or model/reasoning overrides must use `fork_turns="none"` or a positive bounded turn count, with the complete bounded slice contract in `message`.',
    'Goal: Codex native /goal is the only persisted goal owner; no SKS Goal mission, bridge, compatibility loop, or fallback state is allowed.',
    `Context: use bounded TriWiki recall, refresh after material changes, validate before handoff/final, and use Context7 or official vendor docs when external contracts or versions matter.`,
    `Full routes write reflection.md, record only real lessons to ${REFLECTION_MEMORY_PATH}, then finish with a completion summary and Honest Mode.`,
    `Runtime root: ${commandPrefix} root reports the active project or global runtime root.`,
    `Guard: generated harness files are immutable outside the engine source repo; conflicts require ${commandPrefix} conflicts prompt plus human approval.`,
    'Publishing, deployment, live database mutation, destructive actions, and other irreversible external effects require explicit scoped authorization.'
  ].join('\n') + '\n';
}
