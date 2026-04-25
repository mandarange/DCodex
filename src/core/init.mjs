import path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic, writeTextAtomic, mergeManagedBlock, nowIso, PACKAGE_VERSION, exists } from './fsx.mjs';
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

## Evaluation

When a task claims performance, token, accuracy, context-compression, or workflow improvement, produce evidence with sks eval run or sks eval compare. Do not claim live model accuracy unless the run used an explicitly scored task dataset; otherwise call it an evidence-weighted accuracy proxy.

## Research Mode

When the user asks for research, new discoveries, hypothesis generation, frontier exploration, or deep investigation, use SKS Research Mode. Research must produce candidate insights, falsification attempts, a novelty ledger, and testable next experiments. Do not present a breakthrough claim unless it is explicitly marked with evidence, confidence, falsifiers, and uncertainty.

## Design Execution

When creating HTML, UI, prototype, deck-like, or visual artifacts, use the local design artifact skill. Gather design context first, build the actual usable experience rather than a marketing placeholder, expose variations when useful, and verify the rendered artifact before handoff.

## Source Priority

1. Current code, tests, config
2. decision-contract.json
3. vgraph.json
4. beta.json
5. GX render/snapshot metadata
6. LLM Wiki
7. model knowledge only if explicitly allowed

## Database Safety

Sneakoscope Codex treats database access as high risk. Destructive database operations are never allowed: DROP, TRUNCATE, mass DELETE/UPDATE, reset, push, repair, project deletion, branch reset/merge/delete, RLS disabling, broad grants/revokes, and any operation that could erase or overwrite data. Supabase/Postgres MCP should be read-only and project-scoped by default. Live database writes must not be performed through direct execute_sql; schema changes must be migration-file based and allowed only for local or preview/branch environments by the sealed contract.

## Done Means

A task is not done until relevant tests are run or justified, unsupported critical claims are zero, database safety violations are zero, visual/wiki drift is low or explicitly accepted, and final output includes evidence.
`;

export async function initProject(root, opts = {}) {
  const created = [];
  const installScope = normalizeInstallScope(opts.installScope || 'global');
  const hookCommandPrefix = opts.hookCommandPrefix || sksCommandPrefix(installScope, { globalCommand: opts.globalCommand });
  const sine = path.join(root, '.sneakoscope');
  const dirs = [
    '.sneakoscope/state', '.sneakoscope/missions', '.sneakoscope/db', '.sneakoscope/bus', '.sneakoscope/hproof', '.sneakoscope/db', '.sneakoscope/memory/q0_raw', '.sneakoscope/memory/q1_evidence', '.sneakoscope/memory/q2_facts', '.sneakoscope/memory/q3_tags', '.sneakoscope/memory/q4_bits', '.sneakoscope/gx/cartridges', '.sneakoscope/model/fingerprints', '.sneakoscope/genome/candidates', '.sneakoscope/trajectories/raw', '.sneakoscope/locks', '.sneakoscope/tmp', '.sneakoscope/arenas', '.sneakoscope/reports', '.codex', '.agents/skills'
  ];
  for (const d of dirs) await ensureDir(path.join(root, d));

  await writeJsonAtomic(path.join(sine, 'manifest.json'), {
    package: 'sneakoscope',
    version: PACKAGE_VERSION,
    initialized_at: nowIso(),
    no_external_tools: true,
    codex_required: true,
    native_runtime_dependencies: 0,
    installation: {
      scope: installScope,
      default_scope: 'global',
      hook_command_prefix: hookCommandPrefix,
      global_command: opts.globalCommand || 'sks',
      project_command: 'node ./node_modules/sneakoscope/bin/sks.mjs'
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
      installation: installPolicy(installScope, hookCommandPrefix)
    });
  }

  function defaultPolicy(scope, commandPrefix) {
    return {
      schema_version: 1,
      installation: installPolicy(scope, commandPrefix),
      retention: DEFAULT_RETENTION_POLICY,
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

  await mergeManagedBlock(path.join(root, 'AGENTS.md'), 'Sneakoscope Codex GX MANAGED BLOCK', AGENTS_BLOCK);
  created.push('AGENTS.md managed block');

  await writeTextAtomic(path.join(root, '.codex', 'config.toml'), `[features]\ncodex_hooks = true\n\n[profiles.sks-ralph]\nmodel = "gpt-5.5"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "high"\n\n[profiles.sks-research]\nmodel = "gpt-5.5"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "xhigh"\n\n[profiles.sks-default]\nmodel = "gpt-5.5"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "medium"\n`);
  created.push('.codex/config.toml');

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

  await installSkills(root);
  created.push('.agents/skills/*');
  return { created };
}

async function installSkills(root) {
  const skills = {
    'ralph-supervisor': `---\nname: ralph-supervisor\ndescription: Run the Ralph no-question loop after a decision contract is sealed.\n---\n\nYou are the Ralph Supervisor.\n\nRules:\n- Never ask the user during Ralph run.\n- Use decision-contract.json and the decision ladder.\n- Continue until done-gate.json passes or safe scope is completed with explicit limitation.\n- Keep outputs bounded. Write raw logs to files and summarize only tails.\n- Database destructive operations are never allowed.\n- Write progress to .sneakoscope mission files.\n`,
    'ralph-resolver': `---\nname: ralph-resolver\ndescription: Resolve newly discovered ambiguity during Ralph using the sealed decision ladder, without asking the user.\n---\n\nResolve ambiguity in this order: seed contract, explicit answers, approved defaults, AGENTS.md, current code/tests, smallest reversible change, defer optional scope. Never ask the user. If database risk is involved, prefer read-only, no-op, local-only migration file, or safe limitation; never run destructive SQL.\n`,
    'hproof-claim-ledger': `---\nname: hproof-claim-ledger\ndescription: Extract atomic claims and classify support status.\n---\n\nEvery factual statement must become an atomic claim. Unsupported critical claims cannot be used for implementation or final answer. Database claims require DB safety evidence.\n`,
    'hproof-evidence-bind': `---\nname: hproof-evidence-bind\ndescription: Bind claims to code, tests, decision contract, vgraph, beta, wiki, or GX render evidence.\n---\n\nEvidence priority: current code/tests, decision-contract.json, vgraph.json, beta.json, GX snapshot/render metadata, wiki, user prompt. Database claims must respect .sneakoscope/db-safety.json.\n`,
    'db-safety-guard': `---\nname: db-safety-guard\ndescription: Enforce Sneakoscope Codex database safety before using SQL, Supabase MCP, Postgres, Prisma, Drizzle, Knex, or migration commands.\n---\n\nRules:\n- Never run DROP, TRUNCATE, mass DELETE/UPDATE, db reset, db push, project deletion, branch reset/merge/delete, or RLS-disabling operations.\n- Supabase MCP must be read-only and project-scoped by default.\n- Live writes through execute_sql are blocked; use migration files and only local/preview branches if explicitly allowed.\n- Production writes are forbidden.\n- If unsure, read-only only.\n`,
    'gx-visual-generate': `---\nname: gx-visual-generate\ndescription: Render a deterministic SVG/HTML visual sheet from vgraph.json and beta.json.\n---\n\nUse sks gx render. Do not use external image generation. vgraph.json is the source of truth and the SVG embeds its source hash.\n`,
    'gx-visual-read': `---\nname: gx-visual-read\ndescription: Read a Sneakoscope Codex deterministic visual sheet and produce context notes.\n---\n\nExtract nodes, edges, invariants, tests, risks, and uncertainties from vgraph.json, beta.json, render.svg, or snapshot.json. Do not infer hidden nodes.\n`,
    'gx-visual-validate': `---\nname: gx-visual-validate\ndescription: Validate render metadata against vgraph.json and beta.json.\n---\n\nRun sks gx validate and sks gx drift. If critical nodes, edges, or invariants are missing or the render hash is stale, mark validation failed.\n`,
    'turbo-context-pack': `---\nname: turbo-context-pack\ndescription: Build ultra-low-token context packet with Q4 bits, Q3 tags, top-K claims, and minimal evidence.\n---\n\nDefault to Q4/Q3 only. Add Q2 or Q1 only when needed for support or verification.\n`,
    'research-discovery': `---\nname: research-discovery\ndescription: Run SKS Research Mode for frontier-style research, new hypothesis generation, novelty ledgers, falsification, and testable experiments.\n---\n\nUse when the user asks for research, new discoveries, frontier exploration, deep investigation, hypothesis generation, or non-obvious insights.\n\nMethod:\n1. Frame what would count as a discovery and what evidence would be required.\n2. Map nearby concepts, assumptions, baselines, and constraints.\n3. Generate competing hypotheses across mechanisms, analogies, edge cases, and failure modes.\n4. Falsify aggressively: counterexamples, missing evidence, alternate explanations, and safety boundaries.\n5. Synthesize only the surviving pieces into candidate insights.\n6. For every candidate insight, write novelty, confidence, falsifiability, evidence, falsifiers, and next_experiment to novelty-ledger.json.\n7. Produce research-report.md with concise findings and uncertainty.\n8. Pass research-gate.json only when at least one candidate insight survived falsification and has a testable prediction or experiment.\n\nQuality bar:\n- Do not summarize only; produce mechanisms, predictions, experiments, or implementation probes.\n- Do not claim breakthrough novelty without ledger evidence and uncertainty.\n- Prefer small decisive tests over broad speculation.\n- Keep raw notes bounded and cite artifact paths in final output.\n`,
    'performance-evaluator': `---\nname: performance-evaluator\ndescription: Evaluate whether SKS changes create meaningful performance, token-saving, accuracy-proxy, context-compression, or workflow improvements.\n---\n\nUse when a task claims faster execution, smaller prompts, better context quality, higher accuracy, or lower token cost.\n\nWorkflow:\n- Run sks eval run for the deterministic built-in benchmark.\n- Use sks eval compare --baseline old.json --candidate new.json for before/after report comparisons.\n- Report token_savings_pct, accuracy_delta, required_recall, unsupported_critical_selected, and meaningful_improvement.\n- Treat accuracy_proxy as evidence-weighted context quality, not live model task accuracy, unless an explicitly scored dataset was used.\n- For performance-sensitive work, set done-gate.json performance_evaluation_required/present fields and include the eval report path as evidence.\n`,
    'design-artifact-expert': `---\nname: design-artifact-expert\ndescription: Create or revise high-fidelity HTML, UI, prototype, deck-like, or visual design artifacts using project design context, variations, and rendered verification.\n---\n\nUse when the user asks for design, UI, prototype, HTML artifact, landing page, deck-like visual work, interaction design, or visual refinement.\n\nWorkflow:\n1. Understand the artifact, audience, constraints, fidelity, variants, and existing brand/design system.\n2. Inspect local code, assets, screenshots, or design-system docs before inventing visuals. If context exists, follow its visual vocabulary.\n3. Build the actual usable screen or artifact first; avoid empty landing-page framing unless the task is explicitly marketing.\n4. Use descriptive HTML filenames. Keep large artifacts split into small support files when needed.\n5. For screens/slides, add data-screen-label attributes for comment context. Slide labels are 1-indexed.\n6. Preserve state for decks, videos, or multi-step prototypes with localStorage when refresh continuity matters.\n7. Expose a small Tweaks surface for useful variants such as layout, density, color, copy, or interaction options.\n8. Verify the artifact renders cleanly in a browser or preview. For design tasks, set done-gate.json design_verification_required/present fields and cite evidence.\n\nQuality bar:\n- Root design decisions in available assets and components.\n- Use restrained, domain-appropriate layout and typography.\n- Avoid text overlap, unreadable controls, decorative clutter, one-note palettes, and placeholder-only deliverables.\n- Prefer icons and familiar controls for tool actions, and make repeated UI dimensions stable.\n`
  };
  for (const [name, content] of Object.entries(skills)) {
    const dir = path.join(root, '.agents', 'skills', name);
    await ensureDir(dir);
    await writeTextAtomic(path.join(dir, 'SKILL.md'), `${content.trim()}\n`);
  }
}
