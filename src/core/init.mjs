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

When the user invokes Team mode or \`$Team\`, use Codex multi-agent/subagent orchestration as four ordered stages: parallel analysis scouts, TriWiki refresh, read-only debate team, and fresh parallel development team. TriWiki is not a one-time setup step: before every stage, read relevant \`.sneakoscope/wiki/context-pack.json\` entries; during the stage, hydrate low-trust or stale claims from their source/hash/RGBA anchors; after scout findings, debate conclusions, consensus, implementation changes, reviews, or blockers, refresh or pack TriWiki; before every handoff and final claim, validate the pack. Role counts use tokens like \`executor:5 reviewer:2 user:1\`; \`executor:N\` creates exactly N read-only \`analysis_scout_N\` agents first, exactly N debate participants next, and then a separate N-person \`executor_N\` development team. Analysis scouts split repo, docs, tests, API, DB-risk, UX-friction, and implementation-surface investigation into independent read-only slices. Scout findings must be source-backed and TriWiki-ready, then the parent refreshes and validates \`.sneakoscope/wiki/context-pack.json\` before debate. The debate team is read-only and includes stubborn final-user personas, capable developer/executor voices, strict reviewers, and planners. Final users are intentionally low-context, self-interested, stubborn, and hostile to inconvenience. Reviewers are strict. Executors are capable developers. Close or stop debate agents once the objective is sealed, then refresh/validate TriWiki before implementation. Then form a fresh development team where executor_N developers implement disjoint slices in parallel and reviewers/user personas validate the result. The parent agent remains the orchestrator: it assigns ownership, watches hook output, waits only when blocked, integrates results, runs verification, and produces the final evidence. Record every useful scout finding, subagent status/result/handoff/review line in the Team live transcript with \`sks team event <mission-id|latest> --agent <name> --phase <phase> --message "..."\`; the user can inspect \`team-live.md\`, \`team-transcript.jsonl\`, or \`sks team watch latest\` instead of tmux. Do not let subagents make destructive database changes or bypass SKS hooks.

## Code-Changing Execution

For code-changing work, first produce visible SKS hook/status context: route, guard state, affected write scopes, and verification plan. Then default to Codex worker subagents when the work can be split into independent, non-overlapping write scopes. The parent remains the orchestrator: assign disjoint ownership, keep urgent blocking work local, integrate worker results, and run final verification. Subagents must not bypass DB safety, harness guard, Ralph no-question rules, Context7 evidence gates, or H-Proof/Honest Mode.

## Design Execution

When creating HTML, UI, prototype, deck-like, or visual artifacts, use the local design artifact skill. Gather design context first, build the actual usable experience rather than a marketing placeholder, expose variations when useful, and verify the rendered artifact before handoff.

## Prompt Optimization Pipeline

Every user prompt starts with intent classification. If it is answer-only, use the Answer path: hydrate TriWiki when relevant, use web for current or external facts, use Context7 for package/API/framework documentation, run Honest Mode fact-checking, and answer directly without starting implementation. DFix bypasses the general pipeline and uses its own ultralight task-list path for simple design/content fixes. Execution prompts enter the SKS prompt optimization pipeline: extract intent, target files or surfaces, constraints, acceptance criteria, risks, and the smallest safe execution path before acting. Choose the lightest matching route: Answer, DFix, normal implementation, Ralph, Research, DB safety, GX, or evaluation. Do not run heavy Ralph/research/evaluation loops for simple direct edits or questions.

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
  return `# Sneakoscope Codex for Codex App

This project has been initialized for both the SKS CLI and Codex App.

## App Control Surface

- Rules: \`AGENTS.md\`
- Hooks: \`.codex/hooks.json\`
- Profiles: \`.codex/config.toml\`
- App skills: \`.agents/skills/\`
- App agents: \`.codex/agents/\`
- Mission state: \`.sneakoscope/missions/\`
- LLM Wiki pack: \`.sneakoscope/wiki/context-pack.json\`
- Current state: \`.sneakoscope/state/current.json\`

## Installed Command

\`\`\`bash
${commandPrefix} <command>
\`\`\`

Install scope: \`${scope}\`

## Discovery Commands

\`\`\`bash
${commandPrefix} help
${commandPrefix} commands
${commandPrefix} usage team
${commandPrefix} usage ralph
${commandPrefix} quickstart
${commandPrefix} codex-app
${commandPrefix} codex-app check
${commandPrefix} tmux check
${commandPrefix} auto-review status
${commandPrefix} dollar-commands
${commandPrefix} context7 check
${commandPrefix} context7 tools
${commandPrefix} context7 docs /websites/developers_openai_codex --query "hooks customization"
${commandPrefix} pipeline status
${commandPrefix} pipeline answer latest answers.json
${commandPrefix} guard check
${commandPrefix} hproof check latest
${commandPrefix} conflicts check
${commandPrefix} reasoning "simple copy edit"
${commandPrefix} wiki refresh
${commandPrefix} wiki prune
${commandPrefix} wiki pack
${commandPrefix} wiki validate .sneakoscope/wiki/context-pack.json
\`\`\`

## Dollar Commands

${DOLLAR_COMMANDS.map((c) => `- \`${c.command}\`: ${c.route}. ${c.description}`).join('\n')}

Codex App skills are installed in the official repo-local path \`.agents/skills\` with one canonical lowercase skill per dollar command: \`${DOLLAR_COMMAND_ALIASES.map((x) => x.app_skill).join('`, `')}\`. SKS routing is case-insensitive for canonical command spelling, so \`$Team\` and \`$team\` both activate the same route; duplicate spellings such as \`$QALoop\` are intentionally not separate commands.

Codex CLI tmux parity requires Codex App to be installed and opened at least once because the first-party Browser Use and Computer Use MCP/plugin tools are provisioned through the App. Check with \`${commandPrefix} codex-app check\` and \`${commandPrefix} tmux check\`; run \`${commandPrefix}\` to enter the ㅅㅋㅅ tmux runtime. Use \`${commandPrefix} --Auto-review --high\` to enable Codex automatic approval review and launch with the high-reasoning auto-review profile.

The prompt optimization pipeline also runs without a dollar command and infers the lightest route automatically. Answer-only prompts use the Answer path: TriWiki/web/Context7 evidence when useful, Honest Mode fact-checking, then direct reply. DFix bypasses the general pipeline and uses an ultralight task-list path for simple design/content fixes. Every execution route starts with a mandatory ambiguity-removal gate before execution. Answer the generated questions, then seal them with \`${commandPrefix} pipeline answer latest answers.json\` (or \`${commandPrefix} ralph answer latest answers.json\` for Ralph).

## Context Tracking

- ${triwikiContextTrackingText(commandPrefix)}
- ${triwikiStagePolicyText(commandPrefix).replace(/\n/g, '\n- ')}
- Team mode, Ralph continuations, Research/AutoResearch, DB reviews, and long-running implementation handoffs should use relevant TriWiki context during every stage instead of relying on one initial pack or ad hoc summaries.

## Code-Changing Execution

- First surface visible SKS hook/status context: route, guard state, affected write scopes, and verification plan.
- Use worker subagents by default when code changes split into independent, non-overlapping write scopes; the parent assigns ownership, integrates, and verifies.
- Keep urgent blocking work local, and respect DB safety, harness guard, Ralph, Context7, H-Proof, and Honest Mode.

## Codex Hooks

- \`UserPromptSubmit\` can inject additional developer context or block a prompt before the model turn.
- \`Stop\` with \`decision: "block"\` continues by creating a new continuation prompt.
- Hook \`statusMessage\` text makes SKS routing, guard, permission, and done-gate checks visible in Codex App.
- Hook visibility is bounded to injected context/status and block/continue digests; hooks cannot create arbitrary live chat bubbles. Use \`sks team event\`, mission files, or normal assistant updates for live transcript detail.

## Harness Guard

- Installed harness files are immutable to LLM tool edits after setup. Hooks block writes to \`.codex\` control files, \`.agents/skills\`, \`.codex/agents\`, \`.sneakoscope\` policy/manifest/guard files, \`AGENTS.md\`, and \`node_modules/sneakoscope\`.
- The only automatic exception is the Sneakoscope engine source repository itself.
- Check guard state with \`${commandPrefix} guard check\`.
- If OMX/DCodex or another explicit Codex harness trace exists, setup and doctor repair are blocked until a human-approved cleanup is performed. Print the GPT-5.5 high cleanup prompt with \`${commandPrefix} conflicts prompt\`.

## Context7 MCP

- Default local MCP: \`.codex/config.toml\` includes \`[mcp_servers.context7]\` with \`npx -y @upstash/context7-mcp@latest\`.
- Required routes must record \`resolve-library-id\` and \`query-docs\` evidence before completion when docs/API/package knowledge is relevant. SKS also accepts legacy \`get-library-docs\` evidence.
- Check setup with \`${commandPrefix} context7 check\`; list actual local MCP tools with \`${commandPrefix} context7 tools\`; query docs with \`${commandPrefix} context7 docs <library|/org/project>\`; refresh project config with \`${commandPrefix} context7 setup --scope project\`.

## Recommended Skills

- \`reasoning-router\`: temporary medium/high/xhigh route selection.
- \`context7-docs\`: docs/API evidence gate.
- \`seo-geo-optimizer\`: SEO and generative engine optimization for README, npm, GitHub, schema, and AI-search visibility.
- \`autoresearch-loop\`: experiment ledger for open-ended improvement.
- \`performance-evaluator\`: metric-backed claims.

## Update And Honest Mode

- Before work: hooks check for a newer \`sneakoscope\` package and ask whether to update now or skip for this conversation only.
- Before final: hooks require SKS Honest Mode, a short verification pass covering goal completion, evidence/tests, and remaining gaps.
- Reasoning route is temporary: simple fulfillment uses medium, logical work uses high, and research/experiments use xhigh before returning to the default profile.

## Common App Prompts

- "Use Sneakoscope Ralph mode to prepare this task."
- "$SKS show me available workflows."
- "$Team agree on the best plan, then implement it with a fresh specialist team."
- "$DFix change the button text to English."
- "$Answer why does this hook behave this way?"
- "$QA-LOOP run UI and API E2E against local dev."
- "$Ralph implement this with mandatory clarification."
- "$Research investigate this idea."
- "$AutoResearch improve this workflow with experiments."
- "$DB check this migration safely."
- "$GX render a visual context cartridge."
- "$Help show available SKS commands."
- "Run the latest Ralph mission with the sealed decision contract."
- "Use SKS DB safety before touching database or Supabase files."
- "Use SKS research mode for this investigation."

## CLI Bridge

Codex App can call the same project-local control surface through terminal commands:

\`\`\`bash
${commandPrefix} setup
${commandPrefix} doctor
${commandPrefix} codex-app check
${commandPrefix} tmux check
${commandPrefix} auto-review status
${commandPrefix} context7 check
${commandPrefix} context7 tools
${commandPrefix} context7 docs /websites/developers_openai_codex --query "hooks customization"
${commandPrefix} pipeline status
${commandPrefix} guard check
${commandPrefix} conflicts check
${commandPrefix} ralph prepare "task"
${commandPrefix} ralph status latest
${commandPrefix} research prepare "topic"
${commandPrefix} team "task"
${commandPrefix} team watch latest
${commandPrefix} team event latest --agent analysis_scout_1 --phase parallel_analysis_scouting --message "mapped repo slice"
${commandPrefix} wiki refresh
${commandPrefix} wiki prune
${commandPrefix} wiki pack
${commandPrefix} wiki validate .sneakoscope/wiki/context-pack.json
${commandPrefix} db scan --migrations
\`\`\`

The hooks file routes Codex App tool events through SKS guards for no-question mode, DB safety, permission requests, and done-gate checks. Hook status messages make those SKS checks visible while they run, but hooks can only inject context/status or block/continue digests; they cannot create arbitrary live chat bubbles.
`;
}

async function installSkills(root) {
  const skills = {
    'dfix': `---\nname: dfix\ndescription: Ultralight fast design/content fix mode for $DFix or $dfix requests and inferred simple edits such as text color, copy, labels, spacing, or translation.\n---\n\nYou are running SKS DFix mode.\n\nPurpose:\n- Bypass the general SKS prompt pipeline for small design/content requests.\n- Convert the request into a tiny task list, then execute only those tasks.\n- Use for requests like 글자 색 바꿔줘, 내용을 영어로 바꿔줘, button label 수정, spacing 조정, copy replacement, simple style tweaks.\n\nUltralight loop:\n1. List the exact micro-edits implied by the request.\n2. Inspect only the files needed to locate those targets.\n3. Apply only the listed edits.\n4. Run only cheap verification when useful.\n5. Final response should be short: what changed and any verification.\n\nRules:\n- Do not enter the general prompt pipeline, mission workflow, ambiguity gate, TriWiki refresh, Context7 routing, subagent orchestration, Ralph, Research, eval, or broad redesign.\n- Do not ask for more requirements when the target can be inferred from local context.\n- Preserve the existing design system and component patterns.\n`,
    'answer': `---\nname: answer\ndescription: Answer-only research route for ordinary questions that should not start implementation.\n---\n\nUse when the user is asking for an explanation, comparison, status, facts, source-backed research, or documentation guidance rather than asking you to change files or run work.\n\nEvidence flow:\n1. Use current repo files and TriWiki first when the answer is project-local.\n2. Hydrate low-trust wiki claims from source paths before relying on them.\n3. Use web search for current, external, or uncertain facts when browsing is available or the user asks for latest/source-backed information.\n4. Use Context7 resolve-library-id plus query-docs when the answer depends on package, API, framework, SDK, MCP, or generated documentation behavior.\n5. End with Honest Mode fact-checking: separate verified facts, source-backed inferences, and uncertainty.\n\nRules:\n- Do not create route mission state, ambiguity-gate questions, subagents, Team handoffs, Ralph, Research loops, eval loops, or file edits.\n- If the prompt turns out to request implementation, state the reroute and use the proper execution pipeline.\n`,
    'sks': `---\nname: sks\ndescription: General Sneakoscope Codex command route for $SKS or $sks usage, setup, status, and workflow help.\n---\n\nUse the local SKS control surface. Prefer these discovery commands when the user asks what is available: sks commands, sks usage <topic>, sks quickstart, sks codex-app, sks context7 check, sks guard check, sks conflicts check, sks reasoning, sks wiki pack, and sks pipeline status. If implementation is requested, route to the lightest matching SKS path and keep reasoning-profile changes temporary. For code-changing execution, first surface route/guard/write-scope status, then use worker subagents by default when scopes are independent; the parent integrates and verifies, while urgent blocking work stays local. Context tracking uses TriWiki as the SSOT for long-running or cross-turn work. Do not edit installed harness control files; the harness guard blocks LLM writes after setup except in the Sneakoscope engine source repo. If OMX/DCodex or another explicit Codex harness is detected, do not install SKS; use sks conflicts prompt and require human approval before cleanup.\n`,
    'wiki': `---\nname: wiki\ndescription: Dollar-command route for $Wiki TriWiki refresh, pack, validate, and prune commands.\n---\n\nUse for $Wiki or Korean wiki-refresh requests. Refresh/update/갱신: run sks wiki refresh, then validate .sneakoscope/wiki/context-pack.json. Pack: run sks wiki pack, then validate. Prune/clean/정리: use sks wiki refresh --prune, or sks wiki prune --dry-run for inspection. Report claims, anchors, trust, validation, and blockers. Do not start ambiguity-gated implementation, subagents, or unrelated work.\n`,
    'team': `---\nname: team\ndescription: Dollar-command route for $Team or $team SKS Team multi-agent orchestration: mandatory ambiguity gate, parallel analysis scouts, TriWiki refresh, role-counted debate, fresh executor development team, live transcript, and final integration.\n---\n\nUse when the user invokes $Team/$team, asks for a team of agents, or asks for parallel specialist implementation.\n\nWorkflow:\n1. Mandatory ambiguity-removal gate: before any scout/debate/implementation work, ask the generated questions, write answers.json, and run sks pipeline answer latest answers.json. Do not spawn analysis scouts until this gate passes.\n2. Create or inspect the Team mission with sks team \"task\" when useful. Role counts use executor:5 reviewer:2 user:1 planner:1. executor:N means exactly N analysis_scout_N agents first, exactly N debate participants next, and then a separate N-person executor development team. --agents N, --sessions N, and --team-size N remain aliases for executor/session budget; --max-agents uses the configured default maximum of 6 sessions/agents; default is executor:3 reviewer:1 user:1 planner:1.\n3. Parallel analysis scouts: spawn the concrete analysis_scout_N roster read-only. Split repo, docs, tests, API, DB-risk, UX-friction, and implementation-surface investigation into independent slices. Each scout returns source-backed findings for team-analysis.md.\n4. TriWiki refresh: parent turns scout findings into TriWiki-ready claims, runs sks wiki pack, then runs sks wiki validate .sneakoscope/wiki/context-pack.json. Do not move to debate or implementation until the pack is refreshed and validated.\n5. Debate bundle: spawn the concrete debate_team roster using the refreshed TriWiki context. Users are intentionally low-context, self-interested, stubborn, and inconvenience-averse. Executor voices are capable developers. Reviewers are strict. Planners force one coherent objective.\n6. Live visibility phase: after every useful scout finding, subagent status/result/handoff, record it with sks team event <mission-id|latest> --agent <name> --phase <phase> --message \"...\" so the user can see the team conversation without tmux.\n7. Consensus phase: synthesize debate into one objective, explicit constraints, acceptance criteria, and disjoint implementation slices.\n8. Close or stop the debate team after their results are captured.\n9. Development bundle: form a fresh development_team where exactly executor_N developers implement slices in parallel with non-overlapping ownership. Tell workers they are not alone in the codebase and must not revert others' edits.\n10. Review phase: validation_team reviewers check correctness, DB safety, missing tests, and evidence; user personas reject outcomes that create practical friction.\n11. Verification phase: run focused tests or justify gaps, update mission artifacts when present, and produce final evidence.\n\nLive files:\n- .sneakoscope/missions/<id>/team-analysis.md stores source-backed scout findings and TriWiki-ready claims.\n- .sneakoscope/missions/<id>/team-live.md is the user-readable live transcript inside Codex App.\n- .sneakoscope/missions/<id>/team-transcript.jsonl is the machine-readable event stream.\n- .sneakoscope/missions/<id>/team-dashboard.json is the current dashboard.\n\nRules:\n- The parent agent remains orchestrator and owns final integration.\n- Before spawning development workers, surface visible SKS route, guard, write-scope, TriWiki, and verification status.\n- Do not delegate the immediate blocking task when the parent can do it faster.\n- Use high reasoning only while the Team route is active, then return to the default/user-selected profile.\n- Never let subagents bypass SKS hooks, DB safety, no-question Ralph rules, or H-Proof completion gates.\n- Destructive database actions remain forbidden.\n`,
    'qa-loop': `---\nname: qa-loop\ndescription: Dollar-command route for $QA-LOOP UI/API E2E verification with mandatory ambiguity questions, safety gates, Browser Use and Computer Use MCP/plugin evidence, and a QA report.\n---\n\nUse when the user invokes $QA-LOOP or asks for QA-LOOP. $QALoop and $qaloop are intentionally not separate command names; keep this route standardized as $QA-LOOP.\n\nWorkflow:\n1. Start with the mandatory QA ambiguity gate. Ask whether scope is UI E2E, API E2E, both, or all available; ask local dev server versus preview/staging/deployed target; ask allowed data mutation policy; ask whether login is required.\n2. If login is required, ask for test-only credentials as ephemeral runtime input only. Tell the user these credentials are for testing only. Never save usernames, passwords, tokens, cookies, auth state, or screenshots containing secrets in mission files, reports, logs, team events, or TriWiki.\n3. UI E2E must prefer official Codex MCP/plugin tools: use Browser Use first for local browser targets such as localhost, 127.0.0.1, file:// URLs, and current browser-tab inspection; use Computer Use for desktop app interaction, screenshots, and browser/app evidence. If neither evidence path is available, mark UI verification as not performed.\n4. Non-local/deployed targets are read-only smoke by default. Destructive removal scenarios are never allowed on deployed targets.\n5. After answers are sealed, use sks qa-loop answer latest answers.json, then sks qa-loop run latest. Work through qa-ledger.json case by case until qa-gate.json passes or a hard blocker is recorded.\n6. End by writing qa-report.md and running Honest Mode with passed checks, gaps, risks, and unverified areas.\n\nArtifacts:\n- .sneakoscope/missions/<id>/qa-ledger.json\n- .sneakoscope/missions/<id>/qa-report.md\n- .sneakoscope/missions/<id>/qa-gate.json\n\nRules:\n- Do not skip the ambiguity gate.\n- Do not save credentials or auth state to artifacts or wiki.\n- Do not claim UI E2E without Browser Use or Computer Use evidence.\n- Keep raw logs bounded under the mission cycle folder and summarize only evidence in the report.\n`,
    'ralph': `---\nname: ralph\ndescription: Dollar-command route for $Ralph or $ralph mandatory clarification and no-question mission workflows.\n---\n\nUse when the user invokes $Ralph/$ralph or requests a clarification-gated autonomous implementation mission. Prepare with sks ralph prepare, answer/seal required slots when answers are provided, then run only after decision-contract.json exists.\n`,
    'research': `---\nname: research\ndescription: Dollar-command route for $Research or $research frontier discovery workflows.\n---\n\nUse when the user invokes $Research/$research or asks for research, hypotheses, new mechanisms, falsification, or testable predictions. Prefer sks research prepare and sks research run. Do not use for ordinary code edits.\n`,
    'autoresearch': `---\nname: autoresearch\ndescription: Dollar-command route for $AutoResearch or $autoresearch iterative experiment loops.\n---\n\nUse when the user invokes $AutoResearch/$autoresearch or asks for iterative improvement, SEO/GEO, ranking, prompt/workflow improvement, benchmark gains, or open-ended experimentation. Follow the autoresearch-loop skill and load seo-geo-optimizer for README, npm, GitHub stars, schema, keyword, AI-search, or discoverability work. Define program, hypothesis, experiment, metric, keep/discard decision, falsification, next experiment, and Honest Mode conclusion.\n`,
    'db': `---\nname: db\ndescription: Dollar-command route for $DB or $db database and Supabase safety checks.\n---\n\nUse when the user invokes $DB/$db or the task touches SQL, Supabase, Postgres, migrations, Prisma, Drizzle, Knex, MCP database tools, or production data. Run or follow sks db policy, sks db scan, sks db classify, and sks db check. Destructive database operations remain forbidden.\n`,
    'gx': `---\nname: gx\ndescription: Dollar-command route for $GX or $gx deterministic GX visual context cartridges.\n---\n\nUse when the user invokes $GX/$gx or asks for architecture/context visualization through SKS. Prefer sks gx init, render, validate, drift, and snapshot. vgraph.json remains the source of truth.\n`,
    'help': `---\nname: help\ndescription: Dollar-command route for $Help or $help explaining installed SKS commands and workflows.\n---\n\nUse when the user invokes $Help/$help or asks what commands exist. Prefer concise output from sks commands, sks usage <topic>, sks quickstart, sks aliases, and sks codex-app.\n`,
    'prompt-pipeline': `---\nname: prompt-pipeline\ndescription: Default SKS prompt optimization pipeline for execution prompts; Answer and DFix bypass it.\n---\n\nEvery prompt starts with intent classification. If it is answer-only, use the Answer path: TriWiki when relevant, web for current or external facts, Context7 for package/API/framework docs, Honest Mode fact-checking, then direct reply. If it is DFix, use the ultralight task-list path.\n\nFor execution prompts, aggressively infer intent from rough wording, local context, repo conventions, current route state, and prior artifacts. The stance is: understand the likely goal without making the user over-specify. Every execution route must start with the mandatory ambiguity-removal gate before execution.\n\nAsk the generated ambiguity-removal questions at the start, write answers.json after the user answers, and seal the gate with sks pipeline answer latest answers.json. Ralph may use sks ralph answer latest answers.json. Do not execute route work, spawn Team scouts, run DB changes, or implement code before the gate passes.\n\nExtract intent, target surface, constraints, acceptance criteria, risk level, and the smallest safe route. Infer $Answer for ordinary questions, $DFix for simple design/content edits, Ralph for no-question autonomous execution, Research only for frontier discovery work, DB only for database-risk work, GX only for visual context artifacts, and eval only when performance or context-quality claims need evidence.\n\nFor code-changing execution, first surface visible SKS status context: route, guard state, affected write scopes, and verification plan. Default to worker subagents when the work can be split into independent, non-overlapping write scopes. The parent keeps urgent blocking work local, assigns ownership, integrates results, verifies, and preserves DB safety, harness guard, Ralph, Context7, and H-Proof/Honest Mode gates.\n\nContext continuity:\n- Prefer TriWiki coordinate context packs over ad hoc summaries whenever route continuity matters.\n- Use relevant TriWiki context before every route stage, not only at initial setup.\n- Hydrate low-trust or stale wiki claims from their source path/hash/RGBA anchor during the stage before relying on them.\n- Run \`sks wiki refresh\` or \`sks wiki pack\` after new findings, changed artifacts, scout results, debate conclusions, implementation changes, reviews, or blockers.\n- Validate with \`sks wiki validate .sneakoscope/wiki/context-pack.json\` before handoffs and final claims.\n- Treat RGBA wiki anchors as hydratable pointers: selected text is only the visible slice; non-selected claims remain recoverable by id, hash, source path, and trigonometric coordinate.\n`,
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
    'research-discovery': `---\nname: research-discovery\ndescription: Run SKS Research Mode for frontier-style research, new hypothesis generation, novelty ledgers, falsification, and testable experiments.\n---\n\nUse when the user asks for research, new discoveries, frontier exploration, deep investigation, hypothesis generation, or non-obvious insights.\n\nMethod:\n1. Frame what would count as a discovery and what evidence would be required.\n2. Map nearby concepts, assumptions, baselines, and constraints.\n3. Generate competing hypotheses across mechanisms, analogies, edge cases, and failure modes.\n4. Falsify aggressively: counterexamples, missing evidence, alternate explanations, and safety boundaries.\n5. Synthesize only the surviving pieces into candidate insights.\n6. For every candidate insight, write novelty, confidence, falsifiability, evidence, falsifiers, and next_experiment to novelty-ledger.json.\n7. Produce research-report.md with concise findings and uncertainty.\n8. Pass research-gate.json only when at least one candidate insight survived falsification and has a testable prediction or experiment.\n\nQuality bar:\n- Do not summarize only; produce mechanisms, predictions, experiments, or implementation probes.\n- Do not claim breakthrough novelty without ledger evidence and uncertainty.\n- Prefer small decisive tests over broad speculation.\n- Keep raw notes bounded and cite artifact paths in final output.\n`,
    'performance-evaluator': `---\nname: performance-evaluator\ndescription: Evaluate whether SKS changes create meaningful performance, token-saving, accuracy-proxy, context-compression, or workflow improvements.\n---\n\nUse when a task claims faster execution, smaller prompts, better context quality, higher accuracy, or lower token cost.\n\nWorkflow:\n- Run sks eval run for the deterministic built-in benchmark.\n- Use sks eval compare --baseline old.json --candidate new.json for before/after report comparisons.\n- Report token_savings_pct, accuracy_delta, required_recall, unsupported_critical_selected, and meaningful_improvement.\n- Treat accuracy_proxy as evidence-weighted context quality, not live model task accuracy, unless an explicitly scored dataset was used.\n- For performance-sensitive work, set done-gate.json performance_evaluation_required/present fields and include the eval report path as evidence.\n`,
    'design-artifact-expert': `---\nname: design-artifact-expert\ndescription: Create or revise high-fidelity HTML, UI, prototype, deck-like, or visual design artifacts using project design context, variations, and rendered verification.\n---\n\nUse when the user asks for design, UI, prototype, HTML artifact, landing page, deck-like visual work, interaction design, or visual refinement.\n\nWorkflow:\n1. Understand the artifact, audience, constraints, fidelity, variants, and existing brand/design system.\n2. Inspect local code, assets, screenshots, or design-system docs before inventing visuals. If context exists, follow its visual vocabulary.\n3. Build the actual usable screen or artifact first; avoid empty landing-page framing unless the task is explicitly marketing.\n4. Use descriptive HTML filenames. Keep large artifacts split into small support files when needed.\n5. For screens/slides, add data-screen-label attributes for comment context. Slide labels are 1-indexed.\n6. Preserve state for decks, videos, or multi-step prototypes with localStorage when refresh continuity matters.\n7. Expose a small Tweaks surface for useful variants such as layout, density, color, copy, or interaction options.\n8. Verify the artifact renders cleanly in a browser or preview. For design tasks, set done-gate.json design_verification_required/present fields and cite evidence.\n\nQuality bar:\n- Root design decisions in available assets and components.\n- Use restrained, domain-appropriate layout and typography.\n- Avoid text overlap, unreadable controls, decorative clutter, one-note palettes, and placeholder-only deliverables.\n- Prefer icons and familiar controls for tool actions, and make repeated UI dimensions stable.\n`
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
