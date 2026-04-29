import path from 'node:path';
import fsp from 'node:fs/promises';
import { ensureDir, readJson, readText, writeJsonAtomic, writeTextAtomic, mergeManagedBlock, nowIso, PACKAGE_VERSION, exists } from './fsx.mjs';
import { DEFAULT_RETENTION_POLICY } from './retention.mjs';
import { DEFAULT_DB_SAFETY_POLICY } from './db-safety.mjs';
import { isHarnessSourceProject, writeHarnessGuardPolicy } from './harness-guard.mjs';
import { repairSksGeneratedArtifacts } from './harness-conflicts.mjs';
import { installVersionGitHook } from './version-manager.mjs';
import { DOLLAR_COMMANDS, DOLLAR_COMMAND_ALIASES, DOLLAR_SKILL_NAMES, FROM_CHAT_IMG_CHECKLIST_ARTIFACT, FROM_CHAT_IMG_COVERAGE_ARTIFACT, FROM_CHAT_IMG_QA_LOOP_ARTIFACT, FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT, FROM_CHAT_IMG_TEMP_TRIWIKI_SESSIONS, RECOMMENDED_MCP_SERVERS, RECOMMENDED_SKILLS, chatCaptureIntakeText, context7ConfigToml, stackCurrentDocsPolicyText, triwikiContextTracking, triwikiContextTrackingText, triwikiStagePolicyText } from './routes.mjs';

const REFLECTION_MEMORY_PATH = '.sneakoscope/memory/q2_facts/post-route-reflection.md';
function reflectionInstructionText(commandPrefix = 'sks') {
  return `Post-route reflection: full routes load \`reflection\` after work/tests and before final; DFix/Answer/Help/Wiki/SKS discovery are exempt. Write reflection.md; record only real misses/gaps, or no_issue_acknowledged. For lessons, append TriWiki claim rows to ${REFLECTION_MEMORY_PATH}. Run "${commandPrefix} wiki refresh" or pack, validate, then pass reflection-gate.json.`;
}

export function normalizeInstallScope(scope = 'global') {
  const value = String(scope || 'global').trim().toLowerCase();
  if (value === 'global' || value === 'project') return value;
  throw new Error(`Invalid install scope: ${scope}. Use "global" or "project".`);
}

export function sksCommandPrefix(scope = 'global', opts = {}) {
  return normalizeInstallScope(scope) === 'project'
    ? 'node ./node_modules/sneakoscope/bin/sks.mjs'
    : (opts.globalCommand || 'sks');
}

function sksHookCommand(commandPrefix, hookName) {
  return `${commandPrefix} hook ${hookName}`;
}

const MANAGED_HOOKS = {
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: null, hookName: 'user-prompt-submit', statusMessage: 'SKS routing prompt and context' }] }],
  PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: null, hookName: 'pre-tool', statusMessage: 'SKS checking tool safety' }] }],
  PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: null, hookName: 'post-tool', statusMessage: 'SKS recording tool evidence' }] }],
  PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: null, hookName: 'permission-request', statusMessage: 'SKS reviewing permission request' }] }],
  Stop: [{ hooks: [{ type: 'command', command: null, hookName: 'stop', statusMessage: 'SKS checking done gate' }] }]
};

function buildManagedHooks(commandPrefix) {
  const hooks = {};
  for (const [eventName, entries] of Object.entries(MANAGED_HOOKS)) {
    hooks[eventName] = entries.map((entry) => ({
      ...('matcher' in entry ? { matcher: entry.matcher } : {}),
      hooks: entry.hooks.map(({ hookName, ...hook }) => ({
        ...hook,
        command: sksHookCommand(commandPrefix, hookName)
      }))
    }));
  }
  return { hooks };
}

export function mergeManagedHooksJson(existingContent, commandPrefix) {
  let root = {};
  try {
    root = existingContent?.trim() ? JSON.parse(existingContent) : {};
    if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};
  } catch {
    root = {};
  }
  const managed = buildManagedHooks(commandPrefix);
  const currentHooks = root.hooks && typeof root.hooks === 'object' && !Array.isArray(root.hooks) ? root.hooks : {};
  const nextHooks = { ...currentHooks };
  for (const [eventName, managedEntries] of Object.entries(managed.hooks)) {
    const existingEntries = Array.isArray(currentHooks[eventName]) ? currentHooks[eventName] : [];
    const preserved = [];
    for (const entry of existingEntries) {
      const stripped = stripSksManagedHookEntry(entry);
      if (stripped) preserved.push(stripped);
    }
    nextHooks[eventName] = [...preserved, ...managedEntries];
  }
  return `${JSON.stringify({ ...root, hooks: nextHooks }, null, 2)}\n`;
}

function stripSksManagedHookEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.hooks)) return entry;
  const next = entry.hooks.filter((hook) => !isSksManagedHook(hook));
  if (next.length === entry.hooks.length) return entry;
  if (!next.length) return null;
  return { ...entry, hooks: next };
}

function isSksManagedHook(hook) {
  if (!hook || typeof hook !== 'object' || Array.isArray(hook)) return false;
  const command = String(hook.command || '');
  return hook.type === 'command' && /\bhook\s+(?:user-prompt-submit|pre-tool|post-tool|permission-request|stop)\b/.test(command) && /\b(?:sks|sneakoscope|sks\.mjs)\b/.test(command);
}

const AGENTS_BLOCK = "\n# Sneakoscope Codex Managed Rules\n\nThis repository uses Sneakoscope Codex.\n\n## Core Rules\n\n- Ralph asks only during prepare. After `decision-contract.json` is sealed, do not ask the user; resolve with the decision ladder.\n- Keep runtime state bounded: raw logs go to files, prompts get tails/summaries, and `sks gc` may prune stale artifacts.\n- Before substantive work, SKS checks npm for a newer package. If newer, ask update-now vs skip-for-this-conversation.\n- Versioning is managed by the SKS pre-commit hook; check `sks versioning status`. Bypass only with `SKS_DISABLE_VERSIONING=1`.\n- Installed harness files are immutable to LLM edits: `.codex/*`, `.agents/skills/`, `.codex/agents/`, `.sneakoscope/*policy*.json`, `AGENTS.md`, and `node_modules/sneakoscope`. The Sneakoscope engine source repo is the only automatic exception.\n- OMX/DCodex conflicts block setup/doctor. Show `sks conflicts prompt`; cleanup requires explicit human approval.\n- Do not stop at a plan when implementation was requested. Finish, verify, or report the hard blocker.\n\n## Routes\n\n- General execution/code-changing prompts default to `$Team`: analysis scouts, TriWiki refresh/validate, read-only debate, consensus, concrete runtime task graph/inboxes, fresh executor team, review, integration, Honest Mode.\n- `$DFix` is only for tiny design/content edits and bypasses the main pipeline. `$Answer`, `$Help`, and `$Wiki` stay lightweight.\n- For code work, surface route/guard/write scopes first, split independent worker scopes when available, and keep parent-owned integration and verification.\n- Design work reads `design.md`; if missing, use `design-system-builder`. Image/logo/raster assets use `imagegen`.\n- Research, AutoResearch, performance, token, accuracy, SEO/GEO, or workflow-improvement claims need experiment/eval evidence. Do not claim live model accuracy without a scored dataset.\n\n## Evidence And Context\n\n- Context7 is required for external libraries, APIs, MCPs, package managers, SDKs, and generated docs: resolve-library-id then query-docs.\n- When tech stack, framework, package, runtime, or deployment-platform versions change, use Context7 or official vendor web docs, record current syntax/security/limit guidance as high-priority TriWiki claims, then refresh and validate before coding.\n- TriWiki is the context-tracking SSOT for long-running missions, Team handoffs, and context-pressure recovery. Read `.sneakoscope/wiki/context-pack.json` before each stage, use `attention.use_first` for compact high-trust recall, hydrate `attention.hydrate_first` from source before risky or lower-trust decisions, refresh after findings or artifact changes, and validate before handoffs/final claims.\n- Source priority: current code/tests/config, decision contract, vgraph, beta, GX render/snapshot metadata, LLM Wiki coordinate index, then model knowledge only if allowed.\n- Final response before stop: summarize what was done, what changed for the user/repo, what was verified, and what remains unverified or blocked; then run Honest Mode. Say what passed and what was not verified.\n\n## Safety\n\n- Database access is high risk. Use read-only inspection by default; live data mutation is out of scope unless a sealed contract allows local or branch-only migration files.\n- Task completion requires relevant tests or justification, zero unsupported critical claims, accepted visual/wiki drift, and final evidence.\n\n## Codex App\n\nUse `.codex/SNEAKOSCOPE.md`, generated `.agents/skills`, `.codex/hooks.json`, and SKS dollar commands (`$sks`, `$team`, `$dfix`, `$qa-loop`, etc.) as the app control surface.\n";

export async function initProject(root, opts = {}) {
  const created = [];
  const installScope = normalizeInstallScope(opts.installScope || 'global');
  const localOnly = Boolean(opts.localOnly);
  const sourceProject = await isHarnessSourceProject(root).catch(() => false);
  const requestedHookCommandPrefix = opts.hookCommandPrefix || sksCommandPrefix(installScope, { globalCommand: opts.globalCommand });
  const hookCommandPrefix = sourceProject ? 'node ./bin/sks.mjs' : requestedHookCommandPrefix;
  const sine = path.join(root, '.sneakoscope');
  if (opts.repair) {
    const repair = await repairSksGeneratedArtifacts(root, { resetState: Boolean(opts.resetState) });
    if (repair.removed.length) created.push(`repaired generated SKS files (${repair.removed.length})`);
  }
  const dirs = [
    '.sneakoscope/state', '.sneakoscope/missions', '.sneakoscope/db', '.sneakoscope/bus', '.sneakoscope/hproof', '.sneakoscope/db', '.sneakoscope/wiki', '.sneakoscope/memory/q0_raw', '.sneakoscope/memory/q1_evidence', '.sneakoscope/memory/q2_facts', '.sneakoscope/memory/q3_tags', '.sneakoscope/memory/q4_bits', '.sneakoscope/gx/cartridges', '.sneakoscope/model/fingerprints', '.sneakoscope/genome/candidates', '.sneakoscope/trajectories/raw', '.sneakoscope/locks', '.sneakoscope/tmp', '.sneakoscope/arenas', '.sneakoscope/reports', '.codex', '.codex/agents', '.agents/skills'
  ];
  for (const d of dirs) await ensureDir(path.join(root, d));
  const localExclude = localOnly ? await ensureLocalOnlyGitExclude(root) : null;
  if (localExclude?.path) created.push(`${path.relative(root, localExclude.path)} local-only excludes`);

  await writeJsonAtomic(path.join(sine, 'manifest.json'), {
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
      project_command: 'node ./node_modules/sneakoscope/bin/sks.mjs'
    },
    codex_app: {
      config: '.codex/config.toml',
      hooks: '.codex/hooks.json',
      skills: '.agents/skills',
      legacy_skills_dir_removed: '.codex/skills',
      agents: '.codex/agents',
      quick_reference: '.codex/SNEAKOSCOPE.md',
      agents_rules: 'AGENTS.md'
    },
    prompt_pipeline: {
      default_enabled: true,
      dollar_commands: DOLLAR_COMMANDS.map((c) => c.command),
      dollar_skill_names: DOLLAR_SKILL_NAMES,
      fast_design_command: '$DFix'
    },
    recommended_skills: RECOMMENDED_SKILLS,
    recommended_mcp_servers: RECOMMENDED_MCP_SERVERS,
    harness_guard: {
      enabled: true,
      policy: '.sneakoscope/harness-guard.json',
      immutable_to_llm_edits: true
    },
    harness_conflicts: {
      block_other_codex_harnesses: true,
      hard_blockers: ['OMX', 'DCodex'],
      cleanup_prompt_command: `${hookCommandPrefix} conflicts prompt`,
      human_approval_required: true
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
      exclude_path: localExclude?.path ? path.relative(root, localExclude.path) : null,
      excluded_patterns: localExclude?.patterns || [],
      versioning: {
        enabled: true,
        hook: 'pre-commit',
        bump: 'patch',
        lock: 'git-common-dir/sks-version.lock',
        state: 'git-common-dir/sks-version-state.json'
      }
    },
    database_safety: 'destructive_db_operations_denied_always',
    gx_renderer: 'deterministic_svg_html'
  });
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
        exclude_path: localExclude?.path ? path.relative(root, localExclude.path) : policy.git?.exclude_path || null,
        excluded_patterns: localExclude?.patterns || policy.git?.excluded_patterns || [],
        versioning: {
          ...(policy.git?.versioning || {}),
          enabled: true,
          hook: 'pre-commit',
          bump: policy.git?.versioning?.bump || 'patch',
          lock: 'git-common-dir/sks-version.lock',
          state: 'git-common-dir/sks-version-state.json'
        }
      },
      versioning: {
        ...(policy.versioning || {}),
        enabled: true,
        bump: policy.versioning?.bump || 'patch',
        trigger: 'git-pre-commit',
        lock_scope: 'git-common-dir',
        managed_files: ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']
      },
      prompt_pipeline: {
        ...(policy.prompt_pipeline || {}),
        default_enabled: true,
        route_without_command: true,
        dollar_commands: DOLLAR_COMMANDS.map((c) => c.command),
        dollar_skill_names: DOLLAR_SKILL_NAMES,
        fast_design_command: '$DFix'
      },
      context7: {
        ...(policy.context7 || {}),
        required_for_external_docs: true,
        default_transport: 'local',
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
        human_approval_required: true
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
      recommended_skills: RECOMMENDED_SKILLS,
      recommended_mcp_servers: RECOMMENDED_MCP_SERVERS
    });
  }

  function defaultPolicy(scope, commandPrefix) {
    return {
      schema_version: 1,
      installation: installPolicy(scope, commandPrefix),
      git: {
        local_only: localOnly,
        exclude_path: localExclude?.path ? path.relative(root, localExclude.path) : null,
        excluded_patterns: localExclude?.patterns || [],
        versioning: {
          enabled: true,
          hook: 'pre-commit',
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
        enabled: true,
        bump: 'patch',
        trigger: 'git-pre-commit',
        lock_scope: 'git-common-dir',
        managed_files: ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'],
        collision_policy: 'lock_then_bump_above_last_seen_version'
      },
      honest_mode: {
        required_before_final: true,
        verify_goal_evidence_tests_gaps: true
      },
      database_safety: DEFAULT_DB_SAFETY_POLICY,
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
        skills: '.agents/skills',
        legacy_skills_dir_removed: '.codex/skills',
        agents: '.codex/agents',
        quick_reference: '.codex/SNEAKOSCOPE.md',
        agents_rules: 'AGENTS.md'
      },
      prompt_pipeline: {
        default_enabled: true,
        route_without_command: true,
        dollar_commands: DOLLAR_COMMANDS.map((c) => c.command),
        dollar_skill_names: DOLLAR_SKILL_NAMES,
        fast_design_command: '$DFix'
      },
      context7: {
        required_for_external_docs: true,
        default_transport: 'local',
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
        cleanup_model: 'gpt-5.5',
        cleanup_reasoning_effort: 'high',
        human_approval_required: true
      },
      recommended_skills: RECOMMENDED_SKILLS,
      recommended_mcp_servers: RECOMMENDED_MCP_SERVERS
    };
  }

  function installPolicy(scope, commandPrefix) {
    return {
      scope,
      default_scope: 'global',
      hook_command_prefix: commandPrefix,
      global_install: 'npm i -g sneakoscope',
      project_install: 'npm i -D sneakoscope && npx sks setup --install-scope project'
    };
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
    await mergeManagedBlock(agentsMdPath, 'Sneakoscope Codex GX MANAGED BLOCK', AGENTS_BLOCK);
    created.push('AGENTS.md managed block');
  }

  await writeTextAtomic(path.join(root, '.codex', 'config.toml'), `[features]\ncodex_hooks = true\nmulti_agent = true\n\n[agents]\nmax_threads = 6\nmax_depth = 1\n\n${context7ConfigToml()}\n[agents.analysis_scout]\ndescription = "Read-only SKS scout."\nconfig_file = "./agents/analysis-scout.toml"\nnickname_candidates = ["Scout", "Mapper"]\n\n[agents.team_consensus]\ndescription = "SKS planning/debate agent."\nconfig_file = "./agents/team-consensus.toml"\nnickname_candidates = ["Consensus", "Atlas"]\n\n[agents.implementation_worker]\ndescription = "SKS bounded implementation worker."\nconfig_file = "./agents/implementation-worker.toml"\nnickname_candidates = ["Builder", "Mason"]\n\n[agents.db_safety_reviewer]\ndescription = "Read-only DB safety reviewer."\nconfig_file = "./agents/db-safety-reviewer.toml"\nnickname_candidates = ["Sentinel", "Ledger"]\n\n[agents.qa_reviewer]\ndescription = "Read-only QA reviewer."\nconfig_file = "./agents/qa-reviewer.toml"\nnickname_candidates = ["Verifier", "Scout"]\n\n[profiles.sks-task-medium]\nmodel = "gpt-5.5"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "medium"\n\n[profiles.sks-logic-high]\nmodel = "gpt-5.5"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "high"\n\n[profiles.sks-research-xhigh]\nmodel = "gpt-5.5"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "xhigh"\n\n[profiles.sks-ralph]\nmodel = "gpt-5.5"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "high"\n\n[profiles.sks-research]\nmodel = "gpt-5.5"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "xhigh"\n\n[profiles.sks-team]\nmodel = "gpt-5.5"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "high"\n\n[profiles.sks-mad-high]
model = "gpt-5.5"
approval_policy = "on-request"
approvals_reviewer = "auto_review"
sandbox_mode = "danger-full-access"
model_reasoning_effort = "high"

[auto_review]
policy = "Deny destructive database operations, credential exfiltration, persistent security weakening, broad file deletion, and writes outside the workspace unless explicitly authorized by the user."

[profiles.sks-default]\nmodel = "gpt-5.5"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "medium"\n`);
  created.push('.codex/config.toml');

  await writeTextAtomic(path.join(root, '.codex', 'SNEAKOSCOPE.md'), codexAppQuickReference(installScope, hookCommandPrefix));
  created.push('.codex/SNEAKOSCOPE.md');

  const hooksPath = path.join(root, '.codex', 'hooks.json');
  await writeTextAtomic(hooksPath, mergeManagedHooksJson(await readText(hooksPath, ''), hookCommandPrefix));
  created.push(`.codex/hooks.json (${installScope})`);

  const skillInstall = await installSkills(root);
  created.push('.agents/skills/*');
  if (skillInstall.removed_codex_skill_mirrors.length) created.push(`.codex/skills generated mirrors removed (${skillInstall.removed_codex_skill_mirrors.length})`);
  await installCodexAgents(root);
  created.push('.codex/agents/*');
  await writeHarnessGuardPolicy(root);
  created.push('.sneakoscope/harness-guard.json');
  const versionHookCommand = sourceProject ? 'node ./bin/sks.mjs' : hookCommandPrefix;
  const versionHook = await installVersionGitHook(root, versionHookCommand);
  if (versionHook.installed) created.push('.git/hooks/pre-commit SKS version guard');
  else created.push(`version guard skipped (${versionHook.reason})`);
  return { created };
}

async function ensureLocalOnlyGitExclude(root) {
  const gitDir = await resolveGitDir(root);
  if (!gitDir) return { path: null, patterns: [] };
  const patterns = ['.sneakoscope/', '.codex/', '.agents/', 'AGENTS.md'];
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

async function resolveGitDir(root) {
  const dotGit = path.join(root, '.git');
  if (!(await exists(dotGit))) return null;
  const text = await readText(dotGit, null);
  if (typeof text === 'string') {
    const match = text.match(/^gitdir:\s*(.+)\s*$/m);
    if (match) return path.resolve(root, match[1]);
  }
  return dotGit;
}

function codexAppQuickReference(scope, commandPrefix) {
  return [
    '# ㅅㅋㅅ',
    `Install scope: \`${scope}\``,
    `Command: \`${commandPrefix} <command>\``,
    'Files: AGENTS.md, .codex/hooks.json, .codex/config.toml, .codex/SNEAKOSCOPE.md, .agents/skills, .codex/agents, .sneakoscope/missions.',
    `Discover: ${commandPrefix} bootstrap; ${commandPrefix} deps check; ${commandPrefix} commands; ${commandPrefix} codex-app check; ${commandPrefix} cmux check; ${commandPrefix} dollar-commands; ${commandPrefix} pipeline status.`,
    'dollar-commands:',
    ...DOLLAR_COMMANDS.map((c) => `- \`${c.command}\`: ${c.route}`),
    `Picker skills: ${DOLLAR_COMMAND_ALIASES.map((x) => x.app_skill).join(', ')}.`,
    'Routing: Answer direct, DFix ultralight, execution routes ask only scope/safety/behavior/acceptance-changing questions before sealing answers.',
    `Full routes write reflection.md, record lessons to ${REFLECTION_MEMORY_PATH}, refresh/pack TriWiki, validate, then final-answer with a user-visible completion summary plus Honest Mode.`,
    `Context Tracking: TriWiki SSOT. Before each route phase read only the latest coordinate+voxel overlay pack at .sneakoscope/wiki/context-pack.json; coordinate-only legacy packs are invalid. Use attention.use_first for compact high-trust recall and hydrate attention.hydrate_first from source before risky/lower-trust decisions. During every stage hydrate low-trust claims from source/hash/RGBA anchors; after changes run ${commandPrefix} wiki refresh or pack; before handoff/final run ${commandPrefix} wiki validate .sneakoscope/wiki/context-pack.json.`,
    stackCurrentDocsPolicyText(commandPrefix),
    `Runtime: open Codex App once, then run ${commandPrefix} bootstrap, ${commandPrefix} deps check, or ${commandPrefix} deps install cmux.`,
    `Guard: generated harness files are immutable outside the engine source repo; check ${commandPrefix} guard check; conflicts use ${commandPrefix} conflicts prompt with human approval.`
  ].join('\n') + '\n';
}

export async function installSkills(root) {
  const skills = {
    'dfix': `---\nname: dfix\ndescription: Ultralight fast design/content fix mode for $DFix or $dfix requests and inferred simple edits such as text color, copy, labels, spacing, or translation.\n---\n\nUse for tiny copy/color/label/spacing/translation edits. List exact micro-edits, inspect only needed files, apply only those edits, and run cheap verification. Bypass broad SKS routing, Ralph, Research, eval, and redesign. Read \`design.md\` for UI work when present; use imagegen for image/logo/raster assets.\n`,
    'answer': `---\nname: answer\ndescription: Answer-only research route for ordinary questions that should not start implementation.\n---\n\nUse for explanations, comparisons, status, facts, source-backed research, or docs guidance. Use repo/TriWiki first for project-local facts; hydrate low-trust claims from source. Browse or use Context7 for current external package/API/framework/MCP docs. End with a concise answer summary plus Honest Mode; do not create missions, subagents, or file edits.\n`,
    'sks': `---\nname: sks\ndescription: General Sneakoscope Codex command route for $SKS or $sks usage, setup, status, and workflow help.\n---\n\nUse local SKS commands: bootstrap, deps, commands, quickstart, codex-app, context7, guard, conflicts, reasoning, wiki, pipeline. Promote code-changing work to Team unless Answer/DFix/Help/Wiki/safety route fits. Surface route/guard/scope, use TriWiki, do not edit installed harness files outside this engine repo, and require human-approved conflict cleanup.\n`,
    'wiki': `---\nname: wiki\ndescription: Dollar-command route for $Wiki TriWiki refresh, pack, validate, and prune commands.\n---\n\nUse for $Wiki or Korean wiki-refresh requests. Refresh/update/갱신: run sks wiki refresh, then validate .sneakoscope/wiki/context-pack.json. Pack: run sks wiki pack, then validate. Prune/clean/정리: use sks wiki refresh --prune, or sks wiki prune --dry-run for inspection. Report claims, anchors, trust, attention.use_first/hydrate_first, validation, and blockers. Do not start ambiguity-gated implementation, subagents, or unrelated work.\n`,
    'team': `---\nname: team\ndescription: SKS Team orchestration for $Team/code work; $From-Chat-IMG is the explicit chat-image alias.\n---\n\nUse for $Team/code work. Ambiguity gate first. Write team-roster.json; team-gate.json needs team_roster_confirmed=true. executor:N means N scouts, N debate voices, then fresh N executors. After consensus, compile team-graph.json, team-runtime-tasks.json, team-decomposition-report.json, and team-inbox/ so worker handoff uses concrete runtime task ids with role/path/domain/lane hints. Refresh/validate TriWiki before debate, implementation, review, and final; consume attention.use_first and hydrate attention.hydrate_first before risky decisions. Log events, close sessions, pass team-session-cleanup.json, then reflection and Honest Mode. Parent integrates/verifies.\n\n${chatCaptureIntakeText()}\n`,
    'from-chat-img': `---\nname: from-chat-img\ndescription: Explicit $From-Chat-IMG Team alias for chat screenshot plus attachment analysis.\n---\n\nUse only for From-Chat-IMG/$From-Chat-IMG. It enters the normal Team pipeline. Treat uploads as chat screenshot plus originals. Use Computer Use/browser visual inspection when available, list requirements first, match regions to attachments with confidence, write ${FROM_CHAT_IMG_COVERAGE_ARTIFACT}, ${FROM_CHAT_IMG_CHECKLIST_ARTIFACT}, ${FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT}, and ${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}, then continue Team gates, review, reflection, and Honest Mode. The ledger must account for every visible customer request, screenshot image region, and separate attachment; ${FROM_CHAT_IMG_CHECKLIST_ARTIFACT} must have a checked item for each request, image-region/attachment match, work item, scoped QA-LOOP, and verification step; ${FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT} stores temporary TriWiki-backed session context with expires_after_sessions=${FROM_CHAT_IMG_TEMP_TRIWIKI_SESSIONS}. ${FROM_CHAT_IMG_QA_LOOP_ARTIFACT} must prove QA-LOOP ran over the exact customer-request work-order range after implementation, with every work item covered, post-fix verification complete, and zero unresolved findings. team-gate.json cannot pass From-Chat-IMG completion until unresolved_items is empty, every checklist box is checked, and scoped_qa_loop_completed=true.\n`,
    'qa-loop': `---\nname: qa-loop\ndescription: $QA-LOOP dogfoods UI/API as human proxy with safety gates, Browser/Computer evidence, safe fixes, rechecks, and a QA report.\n---\n\nUse only $QA-LOOP. Ask scope, target, mutation, login. Credentials are runtime-only; never save secrets. UI needs Browser/Computer evidence or mark unverified. Deployed targets are read-only; destructive removal is forbidden. After answer/run, dogfood real flows, apply safe contract-allowed code/test/docs fixes, recheck, and do not pass qa-gate.json with unresolved findings or without post_fix_verification_complete. Finish qa-ledger, date/version report, gate, completion summary, and Honest Mode.\n`,
    'ralph': `---\nname: ralph\ndescription: Dollar-command route for $Ralph or $ralph mandatory clarification and no-question mission workflows.\n---\n\nUse when the user invokes $Ralph/$ralph or requests a clarification-gated autonomous implementation mission. Prepare with sks ralph prepare, answer/seal required slots when answers are provided, then run only after decision-contract.json exists.\n`,
    'research': `---\nname: research\ndescription: Dollar-command route for $Research or $research frontier discovery workflows.\n---\n\nUse when the user invokes $Research/$research or asks for research, hypotheses, new mechanisms, falsification, or testable predictions. Prefer sks research prepare and sks research run. Do not use for ordinary code edits.\n`,
    'autoresearch': `---\nname: autoresearch\ndescription: Dollar-command route for $AutoResearch or $autoresearch iterative experiment loops.\n---\n\nUse for $AutoResearch, iterative improvement, SEO/GEO, ranking, workflow, benchmark, or experiments. Define program, hypothesis, experiment, metric, keep/discard, falsification, next step, and Honest Mode. Load seo-geo-optimizer for README/npm/GitHub/schema/AI-search work.\n`,
    'db': `---\nname: db\ndescription: Dollar-command route for $DB or $db database and Supabase safety checks.\n---\n\nUse when the user invokes $DB/$db or the task touches SQL, Supabase, Postgres, migrations, Prisma, Drizzle, Knex, MCP database tools, or production data. Run or follow sks db policy, sks db scan, sks db classify, and sks db check. Destructive database operations remain forbidden.\n`,
    'mad-sks': `---\nname: mad-sks\ndescription: Explicit high-risk authorization modifier for $MAD-SKS scoped Supabase MCP DB permission widening.\n---\n\nUse only when the user explicitly invokes $MAD-SKS. It can be combined with another route, such as $MAD-SKS $Team or $DB ... $MAD-SKS; in that case the other command remains the primary workflow and MAD-SKS is only the temporary permission grant. The widened DB permission applies only while the active mission gate is open, and must be deactivated when the task ends. Table deletion remains special: pause, ask the user for explicit confirmation, and abort that operation if no confirmation arrives within about 30 seconds. Do not carry MAD-SKS permission into later prompts or routes.\n`,
    'gx': `---\nname: gx\ndescription: Dollar-command route for $GX or $gx deterministic GX visual context cartridges.\n---\n\nUse when the user invokes $GX/$gx or asks for architecture/context visualization through SKS. Prefer sks gx init, render, validate, drift, and snapshot. vgraph.json remains the source of truth.\n`,
    'help': `---\nname: help\ndescription: Dollar-command route for $Help or $help explaining installed SKS commands and workflows.\n---\n\nUse when the user invokes $Help/$help or asks what commands exist. Prefer concise output from sks commands, sks usage <topic>, sks quickstart, sks aliases, and sks codex-app.\n`,
    'prompt-pipeline': `---\nname: prompt-pipeline\ndescription: Default SKS prompt optimization pipeline for execution prompts; Answer and DFix bypass it.\n---\n\nClassify intent: Answer only for real questions; question-shaped implicit instructions, complaints, and mandatory-policy statements route to Team. DFix handles tiny design/content; code defaults to Team unless safety/research/GX route fits. Infer goal, target, constraints, acceptance, risk, and smallest safe route. Ask only scope/safety/behavior/acceptance-changing questions; otherwise seal inferred answers. Code work surfaces route/guard/scopes, materializes team-roster.json from default or explicit counts before implementation, compiles concrete Team runtime graph/inbox artifacts after consensus, and parent owns integration/tests/Context7/Honest Mode.\n\n${chatCaptureIntakeText()}\n\nDesign: read design.md; if missing use design-system-builder; use imagegen for image/logo/raster. TriWiki context-tracking SSOT: .sneakoscope/wiki/context-pack.json; read only the latest coordinate+voxel overlay pack before every route stage, run sks wiki refresh/pack after changes, validate before handoffs/final.\n`,
    'reasoning-router': `---\nname: reasoning-router\ndescription: Temporary SKS reasoning-effort routing for every command and pipeline route.\n---\n\nmedium: simple copy/color/discovery/setup/mechanical edits. high: logic, safety, architecture, DB, orchestration, refactor, multi-file work. xhigh: research, AutoResearch, falsification, benchmarks, SEO/GEO, open-ended discovery. Routing is temporary; return to default after the gate. Inspect with sks reasoning and sks pipeline status.\n`,
    'pipeline-runner': `---\nname: pipeline-runner\ndescription: Execute SKS dollar-command routes as stateful pipelines with mission artifacts, route gates, Context7 evidence, temporary reasoning routing, reflection, and Honest Mode.\n---\n\nEvery $ command is a route. Use current.json and mission artifacts, temporary reasoning, TriWiki before stages, source hydration, Context7 when required, Team cleanup before reflection, reflection for full routes, and completion summary plus Honest Mode before final. Surface guard/scopes, record evidence, refresh/pack/validate TriWiki, and check sks pipeline status/resume.\n`,
    'context7-docs': `---\nname: context7-docs\ndescription: Enforce Context7 MCP documentation evidence for SKS routes that depend on external libraries, frameworks, APIs, MCPs, package managers, DB SDKs, or generated docs.\n---\n\nWhen required, resolve-library-id, then query-docs for the resolved id. Legacy get-library-docs evidence is accepted. Prefer sks context7 tools/resolve/docs/evidence and finish only after both evidence stages exist. Check setup with sks context7 check.\n`,
    'seo-geo-optimizer': `---\nname: seo-geo-optimizer\ndescription: SEO/GEO support for README, npm, GitHub, keywords, snippets, schema, and AI-search visibility.\n---\n\nUse for SEO/GEO, package metadata, README ranking, snippets, schema, and AI search. Optimize README, package.json, docs, badges, topics, quickstart, examples, command discovery, exact names, keywords, and AI Answer Snapshot. Do not invent metrics; use $AutoResearch unless it is a tiny copy edit.\n`,
    'reflection': `---\nname: reflection\ndescription: Post-route self-review for full SKS routes that records real misses, gaps, and corrective lessons into TriWiki memory.\n---\n\nUse after full route work/tests and before final. DFix, Answer, Help, Wiki, SKS discovery are exempt. Do not invent faults. Write reflection.md; append real lessons to ${REFLECTION_MEMORY_PATH}; refresh/pack, validate context-pack.json, pass reflection-gate.json.\n\n${reflectionInstructionText()}\n`,
    'honest-mode': `---\nname: honest-mode\ndescription: Required final SKS verification pass before claiming a task is complete.\n---\n\nBefore final: include a completion summary explaining what was done, what changed for the user/repo, what was verified, and what remains unverified or blocked. Then restate the goal, compare result to evidence, list tests/commands/inspections, state uncertainty or blockers plainly, and do not claim completion beyond evidence. Full routes must pass reflection-gate.json first. Include concise SKS Honest Mode or 솔직모드 when required.\n`,
    'autoresearch-loop': `---\nname: autoresearch-loop\ndescription: Iterative AutoResearch-style loop for open-ended improvement, discovery, prompt, ranking, SEO/GEO, and workflow-quality tasks.\n---\n\nUse for research, ranking, prompt/workflow improvement, benchmark gains, or repeated refinement. Loop: program, hypothesis, smallest falsifying experiment, metric, keep/discard, falsify, next step. Keep a ledger and do not claim improvement without evidence.\n`,
    'ralph-supervisor': `---\nname: ralph-supervisor\ndescription: Run the Ralph no-question loop after a decision contract is sealed.\n---\n\nYou are the Ralph Supervisor.\n\nRules:\n- Never ask the user during Ralph run.\n- Use decision-contract.json and the decision ladder.\n- Continue until done-gate.json passes or safe scope is completed with explicit limitation.\n- Keep outputs bounded. Write raw logs to files and summarize only tails.\n- Database destructive operations are never allowed.\n- Write progress to .sneakoscope mission files.\n`,
    'ralph-resolver': `---\nname: ralph-resolver\ndescription: Resolve newly discovered ambiguity during Ralph using the sealed decision ladder, without asking the user.\n---\n\nResolve ambiguity in this order: seed contract, explicit answers, approved defaults, AGENTS.md, current code/tests, smallest reversible change, defer optional scope. Never ask the user. If database risk is involved, prefer read-only, no-op, local-only migration file, or safe limitation; never run destructive SQL.\n`,
    'hproof-claim-ledger': `---\nname: hproof-claim-ledger\ndescription: Extract atomic claims and classify support status.\n---\n\nEvery factual statement must become an atomic claim. Unsupported critical claims cannot be used for implementation or final answer. Database claims require DB safety evidence.\n`,
    'hproof-evidence-bind': `---\nname: hproof-evidence-bind\ndescription: Bind claims to code, tests, decision contract, vgraph, beta, wiki, or GX render evidence.\n---\n\nEvidence priority: current code/tests, decision-contract.json, vgraph.json, beta.json, GX snapshot/render metadata, LLM Wiki coordinate index, user prompt. Database claims must respect .sneakoscope/db-safety.json. Wiki claims should carry id, hash, source path, and RGBA/trig coordinate anchors so they can be hydrated instead of treated as unsupported summaries.\n`,
    'db-safety-guard': `---\nname: db-safety-guard\ndescription: Enforce Sneakoscope Codex database safety before using SQL, Supabase MCP, Postgres, Prisma, Drizzle, Knex, or migration commands.\n---\n\nRules:\n- Never run DROP, TRUNCATE, mass DELETE/UPDATE, db reset, db push, project deletion, branch reset/merge/delete, or RLS-disabling operations.\n- Supabase MCP must be read-only and project-scoped by default.\n- Live writes through execute_sql are blocked; use migration files and only local/preview branches if explicitly allowed.\n- Production writes are forbidden.\n- If unsure, read-only only.\n`,
    'gx-visual-generate': `---\nname: gx-visual-generate\ndescription: Render a deterministic SVG/HTML visual sheet from vgraph.json and beta.json.\n---\n\nUse sks gx render. vgraph.json is source of truth; renders embed source hash and RGBA wiki anchors.\n`,
    'gx-visual-read': `---\nname: gx-visual-read\ndescription: Read a Sneakoscope Codex deterministic visual sheet and produce context notes.\n---\n\nExtract nodes, edges, invariants, tests, risks, uncertainties, and RGBA anchors from source/render/snapshot. Do not infer hidden nodes.\n`,
    'gx-visual-validate': `---\nname: gx-visual-validate\ndescription: Validate render metadata against vgraph.json and beta.json.\n---\n\nRun sks gx validate and drift; fail stale or incomplete hashes, nodes, edges, invariants, or anchors.\n`,
    'turbo-context-pack': `---\nname: turbo-context-pack\ndescription: Build ultra-low-token context packet with Q4 bits, Q3 tags, top-K claims, and minimal evidence.\n---\n\nDefault to Q4/Q3 plus TriWiki RGBA anchors and attention.use_first. Add Q2/Q1 only when needed or when attention.hydrate_first says source hydration is required. Keep id, hash, path, and coordinate tuple for hydration.\n`,
    'research-discovery': `---\nname: research-discovery\ndescription: Run SKS Research Mode for frontier-style research, hypotheses, novelty ledgers, falsification, and experiments.\n---\n\nFrame criteria, map assumptions, generate hypotheses, falsify, keep surviving insights, and record novelty/confidence/falsifiers/next experiments. Do not overclaim.\n`,
    'performance-evaluator': `---\nname: performance-evaluator\ndescription: Evaluate SKS performance, token-saving, accuracy-proxy, context-compression, or workflow improvements.\n---\n\nUse sks eval run/compare before claims. Report token_savings_pct, accuracy_delta/proxy, required_recall, support, and meaningful_improvement.\n`,
    'imagegen': `---\nname: imagegen\ndescription: Required bridge to Codex image generation for logos, image assets, raster visuals, and image edits.\n---\n\nUse for generated or edited image assets: logo, product image, illustration, sprite, mockup, texture, cutout, or bitmap. Do not substitute placeholder SVG/HTML/CSS; follow design.md when relevant.\n`,
    'design-system-builder': `---\nname: design-system-builder\ndescription: Create design.md from docs/Design-Sys-Prompt.md when UI/UX work has no design system.\n---\n\nWhen \`design.md\` is missing, read docs/Design-Sys-Prompt.md, inspect product/UI context, use the plan tool for ambiguity plus default font recommendation, then create tokens, components, states, imagery, accessibility, and verification rules. Use imagegen for assets.\n`,
    'design-ui-editor': `---\nname: design-ui-editor\ndescription: Edit UI/UX using design.md and design-artifact-expert.\n---\n\nRead \`design.md\`, inspect relevant UI/assets/tests, apply the smallest design-system-conformant change, use imagegen for image/logo/raster assets, and verify render quality. If missing, use design-system-builder first.\n`,
    'design-artifact-expert': `---\nname: design-artifact-expert\ndescription: Create or revise high-fidelity HTML, UI, prototype, deck-like, or visual design artifacts with rendered verification.\n---\n\nUse for design/UI/prototype/HTML visual work. Read design.md when present, build the usable artifact first, preserve state, verify overlap/readability/responsiveness, and use imagegen for required assets.\n`
  };
  for (const [name, content] of Object.entries(skills)) {
    const dir = path.join(root, '.agents', 'skills', name);
    const skillContent = enrichSkillContent(name, content);
    await ensureDir(dir);
    await writeTextAtomic(path.join(dir, 'SKILL.md'), `${skillContent.trim()}\n`);
    await writeSkillMetadata(dir, name);
  }
  const skillNames = Object.keys(skills);
  return {
    installed_skills: skillNames,
    removed_agent_skill_aliases: await removeGeneratedAgentSkillAliases(root, skillNames),
    removed_codex_skill_mirrors: await removeGeneratedCodexSkillMirrors(root, skillNames)
  };
}

function enrichSkillContent(name, content) {
  if (!['sks', 'answer', 'wiki', 'team', 'qa-loop', 'ralph', 'research', 'autoresearch', 'db', 'gx', 'reflection', 'prompt-pipeline', 'pipeline-runner', 'context7-docs', 'turbo-context-pack', 'hproof-evidence-bind'].includes(name)) return content;
  const text = String(content || '').trimEnd();
  if (text.includes('TriWiki context-tracking SSOT')) return text;
  return `${text}

Context tracking:
- Ask only ambiguity that can change scope, safety, behavior, or acceptance; infer the rest from TriWiki/current code and seal answers before execution.
- TriWiki SSOT: .sneakoscope/wiki/context-pack.json. Use only the latest coordinate+voxel overlay pack; coordinate-only legacy packs are invalid and must be refreshed before use. Use attention.use_first for compact high-trust recall and hydrate attention.hydrate_first from source before risky/lower-trust decisions. Refresh/pack after findings or artifact changes; validate before handoffs/final claims.
- ${stackCurrentDocsPolicyText()}
- Keep non-selected claims hydratable by id, hash, source path, and RGBA/trig coordinate. Hydrate low-trust claims before relying on them.
- Hook output is limited; use mission files, team events, or normal updates for live detail.
`;
}

async function writeSkillMetadata(dir, name) {
  const effort = ['research', 'autoresearch', 'research-discovery', 'autoresearch-loop'].includes(name)
    ? 'xhigh'
    : (['dfix', 'sks', 'help'].includes(name) ? 'medium' : 'high');
  await ensureDir(path.join(dir, 'agents'));
  await writeTextAtomic(path.join(dir, 'agents', 'openai.yaml'), `name: ${name}\nmodel_reasoning_effort: ${effort}\nrouting: temporary\nreturn_to_default_after_route: true\n`);
}

async function removeGeneratedCodexSkillMirrors(root, skillNames) {
  const legacyRoot = path.join(root, '.codex', 'skills');
  if (!(await exists(legacyRoot))) return [];
  const removed = [];
  const names = Array.from(new Set([...skillNames, ...DOLLAR_COMMANDS.map((c) => c.command.slice(1))]));
  for (const name of names) {
    const dir = path.join(legacyRoot, name);
    const skillPath = path.join(dir, 'SKILL.md');
    const text = await readText(skillPath, null);
    if (!isGeneratedSksLegacySkill(text, name)) continue;
    await fsp.rm(dir, { recursive: true, force: true });
    removed.push(path.relative(root, dir));
  }
  await removeDirIfEmpty(legacyRoot);
  await removeDirIfEmpty(path.join(root, '.agents'));
  return removed;
}

async function removeGeneratedAgentSkillAliases(root, skillNames) {
  const current = new Set(skillNames);
  const obsolete = ['agent-team', 'qaloop', 'wiki-refresh', 'wikirefresh'];
  const removed = [];
  for (const name of obsolete) {
    if (current.has(name)) continue;
    const dir = path.join(root, '.agents', 'skills', name);
    const skillPath = path.join(dir, 'SKILL.md');
    const text = await readText(skillPath, null);
    if (!isGeneratedSksAgentSkill(text, name)) continue;
    await fsp.rm(dir, { recursive: true, force: true });
    removed.push(path.relative(root, dir));
  }
  return removed;
}

function isGeneratedSksAgentSkill(text, name) {
  if (!text) return false;
  const s = String(text);
  if (!new RegExp(`name:\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(s)) return false;
  if (/\bnot generated by SKS\b/i.test(s)) return false;
  return /Sneakoscope generated|Fallback Codex App picker alias|Codex App picker alias for|Dollar-command route generated by SKS/i.test(s);
}

function isGeneratedSksLegacySkill(text, name) {
  if (typeof text !== 'string') return false;
  return text.startsWith('---') && new RegExp(`^name:\\s*${escapeRegExp(name)}\\s*$`, 'm').test(text);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function removeDirIfEmpty(dir) {
  try {
    const entries = await fsp.readdir(dir);
    if (!entries.length) await fsp.rmdir(dir);
  } catch {}
}

async function installCodexAgents(root) {
  const agents = {
    'analysis-scout.toml': `name = "analysis_scout"\ndescription = "Read-only Team analysis scout. Maps one independent repo/docs/tests/API/risk/user-friction slice and returns TriWiki-ready source-backed findings before debate starts."\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "high"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nYou are an SKS Team analysis scout.\nDo not edit files.\nOwn exactly one investigation slice assigned by the parent orchestrator.\nMap relevant source files, docs, tests, APIs, DB or safety risks, UX friction, and likely implementation boundaries.\nReturn concise source-backed claims suitable for team-analysis.md and TriWiki ingestion: claim, source path, evidence hash or quoted anchor, risk, confidence, and recommended implementation slice.\nDo not debate the final plan and do not implement code.\nAlso return a concise LIVE_EVENT line that the parent can record with sks team event.\n"""\n`,
    'team-consensus.toml': `name = "team_consensus"\ndescription = "Planning and debate specialist for SKS Team mode. Maps options, constraints, role-persona risks, and proposes the agreed objective before implementation starts."\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "high"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nYou are the SKS Team consensus specialist.\nDo not edit files.\nMap the affected code paths, viable approaches, constraints, risks, and acceptance criteria.\nRun the debate as role-persona synthesis: final users are low-context, self-interested, stubborn, and inconvenience-averse; executors are capable developers; reviewers are strict.\nArgue for the smallest coherent objective that can be handed to a fresh executor_N development team.\nReturn: recommended objective, rejected alternatives, implementation slices, required reviewers, user-friction risks, and unresolved risks.\nAlso return a concise LIVE_EVENT line that the parent can record with sks team event.\n"""\n`,
    'implementation-worker.toml': `name = "implementation_worker"\ndescription = "Implementation specialist for SKS Team mode. Owns one bounded write set and coordinates with other executor_N workers."\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "high"\nsandbox_mode = "workspace-write"\ndeveloper_instructions = """\nYou are an SKS Team executor/developer in the fresh development bundle.\nYou are not alone in the codebase. Other executor_N workers may be editing disjoint files.\nOnly edit the files or module slice assigned to you.\nDo not revert or overwrite edits made by others.\nRead local patterns first, make the smallest correct change, avoid adding user friction, run focused verification for your slice, and report changed paths plus evidence.\nRespect all SKS hooks, DB safety rules, no-question Ralph rules, and H-Proof completion gates.\nAlso return concise LIVE_EVENT lines for started, blocked, changed files, verification, and final result so the parent can record them.\n"""\n`,
    'db-safety-reviewer.toml': `name = "db_safety_reviewer"\ndescription = "Read-only database safety reviewer for SQL, migrations, Supabase, RLS, destructive-operation risk, and rollback safety."\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "high"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nYou are a database safety reviewer.\nNever modify files or execute destructive commands.\nReview migrations, SQL, Supabase RLS, transaction boundaries, rollback safety, and MCP database tool usage.\nBlock DROP, TRUNCATE, mass DELETE/UPDATE, db reset, db push, project deletion, branch reset/merge/delete, RLS disabling, and live execute_sql writes.\nReturn concrete risks, exact file references, and required fixes.\nAlso return a concise LIVE_EVENT line that the parent can record with sks team event.\n"""\n`,
    'qa-reviewer.toml': `name = "qa_reviewer"\ndescription = "Strict read-only verification reviewer for correctness, regressions, missing tests, user friction, and final evidence."\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "high"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nYou are an SKS Team strict reviewer.\nDo not edit files.\nReview correctness, edge cases, regression risk, missing tests, unsupported claims, and whether the final evidence proves the claimed outcome.\nAlso evaluate practical friction from the viewpoint of a stubborn, low-context final user who dislikes inconvenience.\nPrioritize concrete findings with file references and focused verification suggestions.\nReturn no findings if the implementation is sound, and clearly list residual test gaps.\nAlso return a concise LIVE_EVENT line that the parent can record with sks team event.\n"""\n`
  };
  const dir = path.join(root, '.codex', 'agents');
  await ensureDir(dir);
  for (const [file, content] of Object.entries(agents)) {
    await writeTextAtomic(path.join(dir, file), content);
  }
}
