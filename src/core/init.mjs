import path from 'node:path';
import fsp from 'node:fs/promises';
import { ensureDir, readJson, readText, writeJsonAtomic, writeTextAtomic, mergeManagedBlock, nowIso, PACKAGE_VERSION, exists } from './fsx.mjs';
import { DEFAULT_RETENTION_POLICY } from './retention.mjs';
import { DEFAULT_DB_SAFETY_POLICY } from './db-safety.mjs';

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

const AGENTS_BLOCK = `
# Sneakoscope Codex Managed Rules

This repository uses Sneakoscope Codex.

## Ralph No-Question Rule

Ralph may ask questions only during prepare. After decision-contract.json is sealed and Ralph run starts, the assistant must not ask the user questions, request confirmation, or present choices. Resolve using the decision ladder.

## Performance and Retention

Sneakoscope Codex keeps runtime state bounded. Do not write large raw logs into prompts. Store raw outputs in files, keep only tails/summaries in JSON, and allow sks gc to remove old arenas, temp files, and stale mission logs.

## Update Check Before Work

Before any substantive work, SKS hooks check whether the installed SKS package is behind the latest published package. If an update is available, ask the user to choose between updating now and skipping the update for this conversation only. If the user skips, continue the current conversation without asking again, but check again in the next conversation. If the user accepts, update SKS, rerun setup/doctor, then continue the original task.

## Honest Mode Completion

Do not stop at a plan when implementation was requested. Continue until the stated goal is actually handled or a hard blocker is explicitly reported. Before the final answer, run SKS Honest Mode: re-check the goal, evidence, tests, risk boundaries, and remaining gaps. The final answer must be honest about what passed, what was not verified, and whether the goal is genuinely complete.

## Evaluation

When a task claims performance, token, accuracy, context-compression, or workflow improvement, produce evidence with sks eval run or sks eval compare. Do not claim live model accuracy unless the run used an explicitly scored task dataset; otherwise call it an evidence-weighted accuracy proxy.

## Research Mode

When the user asks for research, new discoveries, hypothesis generation, frontier exploration, or deep investigation, use SKS Research Mode. Research must produce candidate insights, falsification attempts, a novelty ledger, and testable next experiments. Do not present a breakthrough claim unless it is explicitly marked with evidence, confidence, falsifiers, and uncertainty.

## AutoResearch Loop

For open-ended improvement, discovery, prompt, evaluation, ranking, SEO/GEO, or workflow-quality tasks, use the SKS AutoResearch loop inspired by iterative hypothesis search: define a program, choose a metric, run the smallest useful experiment, keep or discard the result, record the ledger, falsify the best candidate, and repeat within budget. Do not claim an improvement without evidence.

## Team Orchestration

When the user invokes Team mode or \`$Team\`, use Codex multi-agent/subagent orchestration. The first team is a planning and debate team: spawn focused read-only/explorer agents to map the code, risks, DB safety, tests, and options. Synthesize their results into a single agreed objective, constraints, and implementation slices. Close or stop planning agents once the objective is sealed. Then form a fresh implementation team with disjoint ownership scopes, normally workers plus reviewers, and run the implementation in parallel where write sets do not overlap. The parent agent remains the orchestrator: it assigns ownership, watches hook output, waits only when blocked, integrates results, runs verification, and produces the final evidence. Do not let subagents make destructive database changes or bypass SKS hooks.

## Design Execution

When creating HTML, UI, prototype, deck-like, or visual artifacts, use the local design artifact skill. Gather design context first, build the actual usable experience rather than a marketing placeholder, expose variations when useful, and verify the rendered artifact before handoff.

## Prompt Optimization Pipeline

Every user prompt enters the SKS prompt optimization pipeline even when the user does not type a command. Extract intent, target files or surfaces, constraints, acceptance criteria, risks, and the smallest safe execution path before acting. Choose the lightest matching route: fast edit, normal implementation, Ralph, Research, DB safety, GX, or evaluation. Do not run heavy Ralph/research/evaluation loops for simple direct edits.

## LLM Wiki Continuity

TriWiki context is anchor-first, not lossy-summary-first. Important claims, visual nodes, policy facts, and evidence pointers should receive deterministic RGBA wiki coordinates: R maps to domain angle, G maps to layer radius through sine, B maps to phase angle, and A maps to concentration/confidence. Use those trigonometric coordinates to preserve stable retrieval anchors across turns. Selected claims may be pasted as text, but non-selected claims must remain hydratable through id, hash, source path, and RGBA coordinate anchors instead of disappearing from the workflow.

## Dollar Commands

Codex App users may invoke local SKS modes with skill-style dollar commands. \`$DF\` is the fast design/content fix route for small changes such as text color, copy edits, label changes, spacing tweaks, or translating visible text. \`$DF\` should avoid broad redesign, avoid unnecessary planning loops, and make the requested change directly with only cheap verification when useful.

## Codex App Usage

When this repository is opened in Codex App, use the local Sneakoscope files as the app control surface. Read \`.codex/SNEAKOSCOPE.md\` for the quick reference, load project skills from \`.codex/skills\` when applicable, and use the generated \`.codex/hooks.json\` hooks for DB safety, no-question Ralph runs, retention, and done-gate enforcement.

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
  const hookCommandPrefix = opts.hookCommandPrefix || sksCommandPrefix(installScope, { globalCommand: opts.globalCommand });
  const sine = path.join(root, '.sneakoscope');
  const dirs = [
    '.sneakoscope/state', '.sneakoscope/missions', '.sneakoscope/db', '.sneakoscope/bus', '.sneakoscope/hproof', '.sneakoscope/db', '.sneakoscope/wiki', '.sneakoscope/memory/q0_raw', '.sneakoscope/memory/q1_evidence', '.sneakoscope/memory/q2_facts', '.sneakoscope/memory/q3_tags', '.sneakoscope/memory/q4_bits', '.sneakoscope/gx/cartridges', '.sneakoscope/model/fingerprints', '.sneakoscope/genome/candidates', '.sneakoscope/trajectories/raw', '.sneakoscope/locks', '.sneakoscope/tmp', '.sneakoscope/arenas', '.sneakoscope/reports', '.codex', '.codex/skills', '.codex/agents'
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
      skills: '.codex/skills',
      agents: '.codex/agents',
      quick_reference: '.codex/SNEAKOSCOPE.md',
      agents_rules: 'AGENTS.md'
    },
    prompt_pipeline: {
      default_enabled: true,
      dollar_commands: ['$DF', '$SKS', '$Team', '$Ralph', '$Research', '$AutoResearch', '$DB', '$GX', '$Help'],
      fast_design_command: '$DF'
    },
    llm_wiki: {
      coordinate_schema: 'sks.wiki-coordinate.v1',
      channel_map: { r: 'domainAngle', g: 'layerRadius', b: 'phase', a: 'concentration' },
      continuity_model: 'selected_text_plus_hydratable_rgba_trig_anchors'
    },
    git: {
      local_only: localOnly,
      exclude_path: localExclude?.path ? path.relative(root, localExclude.path) : null,
      excluded_patterns: localExclude?.patterns || []
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
        excluded_patterns: localExclude?.patterns || policy.git?.excluded_patterns || []
      }
    });
  }

  function defaultPolicy(scope, commandPrefix) {
    return {
      schema_version: 1,
      installation: installPolicy(scope, commandPrefix),
      git: {
        local_only: localOnly,
        exclude_path: localExclude?.path ? path.relative(root, localExclude.path) : null,
        excluded_patterns: localExclude?.patterns || []
      },
      retention: DEFAULT_RETENTION_POLICY,
      update_check: {
        enabled: true,
        package: 'sneakoscope',
        prompt_user_before_work: true,
        skip_scope: 'conversation_only'
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
        coordinate_schema: 'sks.wiki-coordinate.v1',
        default_pack: '.sneakoscope/wiki/context-pack.json',
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
        skills: '.codex/skills',
        agents: '.codex/agents',
        quick_reference: '.codex/SNEAKOSCOPE.md',
        agents_rules: 'AGENTS.md'
      },
      prompt_pipeline: {
        default_enabled: true,
        route_without_command: true,
        dollar_commands: ['$DF', '$SKS', '$Team', '$Ralph', '$Research', '$AutoResearch', '$DB', '$GX', '$Help'],
        fast_design_command: '$DF'
      }
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
  if (localOnly && await exists(agentsMdPath)) {
    created.push('AGENTS.md skipped (local-only existing file)');
  } else {
    await mergeManagedBlock(agentsMdPath, 'Sneakoscope Codex GX MANAGED BLOCK', AGENTS_BLOCK);
    created.push('AGENTS.md managed block');
  }

  await writeTextAtomic(path.join(root, '.codex', 'config.toml'), `[features]\ncodex_hooks = true\nmulti_agent = true\n\n[agents]\nmax_threads = 6\nmax_depth = 1\n\n[agents.team_consensus]\ndescription = "Planning and debate agent for SKS Team mode. Maps options, constraints, risks, and proposes the agreed objective before implementation starts."\nconfig_file = "./agents/team-consensus.toml"\nnickname_candidates = ["Consensus", "Atlas"]\n\n[agents.implementation_worker]\ndescription = "Implementation worker for SKS Team mode. Owns a clearly bounded write set and coordinates with other workers without reverting their edits."\nconfig_file = "./agents/implementation-worker.toml"\nnickname_candidates = ["Builder", "Mason"]\n\n[agents.db_safety_reviewer]\ndescription = "Read-only database safety reviewer for SQL, migrations, RLS, destructive-operation risk, and rollback safety."\nconfig_file = "./agents/db-safety-reviewer.toml"\nnickname_candidates = ["Sentinel", "Ledger"]\n\n[agents.qa_reviewer]\ndescription = "Read-only verification reviewer for correctness, tests, regressions, and missing evidence."\nconfig_file = "./agents/qa-reviewer.toml"\nnickname_candidates = ["Verifier", "Scout"]\n\n[profiles.sks-ralph]\nmodel = "gpt-5.5"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "high"\n\n[profiles.sks-research]\nmodel = "gpt-5.5"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "xhigh"\n\n[profiles.sks-team]\nmodel = "gpt-5.5"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "high"\n\n[profiles.sks-default]\nmodel = "gpt-5.5"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "medium"\n`);
  created.push('.codex/config.toml');

  await writeTextAtomic(path.join(root, '.codex', 'SNEAKOSCOPE.md'), codexAppQuickReference(installScope, hookCommandPrefix));
  created.push('.codex/SNEAKOSCOPE.md');

  await writeJsonAtomic(path.join(root, '.codex', 'hooks.json'), {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: sksHookCommand(hookCommandPrefix, 'user-prompt-submit') }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: sksHookCommand(hookCommandPrefix, 'pre-tool') }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: sksHookCommand(hookCommandPrefix, 'post-tool') }] }],
      PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: sksHookCommand(hookCommandPrefix, 'permission-request') }] }],
      Stop: [{ hooks: [{ type: 'command', command: sksHookCommand(hookCommandPrefix, 'stop') }] }]
    }
  });
  created.push(`.codex/hooks.json (${installScope})`);

  const skillInstall = await installSkills(root);
  created.push('.codex/skills/*');
  if (skillInstall.removed_legacy_agent_skill_dirs.length) created.push(`.agents/skills legacy mirrors removed (${skillInstall.removed_legacy_agent_skill_dirs.length})`);
  await installCodexAgents(root);
  created.push('.codex/agents/*');
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
- App skills: \`.codex/skills/\`
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
${commandPrefix} install-prompt
${commandPrefix} codex-app
${commandPrefix} wiki pack
\`\`\`

## Dollar Commands

- \`$DF\`: fast design/content fix. Use for color, copy, label, spacing, translation, or small UI edits.
- \`$SKS\`: general Sneakoscope workflow/help route.
- \`$Team\`: Codex multi-agent team route for debate, agreement, fresh implementation team, and parallel execution.
- \`$Ralph\`: clarification-gated autonomous mission route.
- \`$Research\`: frontier research route.
- \`$AutoResearch\`: iterative experiment loop for improvement, SEO/GEO, ranking, prompt, and workflow-quality tasks.
- \`$DB\`: database/Supabase safety route.
- \`$GX\`: deterministic visual context route.
- \`$Help\`: explain installed commands and workflows.

The prompt optimization pipeline also runs without a dollar command and infers the lightest route automatically.

## Update And Honest Mode

- Before work: hooks check for a newer \`sneakoscope\` package and ask whether to update now or skip for this conversation only.
- Before final: hooks require SKS Honest Mode, a short verification pass covering goal completion, evidence/tests, and remaining gaps.

## Common App Prompts

- "Use Sneakoscope Ralph mode to prepare this task."
- "$Team agree on the best plan, then implement it with a fresh specialist team."
- "$DF change the button text to English."
- "Run the latest Ralph mission with the sealed decision contract."
- "Use SKS DB safety before touching database or Supabase files."
- "Use SKS research mode for this investigation."

## CLI Bridge

Codex App can call the same project-local control surface through terminal commands:

\`\`\`bash
${commandPrefix} setup
${commandPrefix} doctor
${commandPrefix} ralph prepare "task"
${commandPrefix} ralph status latest
${commandPrefix} research prepare "topic"
${commandPrefix} team "task"
${commandPrefix} wiki pack
${commandPrefix} wiki validate
${commandPrefix} db scan --migrations
\`\`\`

The hooks file routes Codex App tool events through SKS guards for no-question mode, DB safety, permission requests, and done-gate checks.
`;
}

async function installSkills(root) {
  const skills = {
    'DF': `---\nname: DF\ndescription: Fast design/content fix mode for $DF requests and inferred simple edits such as text color, copy, labels, spacing, or translation.\n---\n\nYou are running SKS DF mode.\n\nPurpose:\n- Quickly convert a small design/content request into the exact implementation change.\n- Use for requests like 글자 색 바꿔줘, 내용을 영어로 바꿔줘, button label 수정, spacing 조정, copy replacement, simple style tweaks.\n\nRules:\n- Do not start Ralph, Research, eval, or broad redesign unless the user explicitly asks.\n- Do not ask for more requirements when the target can be inferred from local context.\n- Inspect only the files needed to locate the target.\n- Make the smallest scoped edit that satisfies the request.\n- Preserve the existing design system and component patterns.\n- Run only cheap verification when useful, such as syntax check, focused test, or local render check for visual risk.\n- Final response should be short: what changed and any verification.\n`,
    'SKS': `---\nname: SKS\ndescription: General Sneakoscope Codex command route for $SKS usage, setup, status, and workflow help.\n---\n\nUse the local SKS control surface. Prefer these discovery commands when the user asks what is available: sks commands, sks usage <topic>, sks quickstart, sks codex-app, sks install-prompt. If implementation is requested, route to the lightest matching SKS path.\n`,
    'Team': `---\nname: Team\ndescription: Dollar-command route for SKS Team multi-agent orchestration: debate, consensus, fresh implementation team, parallel execution, and final integration.\n---\n\nUse when the user invokes $Team, asks for a team of agents, or asks for parallel specialist implementation.\n\nWorkflow:\n1. Create or inspect the Team mission with sks team \"task\" when useful.\n2. Planning phase: spawn read-only/explorer specialists such as team_consensus, db_safety_reviewer, and qa_reviewer to map options, constraints, risks, and affected files.\n3. Consensus phase: synthesize the specialist results into one objective, explicit constraints, acceptance criteria, and disjoint implementation slices.\n4. Close or stop planning agents after their results are captured.\n5. Implementation phase: form a fresh team of implementation_worker agents with non-overlapping ownership. Tell workers they are not alone in the codebase and must not revert others' edits.\n6. Review phase: run qa_reviewer and db_safety_reviewer where relevant, then integrate results locally in the parent thread.\n7. Verification phase: run focused tests or justify gaps, update mission artifacts when present, and produce final evidence.\n\nRules:\n- The parent agent remains orchestrator and owns final integration.\n- Do not delegate the immediate blocking task when the parent can do it faster.\n- Never let subagents bypass SKS hooks, DB safety, no-question Ralph rules, or H-Proof completion gates.\n- Destructive database actions remain forbidden.\n`,
    'Ralph': `---\nname: Ralph\ndescription: Dollar-command route for SKS Ralph mandatory clarification and no-question mission workflows.\n---\n\nUse when the user invokes $Ralph or requests a clarification-gated autonomous implementation mission. Prepare with sks ralph prepare, answer/seal required slots when answers are provided, then run only after decision-contract.json exists.\n`,
    'Research': `---\nname: Research\ndescription: Dollar-command route for SKS Research frontier discovery workflows.\n---\n\nUse when the user invokes $Research or asks for research, hypotheses, new mechanisms, falsification, or testable predictions. Prefer sks research prepare and sks research run. Do not use for ordinary code edits.\n`,
    'AutoResearch': `---\nname: AutoResearch\ndescription: Dollar-command route for SKS AutoResearch iterative experiment loops.\n---\n\nUse when the user invokes $AutoResearch or asks for iterative improvement, SEO/GEO, ranking, prompt/workflow improvement, benchmark gains, or open-ended experimentation. Follow the autoresearch-loop skill: define program, hypothesis, experiment, metric, keep/discard decision, falsification, next experiment, and Honest Mode conclusion.\n`,
    'DB': `---\nname: DB\ndescription: Dollar-command route for database and Supabase safety checks.\n---\n\nUse when the user invokes $DB or the task touches SQL, Supabase, Postgres, migrations, Prisma, Drizzle, Knex, MCP database tools, or production data. Run or follow sks db policy, sks db scan, sks db classify, and sks db check. Destructive database operations remain forbidden.\n`,
    'GX': `---\nname: GX\ndescription: Dollar-command route for deterministic GX visual context cartridges.\n---\n\nUse when the user invokes $GX or asks for architecture/context visualization through SKS. Prefer sks gx init, render, validate, drift, and snapshot. vgraph.json remains the source of truth.\n`,
    'Help': `---\nname: Help\ndescription: Dollar-command route for explaining installed SKS commands and workflows.\n---\n\nUse when the user invokes $Help or asks what commands exist. Prefer concise output from sks commands, sks usage <topic>, sks quickstart, sks aliases, and sks codex-app.\n`,
    'prompt-pipeline': `---\nname: prompt-pipeline\ndescription: Default SKS prompt optimization pipeline that runs even without an explicit command.\n---\n\nFor every user request, silently extract intent, target surface, constraints, acceptance criteria, risk level, and the smallest safe route. Infer $DF for simple design/content edits. Use Ralph only for work that needs clarification gates, Research only for discovery work, DB only for database-risk work, GX only for visual context artifacts, and eval only when performance or context-quality claims need evidence.\n\nContext continuity:\n- Prefer TriWiki coordinate context packs over ad hoc summaries when a task spans turns.\n- Use \`sks wiki pack\` when context continuity, compression quality, or LLM Wiki state matters.\n- Treat RGBA wiki anchors as hydratable pointers: selected text is only the visible slice; non-selected claims remain recoverable by id, hash, source path, and trigonometric coordinate.\n`,
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
    const dir = path.join(root, '.codex', 'skills', name);
    await ensureDir(dir);
    await writeTextAtomic(path.join(dir, 'SKILL.md'), `${content.trim()}\n`);
  }
  return { removed_legacy_agent_skill_dirs: await removeLegacyAgentSkillMirrors(root, Object.keys(skills)) };
}

async function removeLegacyAgentSkillMirrors(root, skillNames) {
  const legacyRoot = path.join(root, '.agents', 'skills');
  if (!(await exists(legacyRoot))) return [];
  const removed = [];
  for (const name of skillNames) {
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
    'team-consensus.toml': `name = "team_consensus"\ndescription = "Planning and debate specialist for SKS Team mode. Maps options, constraints, risks, and proposes the agreed objective before implementation starts."\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "high"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nYou are the SKS Team consensus specialist.\nDo not edit files.\nMap the affected code paths, viable approaches, constraints, risks, and acceptance criteria.\nArgue for the smallest coherent objective that can be handed to a fresh implementation team.\nReturn: recommended objective, rejected alternatives, implementation slices, required reviewers, and unresolved risks.\n"""\n`,
    'implementation-worker.toml': `name = "implementation_worker"\ndescription = "Implementation specialist for SKS Team mode. Owns one bounded write set and coordinates with other workers."\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "high"\nsandbox_mode = "workspace-write"\ndeveloper_instructions = """\nYou are an SKS Team implementation worker.\nYou are not alone in the codebase. Other workers may be editing disjoint files.\nOnly edit the files or module slice assigned to you.\nDo not revert or overwrite edits made by others.\nRead local patterns first, make the smallest correct change, run focused verification for your slice, and report changed paths plus evidence.\nRespect all SKS hooks, DB safety rules, no-question Ralph rules, and H-Proof completion gates.\n"""\n`,
    'db-safety-reviewer.toml': `name = "db_safety_reviewer"\ndescription = "Read-only database safety reviewer for SQL, migrations, Supabase, RLS, destructive-operation risk, and rollback safety."\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "high"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nYou are a database safety reviewer.\nNever modify files or execute destructive commands.\nReview migrations, SQL, Supabase RLS, transaction boundaries, rollback safety, and MCP database tool usage.\nBlock DROP, TRUNCATE, mass DELETE/UPDATE, db reset, db push, project deletion, branch reset/merge/delete, RLS disabling, and live execute_sql writes.\nReturn concrete risks, exact file references, and required fixes.\n"""\n`,
    'qa-reviewer.toml': `name = "qa_reviewer"\ndescription = "Read-only verification reviewer for correctness, regressions, missing tests, and final evidence."\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "high"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nYou are an SKS Team QA reviewer.\nDo not edit files.\nReview correctness, edge cases, regression risk, missing tests, and whether the final evidence proves the claimed outcome.\nPrioritize concrete findings with file references and focused verification suggestions.\nReturn no findings if the implementation is sound, and clearly list residual test gaps.\n"""\n`
  };
  const dir = path.join(root, '.codex', 'agents');
  await ensureDir(dir);
  for (const [file, content] of Object.entries(agents)) {
    await writeTextAtomic(path.join(dir, file), content);
  }
}
