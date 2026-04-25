import path from 'node:path';
import { ensureDir, writeJsonAtomic, writeTextAtomic, mergeManagedBlock, nowIso, PACKAGE_VERSION, exists } from './fsx.mjs';
import { DEFAULT_RETENTION_POLICY } from './retention.mjs';
import { DEFAULT_DB_SAFETY_POLICY } from './db-safety.mjs';

const AGENTS_BLOCK = `
# Sneakoscope Codex Managed Rules

This repository uses Sneakoscope Codex.

## Ralph No-Question Rule

Ralph may ask questions only during prepare. After decision-contract.json is sealed and Ralph run starts, the assistant must not ask the user questions, request confirmation, or present choices. Resolve using the decision ladder.

## Performance and Retention

Sneakoscope Codex keeps runtime state bounded. Do not write large raw logs into prompts. Store raw outputs in files, keep only tails/summaries in JSON, and allow sks gc to remove old arenas, temp files, and stale mission logs.

## Source Priority

1. Current code, tests, config
2. decision-contract.json
3. vgraph.json
4. beta.json
5. LLM Wiki
6. visual parse
7. model knowledge only if explicitly allowed

## Database Safety

Sneakoscope Codex treats database access as high risk. Destructive database operations are never allowed: DROP, TRUNCATE, mass DELETE/UPDATE, reset, push, repair, project deletion, branch reset/merge/delete, RLS disabling, broad grants/revokes, and any operation that could erase or overwrite data. Supabase/Postgres MCP should be read-only and project-scoped by default. Live database writes must not be performed through direct execute_sql; schema changes must be migration-file based and allowed only for local or preview/branch environments by the sealed contract.

## Done Means

A task is not done until relevant tests are run or justified, unsupported critical claims are zero, database safety violations are zero, visual/wiki drift is low or explicitly accepted, and final output includes evidence.
`;

export async function initProject(root, opts = {}) {
  const created = [];
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
    database_safety: 'destructive_db_operations_denied_always'
  });
  created.push('.sneakoscope/manifest.json');

  const dbSafetyPath = path.join(sine, 'db-safety.json');
  if (!(await exists(dbSafetyPath)) || opts.force) {
    await writeJsonAtomic(dbSafetyPath, DEFAULT_DB_SAFETY_POLICY);
    created.push('.sneakoscope/db-safety.json');
  }

  const policyPath = path.join(sine, 'policy.json');
  if (!(await exists(policyPath)) || opts.force) {
    await writeJsonAtomic(policyPath, {
      schema_version: 1,
      retention: DEFAULT_RETENTION_POLICY,
      database_safety: DEFAULT_DB_SAFETY_POLICY,
      performance: {
        max_parallel_sessions: 2,
        process_tail_bytes: 262144,
        codex_timeout_ms: 1800000,
        prefer_streaming_logs: true
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
      }
    });
    created.push('.sneakoscope/policy.json');
  }

  const currentState = path.join(sine, 'state', 'current.json');
  if (!(await exists(currentState)) || opts.force) {
    await writeJsonAtomic(currentState, { mode: 'IDLE', phase: 'IDLE', updated_at: nowIso() });
    created.push('.sneakoscope/state/current.json');
  }

  await mergeManagedBlock(path.join(root, 'AGENTS.md'), 'Sneakoscope Codex GX MANAGED BLOCK', AGENTS_BLOCK);
  created.push('AGENTS.md managed block');

  await writeTextAtomic(path.join(root, '.codex', 'config.toml'), `[features]\ncodex_hooks = true\n\n[profiles.sks-ralph]\nmodel = "gpt-5.5"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "high"\n\n[profiles.sks-default]\nmodel = "gpt-5.5"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\nmodel_reasoning_effort = "medium"\n`);
  created.push('.codex/config.toml');

  await writeJsonAtomic(path.join(root, '.codex', 'hooks.json'), {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'sks hook user-prompt-submit' }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'sks hook pre-tool' }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'sks hook post-tool' }] }],
      PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'sks hook permission-request' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'sks hook stop' }] }]
    }
  });
  created.push('.codex/hooks.json');

  await installSkills(root);
  created.push('.agents/skills/*');
  return { created };
}

async function installSkills(root) {
  const skills = {
    'ralph-supervisor': `---\nname: ralph-supervisor\ndescription: Run the Ralph no-question loop after a decision contract is sealed.\n---\n\nYou are the Ralph Supervisor.\n\nRules:\n- Never ask the user during Ralph run.\n- Use decision-contract.json and the decision ladder.\n- Continue until done-gate.json passes or safe scope is completed with explicit limitation.\n- Keep outputs bounded. Write raw logs to files and summarize only tails.\n- Database destructive operations are never allowed.\n- Write progress to .sneakoscope mission files.\n`,
    'ralph-resolver': `---\nname: ralph-resolver\ndescription: Resolve newly discovered ambiguity during Ralph using the sealed decision ladder, without asking the user.\n---\n\nResolve ambiguity in this order: seed contract, explicit answers, approved defaults, AGENTS.md, current code/tests, smallest reversible change, defer optional scope. Never ask the user. If database risk is involved, prefer read-only, no-op, local-only migration file, or safe limitation; never run destructive SQL.\n`,
    'hproof-claim-ledger': `---\nname: hproof-claim-ledger\ndescription: Extract atomic claims and classify support status.\n---\n\nEvery factual statement must become an atomic claim. Unsupported critical claims cannot be used for implementation or final answer. Database claims require DB safety evidence.\n`,
    'hproof-evidence-bind': `---\nname: hproof-evidence-bind\ndescription: Bind claims to code, tests, decision contract, vgraph, beta, wiki, or visual parse evidence.\n---\n\nEvidence priority: current code/tests, decision-contract.json, vgraph.json, beta.json, wiki, visual parse, user prompt. Database claims must respect .sneakoscope/db-safety.json.\n`,
    'db-safety-guard': `---\nname: db-safety-guard\ndescription: Enforce Sneakoscope Codex database safety before using SQL, Supabase MCP, Postgres, Prisma, Drizzle, Knex, or migration commands.\n---\n\nRules:\n- Never run DROP, TRUNCATE, mass DELETE/UPDATE, db reset, db push, project deletion, branch reset/merge/delete, or RLS-disabling operations.\n- Supabase MCP must be read-only and project-scoped by default.\n- Live writes through execute_sql are blocked; use migration files and only local/preview branches if explicitly allowed.\n- Production writes are forbidden.\n- If unsure, read-only only.\n`,
    'gx-visual-generate': `---\nname: gx-visual-generate\ndescription: Generate a visual sheet using GPT Image 2 from vgraph.json and beta.json.\n---\n\nUse built-in GPT Image 2 / $imagegen only. Do not use external diagram tools. vgraph.json is source of truth.\n`,
    'gx-visual-read': `---\nname: gx-visual-read\ndescription: Read a Sneakoscope Codex visual sheet and produce parse.json.\n---\n\nExtract nodes, edges, invariants, tests, risks, and uncertainties. Do not infer hidden nodes.\n`,
    'gx-visual-validate': `---\nname: gx-visual-validate\ndescription: Validate visual parse against vgraph.json and beta.json.\n---\n\nIf critical nodes, edges, or invariants are missing, mark validation failed.\n`,
    'turbo-context-pack': `---\nname: turbo-context-pack\ndescription: Build ultra-low-token context packet with Q4 bits, Q3 tags, top-K claims, and minimal evidence.\n---\n\nDefault to Q4/Q3 only. Add Q2 or Q1 only when needed for support or verification.\n`
  };
  for (const [name, content] of Object.entries(skills)) {
    const dir = path.join(root, '.agents', 'skills', name);
    await ensureDir(dir);
    await writeTextAtomic(path.join(dir, 'SKILL.md'), `${content.trim()}\n`);
  }
}
