import path from 'node:path';
import fsp from 'node:fs/promises';
import { ensureDir, readJson, readText, writeJsonAtomic, writeTextAtomic, mergeManagedBlock, nowIso, PACKAGE_VERSION, exists } from './fsx.mjs';
import { DEFAULT_RETENTION_POLICY } from './retention.mjs';
import { DEFAULT_DB_SAFETY_POLICY } from './db-safety.mjs';
import { isHarnessSourceProject, writeHarnessGuardPolicy } from './harness-guard.mjs';
import { repairSksGeneratedArtifacts } from './harness-conflicts.mjs';
import { installVersionGitHook } from './version-manager.mjs';
import { DOLLAR_COMMANDS, DOLLAR_COMMAND_ALIASES, DOLLAR_SKILL_NAMES, RECOMMENDED_MCP_SERVERS, RECOMMENDED_SKILLS, context7ConfigToml, triwikiContextTracking, triwikiContextTrackingText, triwikiStagePolicyText } from './routes.mjs';

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

const AGENTS_BLOCK = `
# Sneakoscope Codex Managed Rules

This repository uses Sneakoscope Codex.

## Ralph No-Question Rule

Ralph may ask questions only during prepare. After decision-contract.json is sealed and Ralph run starts, the assistant must not ask the user questions, request confirmation, or present choices. Resolve using the decision ladder.

## Performance and Retention

Sneakoscope Codex keeps runtime state bounded. Do not write large raw logs into prompts. Store raw outputs in files, keep only tails/summaries in JSON, and allow sks gc to remove old arenas, temp files, and stale mission logs.

## Update Check Before Work

Before any substantive work, SKS hooks check whether the installed SKS package is behind the latest published package. If an update is available, ask the user to choose between updating now and skipping the update for this conversation only. If the user skips, continue the current conversation without asking again, but check again in the next conversation. If the user accepts, update SKS, rerun setup/doctor, then continue the original task.

## Project Versioning

SKS manages the worker project's package version through a managed Git pre-commit hook. Every commit in a project with \`package.json\` gets a patch version bump in the same commit, with \`package-lock.json\` and \`npm-shrinkwrap.json\` kept in sync when present. The version guard uses a lock in the Git common directory so parallel workers or multiple worktrees do not reuse the same version. Check with \`sks versioning status\`; bypass only for exceptional maintenance with \`SKS_DISABLE_VERSIONING=1\`.

## Harness Self-Protection

After setup, installed Sneakoscope harness control files are immutable to LLM tool edits. Do not edit \`.codex/hooks.json\`, \`.codex/config.toml\`, \`.codex/SNEAKOSCOPE.md\`, \`.agents/skills/\`, \`.codex/agents/\`, \`.sneakoscope/manifest.json\`, \`.sneakoscope/policy.json\`, \`.sneakoscope/db-safety.json\`, \`.sneakoscope/harness-guard.json\`, \`AGENTS.md\`, or \`node_modules/sneakoscope\` from the agent. SKS hooks block direct writes and SKS maintenance commands from LLM tool calls. The only automatic exception is the Sneakoscope engine source repository itself, detected by \`package.json\` name \`sneakoscope\` plus \`bin/sks.mjs\` and \`src/core/*\`.

## Other Harness Conflict Gate

Before installing, setting up, or repairing SKS, check for incompatible Codex harnesses such as OMX or DCodex. OMX is a hard blocker. If another harness is found, SKS setup/doctor must stop and show \`sks conflicts prompt\`. Cleanup requires explicit human approval and should be performed by an LLM operator in Codex App using GPT-5.5 high mode. If the human does not approve cleanup, SKS cannot be installed in that environment.

## Honest Mode Completion

Do not stop at a plan when implementation was requested. Continue until the stated goal is actually handled or a hard blocker is explicitly reported. Before the final answer, run SKS Honest Mode: re-check the goal, evidence, tests, risk boundaries, and remaining gaps. The final answer must be honest about what passed, what was not verified, and whether the goal is genuinely complete.

## Evaluation

When a task claims performance, token, accuracy, context-compression, or workflow improvement, produce evidence with sks eval run or sks eval compare. Do not claim live model accuracy unless the run used an explicitly scored task dataset; otherwise call it an evidence-weighted accuracy proxy.

## Research Mode

When the user asks for research, new discoveries, hypothesis generation, frontier exploration, or deep investigation, use SKS Research Mode. Research must produce candidate insights, falsification attempts, a novelty ledger, and testable next experiments. Do not present a breakthrough claim unless it is explicitly marked with evidence, confidence, falsifiers, and uncertainty.

## AutoResearch Loop

For open-ended improvement, discovery, prompt, evaluation, ranking, SEO/GEO, or workflow-quality tasks, use the SKS AutoResearch loop inspired by iterative hypothesis search: define a program, choose a metric, run the smallest useful experiment, keep or discard the result, record the ledger, falsify the best candidate, and repeat within budget. Do not claim an improvement without evidence.

## Team Orchestration

When the user invokes Team mode, \`$Team\`, or a general implementation/code-changing prompt, default to Codex multi-agent orchestration: parallel analysis scouts, TriWiki refresh, read-only debate, then a fresh parallel executor team. Answer, DFix, Help, Wiki maintenance, and safety-specific routes are lightweight exceptions. TriWiki is not one-time setup: before each stage read \`.sneakoscope/wiki/context-pack.json\`; hydrate low-trust claims from source/hash/RGBA anchors; refresh or pack after scout, debate, consensus, implementation, review, or blockers; validate before handoff/final claims. Role counts like \`executor:5 reviewer:2 user:1\` create exactly N \`analysis_scout_N\`, N debate participants, and a separate N-person \`executor_N\` team. Scouts split repo, docs, tests, API, DB-risk, UX-friction, and implementation surfaces. Debate is read-only and includes stubborn users, capable executors, strict reviewers, and planners. Close debate agents once the objective is sealed, refresh/validate TriWiki, then launch disjoint executor slices in parallel. The parent orchestrates, integrates, verifies, and records useful scout/debate/handoff/review lines with \`sks team event <mission-id|latest> --agent <name> --phase <phase> --message "..."\`. Do not let subagents bypass SKS hooks or destructive DB safety.

## Code-Changing Execution

For code-changing work, first surface SKS route, guard, write scopes, and verification. General implementation prompts route to Team by default, then split independent write scopes across worker subagents. The parent assigns ownership, keeps urgent blockers local, integrates, and verifies. Subagents must not bypass DB safety, harness guard, Ralph, Context7, H-Proof, or Honest Mode.

## Design Execution

When creating or editing UI/UX, always look for \`design.md\` first. If it does not exist, use the local design-system-builder skill to create it from \`docs/Design-Sys-Prompt.md\`; that flow must use the Codex plan tool to remove ambiguity and recommend a default font choice before implementation. When \`design.md\` exists, use the design-ui-editor skill plus the local design artifact skill, follow the design guidelines exactly, and verify the rendered result. Any image, logo, raster, or bitmap asset generation must use the Codex \`imagegen\` skill.

## Prompt Optimization Pipeline

Every prompt starts with intent classification. Answer-only uses TriWiki/web/Context7 when useful plus Honest Mode, then direct reply. DFix uses its ultralight task list. General execution/code-changing prompts default to Team unless a more specific safety/research/DB/GX route applies. Extract intent, target surface, constraints, acceptance criteria, risks, and the smallest safe path before acting.

## Intent Inference And Clarification

The default stance is strong intent inference: when the user speaks roughly, infer the likely goal from local context, repo conventions, current route state, and prior artifacts. Do not ask lazy discovery questions. However, ambiguity removal is mandatory when a missing answer can change the target, scope, safety boundary, data risk, irreversible operation, user-facing behavior, or acceptance criteria. Ask the smallest set of concrete questions, then seal the inferred contract before implementation.

## Reasoning Effort Routing

Use temporary route-specific reasoning only. Simple fulfillment uses medium, any logical/safety/orchestration work uses high, and research or experiment loops use xhigh. Do not persist profile changes; return to the default or user-selected profile when the route gate passes.

## Context7 MCP Requirement

When work depends on external libraries, frameworks, APIs, MCPs, package managers, DB SDKs, or generated documentation, use Context7 MCP before completion. The required evidence flow is resolve-library-id followed by query-docs (or legacy get-library-docs). SKS PostToolUse records these calls in context7-evidence.jsonl, and Stop hooks block required routes until evidence exists. Pure command discovery and simple $DFix copy/color/spacing edits do not require Context7.

## LLM Wiki Continuity

TriWiki is the context-tracking SSOT for long-running missions, Team handoffs, and context-pressure recovery. It is anchor-first, not lossy-summary-first. Use relevant TriWiki context at every work stage, not only at the beginning: read the pack before a stage, hydrate low-trust claims during the stage, refresh after new findings or artifact changes, and validate before handoffs/final claims. Important claims, visual nodes, policy facts, and evidence pointers should receive deterministic RGBA wiki coordinates: R maps to domain angle, G maps to layer radius through sine, B maps to phase angle, and A maps to concentration/confidence. Use those trigonometric coordinates to preserve stable retrieval anchors across turns. Selected claims may be pasted as text, but non-selected claims must remain hydratable through id, hash, source path, and RGBA coordinate anchors instead of disappearing from the workflow. Refresh with \`sks wiki refresh\` or \`sks wiki pack\` and validate with \`sks wiki validate .sneakoscope/wiki/context-pack.json\` whenever route continuity, stage context, source evidence, or handoff context changes.

## Dollar Commands

Codex App users may invoke local SKS modes with skill-style dollar commands. \`$DFix\` is the fast design/content fix route for small changes such as text color, copy edits, label changes, spacing tweaks, or translating visible text. \`$DFix\` bypasses the general SKS prompt pipeline and runs an ultralight task-list path: list the exact micro-edits, inspect only needed files, apply only those edits, and run only cheap verification when useful.

## Codex App Usage

When this repository is opened in Codex App, use the local Sneakoscope files as the app control surface. Read \`.codex/SNEAKOSCOPE.md\` for the quick reference, load project skills from \`.agents/skills\` when applicable, and use the generated \`.codex/hooks.json\` hooks for DB safety, no-question Ralph runs, retention, and done-gate enforcement.

## Source Priority

1. Current code, tests, config
2. decision-contract.json
3. vgraph.json
4. beta.json
5. GX render/snapshot metadata
6. LLM Wiki coordinate index
7. model knowledge only if explicitly allowed

## Database Safety

Sneakoscope Codex treats database access as high risk. Destructive database operations are never allowed: DROP, TRUNCATE, mass DELETE/UPDATE, reset, push, repair, project deletion, branch reset/merge/delete, RLS disabling, broad grants/revokes, and any operation that could erase or overwrite data. Supabase/Postgres MCP should be read-only and project-scoped by default. Live database writes must not be performed through direct execute_sql; schema changes must be migration-file based and allowed only for local or preview/branch environments by the sealed contract.

## Done Means

A task is not done until relevant tests are run or justified, unsupported critical claims are zero, database safety violations are zero, visual/wiki drift is low or explicitly accepted, and final output includes evidence.
`;

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
      default_pack: triwikiContextTracking().default_pack,
      context_tracking: triwikiContextTracking(),
      channel_map: { r: 'domainAngle', g: 'layerRadius', b: 'phase', a: 'concentration' },
      continuity_model: 'selected_text_plus_hydratable_rgba_trig_anchors'
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
        default_pack: triwikiContextTracking().default_pack,
        context_tracking: triwikiContextTracking(),
        compression_policy: 'preserve_ids_hashes_sources_rgba_coordinates_for_hydration'
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
          min_token_savings_pct: 0.25,
          min_accuracy_delta: 0.03,
          min_required_recall: 0.95
        }
      },
      llm_wiki: {
        ssot: 'triwiki',
        coordinate_schema: 'sks.wiki-coordinate.v1',
        default_pack: '.sneakoscope/wiki/context-pack.json',
        context_tracking: triwikiContextTracking(),
        compression_policy: 'preserve_ids_hashes_sources_rgba_coordinates_for_hydration',
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

  await writeTextAtomic(path.join(root, '.codex', 'config.toml'), `[features]\ncodex_hooks = true\nmulti_agent = true\n\n[agents]\nmax_threads = 6\nmax_depth = 1\n\n${context7ConfigToml()}\n[agents.analysis_scout]\ndescription = "Read-only analysis scout for SKS Team mode. Maps one independent repo/docs/tests/API/risk slice and returns TriWiki-ready source-backed findings before debate starts."\nconfig_file = "./agents/analysis-scout.toml"\nnickname_candidates = ["Scout", "Mapper"]\n\n[agents.team_consensus]\ndescription = "Planning and debate agent for SKS Team mode. Maps options, constraints, risks, and proposes the agreed objective before implementation starts."\nconfig_file = "./agents/team-consensus.toml"\nnickname_candidates = ["Consensus", "Atlas"]\n\n[agents.implementation_worker]\ndescription = "Implementation worker for SKS Team mode. Owns a clearly bounded write set and coordinates with other workers without reverting their edits."\nconfig_file = "./agents/implementation-worker.toml"\nnickname_candidates = ["Builder", "Mason"]\n\n[agents.db_safety_reviewer]\ndescription = "Read-only database safety reviewer for SQL, migrations, RLS, destructive-operation risk, and rollback safety."\nconfig_file = "./agents/db-safety-reviewer.toml"\nnickname_candidates = ["Sentinel", "Ledger"]\n\n[agents.qa_reviewer]\ndescription = "Read-only verification reviewer for correctness, tests, regressions, and missing evidence."\nconfig_file = "./agents/qa-reviewer.toml"\nnickname_candidates = ["Verifier", "Scout"]\n\n[profiles.sks-task-medium]\nmodel = "gpt-5.5"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "medium"\n\n[profiles.sks-logic-high]\nmodel = "gpt-5.5"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "high"\n\n[profiles.sks-research-xhigh]\nmodel = "gpt-5.5"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "xhigh"\n\n[profiles.sks-ralph]\nmodel = "gpt-5.5"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "high"\n\n[profiles.sks-research]\nmodel = "gpt-5.5"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "xhigh"\n\n[profiles.sks-team]\nmodel = "gpt-5.5"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "high"\n\n[profiles.sks-default]\nmodel = "gpt-5.5"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "medium"\n`);
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
  return `# ㅅㅋㅅ

Sneakoscope Codex for Codex App

This project has been initialized for both the SKS CLI and Codex App.

## App Control Surface

- Rules: \`AGENTS.md\`
- Hooks: \`.codex/hooks.json\`
- Profiles: \`.codex/config.toml\`
- App skills: \`.agents/skills/\`
- App agents: \`.codex/agents/\`
- Mission state: \`.sneakoscope/missions/\`
- Current state: \`.sneakoscope/state/current.json\`

## Installed Command

\`\`\`bash
${commandPrefix} <command>
${commandPrefix} --auto-review --high
\`\`\`

Install scope: \`${scope}\`

## Discovery Commands

\`\`\`bash
${commandPrefix} help
${commandPrefix} commands
${commandPrefix} usage team
${commandPrefix} quickstart
${commandPrefix} codex-app
${commandPrefix} codex-app check
${commandPrefix} tmux check
${commandPrefix} auto-review status
${commandPrefix} dollar-commands
${commandPrefix} context7 check
${commandPrefix} pipeline status
${commandPrefix} pipeline answer latest answers.json
${commandPrefix} guard check
${commandPrefix} reasoning "simple copy edit"
${commandPrefix} wiki refresh
${commandPrefix} wiki validate .sneakoscope/wiki/context-pack.json
\`\`\`

## Dollar Commands

${DOLLAR_COMMANDS.map((c) => `- \`${c.command}\`: ${c.route}. ${c.description}`).join('\n')}

Codex App skills live in \`.agents/skills\` with picker names: \`${DOLLAR_COMMAND_ALIASES.map((x) => x.app_skill).join('`, `')}\`. Routing is case-insensitive for canonical commands.

CLI tmux parity requires Codex App opened once for first-party MCP/plugin tools. \`${commandPrefix} setup\` installs \`@openai/codex\` when missing and checks tmux. Verify with \`${commandPrefix} codex-app check\` and \`${commandPrefix} tmux check\`; open with \`${commandPrefix}\` or \`${commandPrefix} --auto-review --high\`.

Prompt routing infers the lightest route. Answer is direct; DFix is ultralight; execution routes ask mandatory ambiguity questions, then seal with \`${commandPrefix} pipeline answer latest answers.json\`.

Design work reads \`design.md\`; if missing, \`design-system-builder\` creates it from \`docs/Design-Sys-Prompt.md\` with plan-tool questions and a default font decision. Existing designs use \`design-ui-editor\` plus \`design-artifact-expert\`. Image/logo/raster assets must use Codex \`imagegen\`.

## Context Tracking

- ${triwikiContextTrackingText(commandPrefix)}
- ${triwikiStagePolicyText(commandPrefix).replace(/\n/g, '\n- ')}
- Long-running handoffs use TriWiki context during every stage.

## Code-Changing Execution

- Surface route, guard, write scopes, and verification before edits.
- Split independent code work into worker subagents; parent integrates and verifies.
- Keep blockers local and respect SKS gates.

## Codex Hooks

- Hooks inject route/status context, block unsafe turns, and expose SKS guard/done-gate status.
- For live Team detail, use \`sks team event\` and mission files.

## Harness Guard

- Installed harness files are immutable after setup except in the Sneakoscope engine source repo.
- Check \`${commandPrefix} guard check\`. Harness conflicts block setup/doctor until human-approved cleanup via \`${commandPrefix} conflicts prompt\`.

## Context7 MCP

- \`.codex/config.toml\` includes Context7 MCP.
- Required docs/API routes need resolve plus query-docs evidence.
- Check: \`${commandPrefix} context7 check\`, \`${commandPrefix} context7 tools\`, \`${commandPrefix} context7 docs <library|/org/project>\`.

## Recommended Skills

- \`reasoning-router\`, \`context7-docs\`, \`seo-geo-optimizer\`, \`autoresearch-loop\`, \`performance-evaluator\`

## Update And Honest Mode

- Before work: hooks check for a newer \`sneakoscope\` package and ask whether to update now or skip for this conversation only.
- Before final: hooks require SKS Honest Mode, a short verification pass covering goal completion, evidence/tests, and remaining gaps.
- Reasoning route is temporary: simple fulfillment uses medium, logical work uses high, and research/experiments use xhigh before returning to the default profile.

## Common App Prompts

- "$SKS show workflows."
- "$DB check this migration safely."
- "$Help show commands."
- "Use SKS DB safety before touching database or Supabase files."

## CLI Bridge

Codex App can call the same project-local control surface through terminal commands:

\`\`\`bash
${commandPrefix} setup
${commandPrefix} doctor
${commandPrefix} codex-app check
${commandPrefix} tmux check
${commandPrefix} pipeline status
${commandPrefix} guard check
${commandPrefix} team "task"
${commandPrefix} team watch latest
${commandPrefix} wiki refresh
${commandPrefix} wiki validate .sneakoscope/wiki/context-pack.json
\`\`\`

Hooks route Codex App events through SKS guards; status messages show checks, while live detail belongs in mission files or normal assistant updates.
`;
}

async function installSkills(root) {
  const skills = {
    'dfix': `---\nname: dfix\ndescription: Ultralight fast design/content fix mode for $DFix or $dfix requests and inferred simple edits such as text color, copy, labels, spacing, or translation.\n---\n\nYou are running SKS DFix mode.\n\nPurpose:\n- Bypass the general SKS prompt pipeline for small design/content requests.\n- Convert the request into a tiny task list, then execute only those tasks.\n- Use for requests like 글자 색 바꿔줘, 내용을 영어로 바꿔줘, button label 수정, spacing 조정, copy replacement, simple style tweaks.\n\nUltralight loop:\n1. List the exact micro-edits implied by the request.\n2. Inspect only the files needed to locate those targets.\n3. Apply only the listed edits.\n4. Run only cheap verification when useful.\n5. Final response should be short: what changed and any verification.\n\nRules:\n- Do not enter the general prompt pipeline, mission workflow, ambiguity gate, TriWiki refresh, Context7 routing, subagent orchestration, Ralph, Research, eval, or broad redesign.\n- Do not ask for more requirements when the target can be inferred from local context.\n- For UI/UX micro-edits, read \`design.md\` when present and preserve the existing design system and component patterns.\n- If \`design.md\` is missing and the change requires design judgment instead of a tiny mechanical edit, reroute to design-system-builder before editing.\n- Use imagegen for any image/logo/raster asset.\n`,
    'answer': `---\nname: answer\ndescription: Answer-only research route for ordinary questions that should not start implementation.\n---\n\nUse when the user is asking for an explanation, comparison, status, facts, source-backed research, or documentation guidance rather than asking you to change files or run work.\n\nEvidence flow:\n1. Use current repo files and TriWiki first when the answer is project-local.\n2. Hydrate low-trust wiki claims from source paths before relying on them.\n3. Use web search for current, external, or uncertain facts when browsing is available or the user asks for latest/source-backed information.\n4. Use Context7 resolve-library-id plus query-docs when the answer depends on package, API, framework, SDK, MCP, or generated documentation behavior.\n5. End with Honest Mode fact-checking: separate verified facts, source-backed inferences, and uncertainty.\n\nRules:\n- Do not create route mission state, ambiguity-gate questions, subagents, Team handoffs, Ralph, Research loops, eval loops, or file edits.\n- If the prompt turns out to request implementation, state the reroute and use the proper execution pipeline.\n`,
    'sks': `---\nname: sks\ndescription: General Sneakoscope Codex command route for $SKS or $sks usage, setup, status, and workflow help.\n---\n\nUse the local SKS control surface. Prefer discovery commands for availability questions: sks commands, sks usage <topic>, sks quickstart, sks codex-app, sks context7 check, sks guard check, sks conflicts check, sks reasoning, sks wiki pack, and sks pipeline status. If implementation or code-changing work is requested through $SKS or rough natural language, promote it to Team by default unless Answer, DFix, Help, Wiki maintenance, or a safety-specific route applies. Surface route/guard/write-scope status, then use worker subagents for independent scopes; parent integrates and verifies. Context tracking uses TriWiki as SSOT. Do not edit installed harness control files except in this engine source repo. Harness conflicts require sks conflicts prompt and human-approved cleanup.\n`,
    'wiki': `---\nname: wiki\ndescription: Dollar-command route for $Wiki TriWiki refresh, pack, validate, and prune commands.\n---\n\nUse for $Wiki or Korean wiki-refresh requests. Refresh/update/갱신: run sks wiki refresh, then validate .sneakoscope/wiki/context-pack.json. Pack: run sks wiki pack, then validate. Prune/clean/정리: use sks wiki refresh --prune, or sks wiki prune --dry-run for inspection. Report claims, anchors, trust, validation, and blockers. Do not start ambiguity-gated implementation, subagents, or unrelated work.\n`,
    'team': `---\nname: team\ndescription: SKS Team multi-agent orchestration for $Team and default implementation/code-changing routes.\n---\n\nUse for $Team/$team, rough implementation prompts, code-changing work, team-of-agents, or parallel specialist implementation. Answer, DFix, Help, Wiki maintenance, and safety-specific routes are intentional exceptions.\n\nWorkflow:\n1. Mandatory ambiguity gate first: ask generated questions, write answers.json, run sks pipeline answer latest answers.json, then start Team work.\n2. Role counts: executor:5 reviewer:2 user:1. executor:N means N read-only analysis_scout_N agents, N debate participants, then a separate N-person executor team. --agents/--sessions/--team-size are aliases; --max-agents uses 6.\n3. Scouts split repo/docs/tests/API/DB-risk/UX/implementation slices and return source-backed team-analysis.md findings.\n4. Refresh/validate TriWiki before debate, implementation, review, and final claims.\n5. Debate seals one objective and disjoint slices; close debate agents before a fresh executor_N development team starts parallel work.\n6. Mirror useful scout/debate/handoff/review/integration events with sks team event <mission-id|latest> --agent <name> --phase <phase> --message \"...\".\n\nLive files: team-analysis.md, team-live.md, team-transcript.jsonl, team-dashboard.json, team-gate.json. Parent orchestrates, integrates, verifies, and never bypasses SKS gates.\n`,
    'qa-loop': `---\nname: qa-loop\ndescription: Dollar-command route for $QA-LOOP UI/API E2E verification with ambiguity questions, safety gates, Browser Use/Computer Use evidence, and a QA report.\n---\n\nUse only $QA-LOOP. Start with mandatory QA questions: UI/API/both, local vs deployed target, mutation policy, login need. Credentials are test-only runtime input; never save secrets, cookies, auth state, or secret screenshots. UI E2E requires Browser Use or Computer Use evidence, otherwise mark it unverified. Deployed targets are read-only smoke by default; destructive removal tests are forbidden. After answers seal, run sks qa-loop answer/run, complete qa-ledger.json, qa-report.md, qa-gate.json, and Honest Mode.\n`,
    'ralph': `---\nname: ralph\ndescription: Dollar-command route for $Ralph or $ralph mandatory clarification and no-question mission workflows.\n---\n\nUse when the user invokes $Ralph/$ralph or requests a clarification-gated autonomous implementation mission. Prepare with sks ralph prepare, answer/seal required slots when answers are provided, then run only after decision-contract.json exists.\n`,
    'research': `---\nname: research\ndescription: Dollar-command route for $Research or $research frontier discovery workflows.\n---\n\nUse when the user invokes $Research/$research or asks for research, hypotheses, new mechanisms, falsification, or testable predictions. Prefer sks research prepare and sks research run. Do not use for ordinary code edits.\n`,
    'autoresearch': `---\nname: autoresearch\ndescription: Dollar-command route for $AutoResearch or $autoresearch iterative experiment loops.\n---\n\nUse when the user invokes $AutoResearch/$autoresearch or asks for iterative improvement, SEO/GEO, ranking, prompt/workflow improvement, benchmark gains, or open-ended experimentation. Follow the autoresearch-loop skill and load seo-geo-optimizer for README, npm, GitHub stars, schema, keyword, AI-search, or discoverability work. Define program, hypothesis, experiment, metric, keep/discard decision, falsification, next experiment, and Honest Mode conclusion.\n`,
    'db': `---\nname: db\ndescription: Dollar-command route for $DB or $db database and Supabase safety checks.\n---\n\nUse when the user invokes $DB/$db or the task touches SQL, Supabase, Postgres, migrations, Prisma, Drizzle, Knex, MCP database tools, or production data. Run or follow sks db policy, sks db scan, sks db classify, and sks db check. Destructive database operations remain forbidden.\n`,
    'gx': `---\nname: gx\ndescription: Dollar-command route for $GX or $gx deterministic GX visual context cartridges.\n---\n\nUse when the user invokes $GX/$gx or asks for architecture/context visualization through SKS. Prefer sks gx init, render, validate, drift, and snapshot. vgraph.json remains the source of truth.\n`,
    'help': `---\nname: help\ndescription: Dollar-command route for $Help or $help explaining installed SKS commands and workflows.\n---\n\nUse when the user invokes $Help/$help or asks what commands exist. Prefer concise output from sks commands, sks usage <topic>, sks quickstart, sks aliases, and sks codex-app.\n`,
    'prompt-pipeline': `---\nname: prompt-pipeline\ndescription: Default SKS prompt optimization pipeline for execution prompts; Answer and DFix bypass it.\n---\n\nEvery prompt starts with intent classification. $Answer handles questions; $DFix handles tiny design/content edits. General implementation/code-changing routes default to Team, unless a more specific safety/research/DB/GX route applies. Execution routes infer goal, target surface, constraints, acceptance criteria, risk, and smallest safe route, then run the mandatory ambiguity gate before implementation.\n\nAsk generated questions, write answers.json, and seal with sks pipeline answer latest answers.json. Ralph uses sks ralph answer latest answers.json. Do not execute, spawn Team scouts, touch DB, or edit code before the gate passes.\n\nFor code-changing work, surface route/guard/write scopes, then use Team worker subagents for independent non-overlapping scopes; parent owns integration, tests, DB safety, harness guard, Context7, H-Proof, and Honest Mode.\n\nDesign routing:\n- UI/UX work must read \`design.md\` first.\n- If \`design.md\` is missing, use design-system-builder with plan-tool ambiguity removal and a default font recommendation before UI implementation.\n- If \`design.md\` exists, use design-ui-editor and design-artifact-expert for design-system-conformant edits and rendered verification.\n- Image, logo, raster, and bitmap assets must use imagegen.\n\nContext continuity:\n- TriWiki context-tracking SSOT is .sneakoscope/wiki/context-pack.json.\n- Use relevant TriWiki context before every route stage.\n- Hydrate low-trust/stale claims from source path/hash/RGBA anchor before relying on them.\n- Run \`sks wiki refresh\` or \`sks wiki pack\` after findings/artifact changes.\n- Validate with \`sks wiki validate .sneakoscope/wiki/context-pack.json\` before handoffs and final claims.\n`,
    'reasoning-router': `---\nname: reasoning-router\ndescription: Temporary SKS reasoning-effort routing for every command and pipeline route.\n---\n\nUse medium for simple fulfillment such as copy, color, command discovery, setup display, or mechanical edits. Use high for any logical, safety, architecture, database, orchestration, refactor, or multi-file implementation work. Use xhigh for research, AutoResearch, hypotheses, falsification, benchmarks, SEO/GEO experiments, and open-ended discovery.\n\nRules:\n- Treat the routing as temporary for the current route only.\n- Do not persist profile changes.\n- Return to the default or user-selected profile when the route gate passes.\n- Inspect with sks reasoning \"prompt\" and sks pipeline status.\n`,
    'pipeline-runner': `---\nname: pipeline-runner\ndescription: Execute SKS dollar-command routes as stateful pipelines with mission artifacts, route gates, Context7 evidence, temporary reasoning routing, and Honest Mode.\n---\n\nEvery $ command is a route, not decorative context. Use the active route state in .sneakoscope/state/current.json, write route artifacts under .sneakoscope/missions/<id>/, and do not finish until the route stop gate passes or a hard blocker is recorded with evidence.\n\nAtomic loop:\n1. Load the route skill and required supporting skills.\n2. Apply temporary reasoning routing: medium for simple work, high for logical work, xhigh for research.\n3. Before each route stage, read relevant TriWiki context from .sneakoscope/wiki/context-pack.json and hydrate low-trust claims from source before relying on them.\n4. Before code edits, surface visible SKS route/guard/write-scope status, then spawn worker subagents by default for independent write scopes; keep immediate blockers local.\n5. Execute exactly the next useful atomic action.\n6. Record evidence in the mission artifact named by the route, then refresh or pack TriWiki when new findings/artifact changes should affect later stages.\n7. Respect harness self-protection: never edit installed SKS control files, generated skills, hooks, policy, AGENTS.md, or node_modules/sneakoscope from an LLM tool call.\n8. Re-check Context7 evidence when required.\n9. Validate TriWiki before handoffs/final claims, re-check the stop gate before final output, and return to the default profile.\n\nUse \`sks pipeline status\` for the current route and \`sks pipeline resume\` for the next action hint.\n`,
    'context7-docs': `---\nname: context7-docs\ndescription: Enforce Context7 MCP documentation evidence for SKS routes that depend on external libraries, frameworks, APIs, MCPs, package managers, DB SDKs, or generated docs.\n---\n\nWhen Context7 is required:\n- Use Context7 resolve-library-id for the relevant package/API.\n- Then use Context7 query-docs for the resolved id. Legacy Context7 get-library-docs evidence is also accepted.\n- Prefer the local stdio MCP path: sks context7 tools, sks context7 resolve, sks context7 docs, or sks context7 evidence.\n- Let SKS PostToolUse record both events in context7-evidence.jsonl.\n- Do not mark the route complete until both stages are present.\n\nCheck project setup with \`sks context7 check\`. The default project-local MCP lives in .codex/config.toml as npx -y @upstash/context7-mcp@latest.\n`,
    'seo-geo-optimizer': `---\nname: seo-geo-optimizer\ndescription: SEO/GEO support for README, npm, GitHub, keywords, snippets, schema, and AI-search visibility.\n---\n\nUse for SEO, GEO, GitHub stars, npm discoverability/downloads, package keywords, README ranking, AI search, schema markup, or search snippets.\n\nRules:\n- Load Context7 first when package, npm, GitHub, framework, API, or generated-doc behavior matters.\n- Optimize concrete surfaces: README, package.json, docs, badges, npm metadata, GitHub topics, quickstart, examples, and command discovery.\n- Improve exact package name, command name, audience, use cases, keywords, install path, AI Answer Snapshot, and supportable examples.\n- Do not invent downloads, stars, benchmarks, compatibility, or ranking impact.\n- Route SEO/GEO work through $AutoResearch unless it is only a tiny copy edit.\n`,
    'honest-mode': `---\nname: honest-mode\ndescription: Required final SKS verification pass before claiming a task is complete.\n---\n\nUse before every final answer.\n\nChecklist:\n- Restate the actual user goal in one sentence.\n- Verify the implemented result against that goal.\n- List tests, commands, screenshots, or inspections that prove it.\n- State any missing verification, uncertainty, or hard blocker plainly.\n- Do not claim complete if the evidence does not support it.\n- If implementation was requested, do not stop at a plan.\n\nThe final response should include a concise SKS Honest Mode or 솔직모드 note when the hook requires it.\n`,
    'autoresearch-loop': `---\nname: autoresearch-loop\ndescription: Iterative AutoResearch-style loop for open-ended improvement, discovery, prompt, ranking, SEO/GEO, and workflow-quality tasks.\n---\n\nUse when the task asks for research, better ranking, SEO/GEO, prompt or workflow improvement, benchmark gains, non-obvious ideas, or repeated refinement.\n\nLoop:\n1. Program: define the objective, constraints, and budget.\n2. Hypothesis: propose one concrete change or experiment.\n3. Experiment: run the smallest local or documented check that can falsify it.\n4. Measure: record the metric, evidence, and artifact paths.\n5. Decision: keep, discard, or revise the hypothesis.\n6. Falsify: actively search for why the result could be wrong.\n7. Next: choose the next experiment or stop with an honest conclusion.\n\nRules:\n- Prefer small decisive experiments over broad speculation.\n- Keep a ledger in the mission/report when relevant.\n- Do not claim improvement without evidence.\n- End with Honest Mode: what improved, what did not, what remains unverified.\n`,
    'ralph-supervisor': `---\nname: ralph-supervisor\ndescription: Run the Ralph no-question loop after a decision contract is sealed.\n---\n\nYou are the Ralph Supervisor.\n\nRules:\n- Never ask the user during Ralph run.\n- Use decision-contract.json and the decision ladder.\n- Continue until done-gate.json passes or safe scope is completed with explicit limitation.\n- Keep outputs bounded. Write raw logs to files and summarize only tails.\n- Database destructive operations are never allowed.\n- Write progress to .sneakoscope mission files.\n`,
    'ralph-resolver': `---\nname: ralph-resolver\ndescription: Resolve newly discovered ambiguity during Ralph using the sealed decision ladder, without asking the user.\n---\n\nResolve ambiguity in this order: seed contract, explicit answers, approved defaults, AGENTS.md, current code/tests, smallest reversible change, defer optional scope. Never ask the user. If database risk is involved, prefer read-only, no-op, local-only migration file, or safe limitation; never run destructive SQL.\n`,
    'hproof-claim-ledger': `---\nname: hproof-claim-ledger\ndescription: Extract atomic claims and classify support status.\n---\n\nEvery factual statement must become an atomic claim. Unsupported critical claims cannot be used for implementation or final answer. Database claims require DB safety evidence.\n`,
    'hproof-evidence-bind': `---\nname: hproof-evidence-bind\ndescription: Bind claims to code, tests, decision contract, vgraph, beta, wiki, or GX render evidence.\n---\n\nEvidence priority: current code/tests, decision-contract.json, vgraph.json, beta.json, GX snapshot/render metadata, LLM Wiki coordinate index, user prompt. Database claims must respect .sneakoscope/db-safety.json. Wiki claims should carry id, hash, source path, and RGBA/trig coordinate anchors so they can be hydrated instead of treated as unsupported summaries.\n`,
    'db-safety-guard': `---\nname: db-safety-guard\ndescription: Enforce Sneakoscope Codex database safety before using SQL, Supabase MCP, Postgres, Prisma, Drizzle, Knex, or migration commands.\n---\n\nRules:\n- Never run DROP, TRUNCATE, mass DELETE/UPDATE, db reset, db push, project deletion, branch reset/merge/delete, or RLS-disabling operations.\n- Supabase MCP must be read-only and project-scoped by default.\n- Live writes through execute_sql are blocked; use migration files and only local/preview branches if explicitly allowed.\n- Production writes are forbidden.\n- If unsure, read-only only.\n`,
    'gx-visual-generate': `---\nname: gx-visual-generate\ndescription: Render a deterministic SVG/HTML visual sheet from vgraph.json and beta.json.\n---\n\nUse sks gx render. Do not use external image generation. vgraph.json is the source of truth and the SVG embeds its source hash. GX renders also expose RGBA wiki-coordinate pixels/data attributes for nodes so visual context and LLM Wiki anchors share one coordinate system.\n`,
    'gx-visual-read': `---\nname: gx-visual-read\ndescription: Read a Sneakoscope Codex deterministic visual sheet and produce context notes.\n---\n\nExtract nodes, edges, invariants, tests, risks, uncertainties, and RGBA wiki-coordinate anchors from vgraph.json, beta.json, render.svg, or snapshot.json. Do not infer hidden nodes.\n`,
    'gx-visual-validate': `---\nname: gx-visual-validate\ndescription: Validate render metadata against vgraph.json and beta.json.\n---\n\nRun sks gx validate and sks gx drift. If critical nodes, edges, invariants, source hash, or wiki-coordinate anchors are missing or stale, mark validation failed.\n`,
    'turbo-context-pack': `---\nname: turbo-context-pack\ndescription: Build ultra-low-token context packet with Q4 bits, Q3 tags, top-K claims, and minimal evidence.\n---\n\nDefault to Q4/Q3 plus TriWiki RGBA coordinate anchors. Add Q2 or Q1 text only when needed for support or verification. Non-selected claims should not disappear: keep id, hash, source path, RGBA key, and [domain, layer, phase, concentration] tuple so the harness can hydrate them later.\n`,
    'research-discovery': `---\nname: research-discovery\ndescription: Run SKS Research Mode for frontier-style research, hypotheses, novelty ledgers, falsification, and experiments.\n---\n\nUse for research, frontier exploration, hypothesis generation, or non-obvious insights. Define discovery criteria, map assumptions/baselines, generate competing hypotheses, falsify aggressively, keep only surviving insights, and write novelty/confidence/falsifiers/next_experiment to novelty-ledger.json plus research-report.md. Do not claim breakthrough novelty without evidence and uncertainty.\n`,
    'performance-evaluator': `---\nname: performance-evaluator\ndescription: Evaluate SKS performance, token-saving, accuracy-proxy, context-compression, or workflow improvements.\n---\n\nUse when claiming faster execution, smaller prompts, better context quality, or lower token cost. Run sks eval run or compare reports with sks eval compare. Report token_savings_pct, accuracy_delta, required_recall, unsupported_critical_selected, meaningful_improvement, and treat accuracy_proxy as context-quality evidence unless a scored dataset was used.\n`,
    'imagegen': `---\nname: imagegen\ndescription: Required bridge to Codex image generation for logos, image assets, raster visuals, and image edits.\n---\n\nUse whenever a task needs a generated or edited image asset: logo, product image, illustration, texture, sprite, mockup, cutout, or bitmap visual. Load/follow the installed Codex system imagegen skill and use the image generation tool for the asset.\n\nRules:\n- Do not replace requested image assets with placeholder SVG/HTML/CSS.\n- Do not edit the system imagegen skill source.\n- For UI/UX, match \`design.md\` through design-system-builder or design-ui-editor.\n`,
    'design-system-builder': `---\nname: design-system-builder\ndescription: Create design.md from docs/Design-Sys-Prompt.md when UI/UX work has no design system.\n---\n\nUse before UI/UX implementation when \`design.md\` is missing. Read \`docs/Design-Sys-Prompt.md\`, inspect product/UI context, then use the Codex plan tool to resolve ambiguity before writing \`design.md\`.\n\nRequired plan questions: product/audience/workflow; brand tone, density, platform, accessibility, fidelity; recommended default font first with tradeoff; existing UI kit, screenshots, Figma, brand assets, or code surfaces.\n\nOutput: \`design.md\` with typography/default font, color tokens, layout density, components, states, imagery, accessibility, and verification rules. Use imagegen for image assets. Do not edit UI until ambiguity is resolved or safely scoped.\n`,
    'design-ui-editor': `---\nname: design-ui-editor\ndescription: Edit UI/UX using design.md and design-artifact-expert.\n---\n\nUse for every UI/UX edit after \`design.md\` exists. Read it first, inspect only relevant components/routes/screenshots/assets/tests, apply the smallest design-system-conformant change, use imagegen for any image/logo/raster asset, and verify render quality for overlap, readability, responsive fit, states, and AI-looking artifacts. If \`design.md\` is missing, stop and use design-system-builder first.\n`,
    'design-artifact-expert': `---\nname: design-artifact-expert\ndescription: Create or revise high-fidelity HTML, UI, prototype, deck-like, or visual design artifacts with rendered verification.\n---\n\nUse for design, UI, prototype, HTML artifact, landing page, deck-like visual work, or refinement. Read \`design.md\` when present; if it is missing and the task needs UI/UX design judgment, use design-system-builder first. Inspect local code/assets/design context, build the actual usable artifact first, preserve relevant state, expose useful variants when helpful, and verify render quality. Use imagegen for any required image/logo/raster asset. Avoid overlap, unreadable controls, placeholder-only output, one-note palettes, and unmanaged visual drift.\n`
  };
  for (const [name, content] of Object.entries(skills)) {
    const dir = path.join(root, '.agents', 'skills', name);
    const skillContent = enrichSkillContent(name, content);
    await ensureDir(dir);
    await writeTextAtomic(path.join(dir, 'SKILL.md'), `${skillContent.trim()}\n`);
    await writeSkillMetadata(dir, name);
  }
  return {
    removed_agent_skill_aliases: await removeGeneratedAgentSkillAliases(root, Object.keys(skills)),
    removed_codex_skill_mirrors: await removeGeneratedCodexSkillMirrors(root, Object.keys(skills))
  };
}

function enrichSkillContent(name, content) {
  if (!['sks', 'answer', 'wiki', 'team', 'qa-loop', 'ralph', 'research', 'autoresearch', 'db', 'gx', 'prompt-pipeline', 'pipeline-runner', 'turbo-context-pack', 'hproof-evidence-bind'].includes(name)) return content;
  const text = String(content || '').trimEnd();
  if (text.includes('TriWiki context-tracking SSOT')) return text;
  return `${text}

Context tracking:
- Mandatory ambiguity-removal happens before execution routes. Answer-only prompts use TriWiki/web/Context7 evidence and Honest Mode fact-checking without starting implementation. DFix bypasses this pipeline and uses its own ultralight task-list path. When questions are required, use the Codex plan tool first to show Ask questions -> Seal decision contract -> Execute/verify, then ask the generated questions. Seal answers with sks pipeline answer latest answers.json before implementing or spawning Team agents.
- TriWiki context-tracking SSOT is .sneakoscope/wiki/context-pack.json.
- Use sks wiki refresh or sks wiki pack before each work stage when relevant, after new findings/artifact changes, and before handoffs or final claims.
- Use sks wiki prune when stale or oversized wiki state would pollute handoffs.
- Validate with sks wiki validate .sneakoscope/wiki/context-pack.json before relying on a refreshed pack.
- Selected text is only the visible slice; keep non-selected claims hydratable by id, hash, source path, and RGBA/trig coordinate.
- Trust scores guide usage: high-trust claims may guide work; low-trust claims require evidence hydration before implementation or final claims.
- Hook visibility is limited to injected context/status and block/continue digests; hooks cannot create arbitrary live chat bubbles. Use team events, mission files, or normal assistant updates for live detail.
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
  return /Sneakoscope|SKS|Codex App picker alias|Dollar-command route/i.test(s);
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
