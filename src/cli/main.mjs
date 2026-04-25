import path from 'node:path';
import fsp from 'node:fs/promises';
import { projectRoot, readJson, writeJsonAtomic, appendJsonlBounded, nowIso, exists, ensureDir, tmpdir, packageRoot, dirSize, formatBytes, which } from '../core/fsx.mjs';
import { initProject, normalizeInstallScope, sksCommandPrefix } from '../core/init.mjs';
import { getCodexInfo, runCodexExec } from '../core/codex-adapter.mjs';
import { createMission, loadMission, findLatestMission, setCurrent, stateFile } from '../core/mission.mjs';
import { buildQuestionSchema, writeQuestions } from '../core/questions.mjs';
import { sealContract, validateAnswers } from '../core/decision-contract.mjs';
import { containsUserQuestion, noQuestionContinuationReason } from '../core/no-question-guard.mjs';
import { evaluateDoneGate, defaultDoneGate } from '../core/hproof.mjs';
import { emitHook } from '../core/hooks-runtime.mjs';
import { storageReport, enforceRetention } from '../core/retention.mjs';
import { classifySql, classifyCommand, loadDbSafetyPolicy, safeSupabaseMcpConfig, checkSqlFile, checkDbOperation, scanDbSafety } from '../core/db-safety.mjs';
import { rustInfo } from '../core/rust-accelerator.mjs';
import { renderCartridge, validateCartridge, driftCartridge, snapshotCartridge } from '../core/gx-renderer.mjs';
import { DEFAULT_EVAL_THRESHOLDS, compareEvaluationReports, runEvaluationBenchmark } from '../core/evaluation.mjs';
import { buildResearchPrompt, evaluateResearchGate, writeMockResearchResult, writeResearchPlan } from '../core/research.mjs';

const flag = (args, name) => args.includes(name);
const promptOf = (args) => args.filter((x) => !String(x).startsWith('--')).join(' ').trim();

function installScopeFromArgs(args = [], fallback = 'global') {
  if (flag(args, '--project')) return 'project';
  if (flag(args, '--global')) return 'global';
  const i = args.indexOf('--install-scope');
  return normalizeInstallScope(i >= 0 && args[i + 1] ? args[i + 1] : fallback);
}

export async function main(args) {
  const [cmd, sub, ...rest] = args;
  const tail = sub === undefined ? [] : [sub, ...rest];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return help();
  if (cmd === 'setup') return setup(tail);
  if (cmd === 'fix-path') return fixPath(tail);
  if (cmd === 'doctor') return doctor(tail);
  if (cmd === 'init') return init(tail);
  if (cmd === 'selftest') return selftest(tail);
  if (cmd === 'ralph') return ralph(sub, rest);
  if (cmd === 'research') return research(sub, rest);
  if (cmd === 'hook') return emitHook(sub);
  if (cmd === 'profile') return profile(sub, rest);
  if (cmd === 'hproof') return hproof(sub, rest);
  if (cmd === 'memory') return memory(sub, rest);
  if (cmd === 'gx') return gx(sub, rest);
  if (cmd === 'team') return team(tail);
  if (cmd === 'db') return db(sub, rest);
  if (cmd === 'eval') return evalCommand(sub, rest);
  if (cmd === 'gc') return gc(tail);
  if (cmd === 'stats') return stats(tail);
  console.error(`Unknown command: ${cmd}`);
  process.exitCode = 1;
}

function help() {
  console.log(`Sneakoscope Codex

Usage:
  sks setup [--install-scope global|project] [--force] [--json]
  sks fix-path [--install-scope global|project] [--json]
  sks doctor [--fix] [--json] [--install-scope global|project]
  sks init [--install-scope global|project]
  sks selftest [--mock]
  sks ralph prepare "task"
  sks ralph answer <mission-id|latest> <answers.json>
  sks ralph run <mission-id|latest> [--mock] [--max-cycles N]
  sks ralph status <mission-id|latest>
  sks research prepare "topic" [--depth frontier]
  sks research run <mission-id|latest> [--mock] [--max-cycles N]
  sks research status <mission-id|latest>
  sks db policy
  sks db scan [--migrations] [--json]
  sks db mcp-config --project-ref <ref>
  sks db check --sql "DROP TABLE users"
  sks db check --command "supabase db reset"
  sks eval run [--json] [--out report.json]
  sks eval compare --baseline old.json --candidate new.json [--json]
  sks gx init [name]
  sks gx render [name] [--format svg|html|all]
  sks gx validate [name]
  sks gx drift [name]
  sks gx snapshot [name]
  sks gc [--dry-run] [--json]
  sks stats [--json]
`);
}

async function setup(args) {
  const root = await projectRoot();
  const installScope = installScopeFromArgs(args);
  const globalCommand = await globalSksCommand();
  const res = await initProject(root, { force: flag(args, '--force'), installScope, globalCommand });
  const install = await installStatus(root, installScope, { globalCommand });
  const hooksPath = path.join(root, '.codex', 'hooks.json');
  const result = {
    root,
    install,
    hooks: hooksPath,
    created: res.created,
    next: ['sks selftest --mock', 'sks doctor']
  };
  if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  console.log('Sneakoscope Codex Setup\n');
  console.log(`Project:   ${root}`);
  console.log(`Install:   ${install.ok ? 'ok' : 'missing'} ${install.scope} (${install.command_prefix})`);
  console.log(`Hooks:     ${path.relative(root, hooksPath)}`);
  console.log(`Skills:    .agents/skills`);
  console.log(`Next:      sks selftest --mock`);
  if (!install.ok && install.scope === 'global') console.log('\nGlobal command missing. Run: npm i -g sneakoscope');
  if (!install.ok && install.scope === 'project') console.log('\nProject package missing. Run: npm i -D sneakoscope');
}

async function fixPath(args) {
  const root = await projectRoot();
  const manifest = await readJson(path.join(root, '.sneakoscope', 'manifest.json'), null);
  const installScope = args.includes('--install-scope') || flag(args, '--project') || flag(args, '--global')
    ? installScopeFromArgs(args)
    : normalizeInstallScope(manifest?.installation?.scope || 'global');
  const globalCommand = await globalSksCommand();
  await initProject(root, { installScope, globalCommand });
  const install = await installStatus(root, installScope, { globalCommand });
  const result = {
    root,
    install_scope: installScope,
    hook_command_prefix: sksCommandPrefix(installScope, { globalCommand }),
    hooks: path.join(root, '.codex', 'hooks.json'),
    install
  };
  if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  console.log('SKS hook path refreshed\n');
  console.log(`Project:   ${root}`);
  console.log(`Install:   ${install.ok ? 'ok' : 'missing'} ${install.scope} (${install.command_prefix})`);
  console.log(`Hooks:     .codex/hooks.json`);
  if (!install.ok && install.scope === 'global') console.log('\nGlobal command missing. Run: npm i -g sneakoscope');
  if (!install.ok && install.scope === 'project') console.log('\nProject package missing. Run: npm i -D sneakoscope');
}

async function doctor(args) {
  const root = await projectRoot();
  const requestedScope = args.includes('--install-scope') || flag(args, '--project') || flag(args, '--global')
    ? installScopeFromArgs(args)
    : null;
  if (flag(args, '--fix')) {
    const fixScope = requestedScope || 'global';
    await initProject(root, { installScope: fixScope, globalCommand: await globalSksCommand() });
  }
  const codex = await getCodexInfo();
  const rust = await rustInfo();
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 20;
  const storage = await storageReport(root);
  const pkgBytes = await dirSize(packageRoot()).catch(() => 0);
  const manifest = await readJson(path.join(root, '.sneakoscope', 'manifest.json'), null);
  const installScope = requestedScope || normalizeInstallScope(manifest?.installation?.scope || 'global');
  const install = await installStatus(root, installScope);
  const dbPolicyExists = await exists(path.join(root, '.sneakoscope', 'db-safety.json'));
  const dbScan = await scanDbSafety(root).catch((err) => ({ ok: false, findings: [{ id: 'db_safety_scan_failed', severity: 'high', reason: err.message }] }));
  const result = {
    node: { ok: nodeOk, version: process.version }, root, codex, rust,
    install,
    sneakoscope: { ok: await exists(path.join(root, '.sneakoscope')) },
    db_guard: { ok: dbPolicyExists && dbScan.ok, policy: dbPolicyExists ? await loadDbSafetyPolicy(root) : null, scan: dbScan },
    hooks: { ok: await exists(path.join(root, '.codex', 'hooks.json')) },
    skills: { ok: await exists(path.join(root, '.agents', 'skills')) },
    package: { bytes: pkgBytes, human: formatBytes(pkgBytes) }, storage
  };
  result.ready = nodeOk && Boolean(codex.bin) && install.ok && result.sneakoscope.ok && result.db_guard.ok;
  if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  console.log('Sneakoscope Codex Doctor\n');
  console.log(`Node:      ${nodeOk ? 'ok' : 'fail'} ${process.version}`);
  console.log(`Project:   ${root}`);
  console.log(`Codex:     ${codex.bin ? 'ok' : 'missing'} ${codex.version || ''}`);
  console.log(`Install:   ${install.ok ? 'ok' : 'missing'} ${install.scope} (${install.command_prefix})`);
  console.log(`Rust acc.: ${rust.available ? rust.version : 'optional-missing'}`);
  console.log(`State:     ${result.sneakoscope.ok ? 'ok' : 'missing .sneakoscope'}`);
  console.log(`DB Guard:  ${result.db_guard.ok ? 'ok' : 'blocked'} ${dbScan.findings?.length || 0} finding(s)`);
  console.log(`Hooks:     ${result.hooks.ok ? 'ok' : 'missing .codex/hooks.json'}`);
  console.log(`Skills:    ${result.skills.ok ? 'ok' : 'missing .agents/skills'}`);
  console.log(`Package:   ${result.package.human}`);
  console.log(`Storage:   ${storage.total_human || '0 B'}`);
  console.log(`Ready:     ${result.ready ? 'yes' : 'no'}`);
  if (!codex.bin) console.log('\nCodex CLI missing. Install separately: npm i -g @openai/codex, or set SKS_CODEX_BIN.');
  if (!install.ok && install.scope === 'global') console.log('SKS global command missing. Install: npm i -g sneakoscope');
  if (!install.ok && install.scope === 'project') console.log('SKS project package missing. Install in this project: npm i -D sneakoscope');
  if (!result.ready && !flag(args, '--fix')) console.log('Run: sks doctor --fix');
}

async function init(args) {
  const root = await projectRoot();
  const installScope = installScopeFromArgs(args);
  const globalCommand = await globalSksCommand();
  const res = await initProject(root, { force: flag(args, '--force'), installScope, globalCommand });
  console.log(`Initialized Sneakoscope Codex in ${root}`);
  console.log(`Install scope: ${installScope} (${sksCommandPrefix(installScope, { globalCommand })})`);
  for (const x of res.created) console.log(`- ${x}`);
}

async function globalSksCommand() {
  return process.env.SKS_BIN || await which('sks').catch(() => null) || 'sks';
}

async function installStatus(root, scope, opts = {}) {
  const discoveredGlobalBin = await which('sks').catch(() => null);
  const configuredGlobalBin = process.env.SKS_BIN || (opts.globalCommand && opts.globalCommand !== 'sks' ? opts.globalCommand : null);
  const globalBin = configuredGlobalBin || discoveredGlobalBin;
  const commandPrefix = sksCommandPrefix(scope, { globalCommand: globalBin || undefined });
  const projectBin = path.join(root, 'node_modules', 'sneakoscope', 'bin', 'sks.mjs');
  const projectBinExists = await exists(projectBin);
  return {
    scope,
    default_scope: 'global',
    command_prefix: commandPrefix,
    global_bin: globalBin,
    project_bin: projectBin,
    ok: scope === 'project' ? projectBinExists : Boolean(globalBin)
  };
}

async function ralph(sub, args) {
  if (sub === 'prepare') return ralphPrepare(args);
  if (sub === 'answer') return ralphAnswer(args);
  if (sub === 'run') return ralphRun(args);
  if (sub === 'status') return ralphStatus(args);
  console.error('Usage: sks ralph <prepare|answer|run|status>');
  process.exitCode = 1;
}

async function research(sub, args) {
  if (sub === 'prepare') return researchPrepare(args);
  if (sub === 'run') return researchRun(args);
  if (sub === 'status') return researchStatus(args);
  console.error('Usage: sks research <prepare|run|status>');
  process.exitCode = 1;
}

async function researchPrepare(args) {
  const root = await projectRoot();
  if (!(await exists(path.join(root, '.sneakoscope')))) await initProject(root, {});
  const prompt = positionalArgs(args).join(' ').trim();
  if (!prompt) throw new Error('Missing research topic.');
  const { id, dir } = await createMission(root, { mode: 'research', prompt });
  const plan = await writeResearchPlan(dir, prompt, { depth: readFlagValue(args, '--depth', 'frontier') });
  await setCurrent(root, { mission_id: id, mode: 'RESEARCH', phase: 'RESEARCH_PREPARED', questions_allowed: false });
  console.log(`Research mission created: ${id}`);
  console.log(`Methodology: ${plan.methodology}`);
  console.log(`Plan: ${path.relative(root, path.join(dir, 'research-plan.md'))}`);
  console.log(`Run: sks research run ${id} --max-cycles 3`);
}

async function researchRun(args) {
  const root = await projectRoot();
  const id = await resolveMissionId(root, args[0]);
  if (!id) throw new Error('Usage: sks research run <mission-id|latest> [--mock] [--max-cycles N]');
  const { dir, mission } = await loadMission(root, id);
  const planPath = path.join(dir, 'research-plan.json');
  if (!(await exists(planPath))) await writeResearchPlan(dir, mission.prompt || '', {});
  const plan = await readJson(planPath);
  const dbScan = await scanDbSafety(root);
  if (!dbScan.ok) {
    console.error('Research cannot run: DB Guardian found unsafe Supabase/MCP/database configuration.');
    console.error(JSON.stringify(dbScan.findings, null, 2));
    process.exitCode = 2;
    return;
  }
  const maxCycles = readMaxCycles(args, 3);
  const mock = flag(args, '--mock');
  await setCurrent(root, { mission_id: id, mode: 'RESEARCH', phase: 'RESEARCH_RUNNING_NO_QUESTIONS', questions_allowed: false });
  await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'research.run.started', maxCycles, mock });
  if (mock) {
    const gate = await writeMockResearchResult(dir, plan);
    await setCurrent(root, { mission_id: id, mode: 'RESEARCH', phase: gate.passed ? 'RESEARCH_DONE' : 'RESEARCH_PAUSED', questions_allowed: true });
    console.log(`Mock research done: ${id}`);
    console.log(`Gate: ${gate.passed ? 'passed' : 'blocked'}`);
    return;
  }
  const codex = await getCodexInfo();
  if (!codex.bin) {
    console.error('Codex CLI not found. Running mock research instead.');
    const gate = await writeMockResearchResult(dir, plan);
    await setCurrent(root, { mission_id: id, mode: 'RESEARCH', phase: gate.passed ? 'RESEARCH_DONE' : 'RESEARCH_PAUSED', questions_allowed: true });
    console.log(`Mock research done: ${id}`);
    return;
  }
  let last = '';
  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    const cycleDir = path.join(dir, 'research', `cycle-${cycle}`);
    const outputFile = path.join(cycleDir, 'final.md');
    await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'research.cycle.start', cycle });
    const prompt = buildResearchPrompt({ id, mission, plan, cycle, previous: last });
    const result = await runCodexExec({ root, prompt, outputFile, json: true, profile: 'sks-research', logDir: cycleDir, timeoutMs: 45 * 60 * 1000 });
    await writeJsonAtomic(path.join(cycleDir, 'process.json'), { code: result.code, stdout_tail: result.stdout, stderr_tail: result.stderr, stdout_bytes: result.stdoutBytes, stderr_bytes: result.stderrBytes, truncated: result.truncated, timed_out: result.timedOut });
    last = await safeReadText(outputFile, result.stdout || result.stderr || '');
    if (containsUserQuestion(last)) {
      await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'research.guard.question_blocked', cycle });
      last = `${last}\n\n${noQuestionContinuationReason()}`;
      continue;
    }
    const gate = await evaluateResearchGate(dir);
    if (gate.passed) {
      await setCurrent(root, { mission_id: id, mode: 'RESEARCH', phase: 'RESEARCH_DONE', questions_allowed: true });
      await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'research.done', cycle });
      await enforceRetention(root).catch(() => {});
      console.log(`Research done: ${id}`);
      return;
    }
    await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'research.cycle.continue', cycle, reasons: gate.reasons });
  }
  await setCurrent(root, { mission_id: id, mode: 'RESEARCH', phase: 'RESEARCH_PAUSED_MAX_CYCLES', questions_allowed: true });
  console.log(`Research paused after max cycles: ${id}`);
}

async function researchStatus(args) {
  const root = await projectRoot();
  const id = await resolveMissionId(root, args[0]);
  if (!id) throw new Error('Usage: sks research status <mission-id|latest>');
  const { dir, mission } = await loadMission(root, id);
  const state = await readJson(stateFile(root), {});
  const gate = await readJson(path.join(dir, 'research-gate.evaluated.json'), await readJson(path.join(dir, 'research-gate.json'), null));
  const ledger = await readJson(path.join(dir, 'novelty-ledger.json'), null);
  console.log(JSON.stringify({ mission, state, gate, novelty_entries: ledger?.entries?.length ?? null }, null, 2));
}

async function ralphPrepare(args) {
  const root = await projectRoot();
  if (!(await exists(path.join(root, '.sneakoscope')))) await initProject(root, {});
  const prompt = promptOf(args);
  if (!prompt) throw new Error('Missing task prompt.');
  const { id, dir } = await createMission(root, { mode: 'ralph', prompt });
  const schema = buildQuestionSchema(prompt);
  await writeQuestions(dir, schema);
  await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'ralph.prepare.questions_created', slots: schema.slots.length });
  console.log(`Mission created: ${id}`);
  console.log('Ralph Prepare completed. Ralph run is locked until all required answers are supplied.');
  console.log(`Questions: ${path.relative(root, path.join(dir, 'questions.md'))}`);
  console.log(`Answer schema: ${path.relative(root, path.join(dir, 'required-answers.schema.json'))}`);
}

async function ralphAnswer(args) {
  const root = await projectRoot();
  const [missionArg, answerFile] = args;
  const id = await resolveMissionId(root, missionArg);
  if (!id || !answerFile) throw new Error('Usage: sks ralph answer <mission-id|latest> <answers.json>');
  const { dir, mission } = await loadMission(root, id);
  const answers = await readJson(path.resolve(answerFile));
  await writeJsonAtomic(path.join(dir, 'answers.json'), answers);
  const result = await sealContract(dir, mission);
  if (!result.ok) {
    console.error('Answer validation failed. Ralph run remains locked.');
    console.error(JSON.stringify(result.validation, null, 2));
    process.exitCode = 2;
    return;
  }
  await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'ralph.contract.sealed', hash: result.contract.sealed_hash });
  await setCurrent(root, { mission_id: id, mode: 'RALPH', phase: 'DECISION_CONTRACT_SEALED' });
  console.log(`Decision Contract sealed for ${id}`);
  console.log(`Hash: ${result.contract.sealed_hash}`);
}

async function ralphRun(args) {
  const root = await projectRoot();
  const id = await resolveMissionId(root, args[0]);
  if (!id) throw new Error('Usage: sks ralph run <mission-id|latest> [--mock]');
  const { dir, mission } = await loadMission(root, id);
  const contractPath = path.join(dir, 'decision-contract.json');
  if (!(await exists(contractPath))) throw new Error('Ralph cannot run: decision-contract.json is missing.');
  const contract = await readJson(contractPath);
  const dbScan = await scanDbSafety(root);
  if (!dbScan.ok) {
    console.error('Ralph cannot run: DB Guardian found unsafe Supabase/MCP/database configuration.');
    console.error(JSON.stringify(dbScan.findings, null, 2));
    process.exitCode = 2;
    return;
  }
  const maxCycles = readMaxCycles(args, 8);
  const mock = flag(args, '--mock');
  await setCurrent(root, { mission_id: id, mode: 'RALPH', phase: 'RALPH_RUNNING_NO_QUESTIONS', questions_allowed: false });
  await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'ralph.run.started', maxCycles, mock });
  await enforceRetention(root).catch(() => {});
  const gatePath = path.join(dir, 'done-gate.json');
  if (!(await exists(gatePath))) await writeJsonAtomic(gatePath, defaultDoneGate());
  console.log(`Ralph started: ${id}`);
  console.log('No-question lock active. Database destructive operations are blocked by DB Guard.');
  if (mock) return ralphRunMock(root, id, dir);
  const codex = await getCodexInfo();
  if (!codex.bin) {
    console.error('Codex CLI not found. Running mock loop instead.');
    return ralphRunMock(root, id, dir);
  }
  let last = '';
  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    const cycleDir = path.join(dir, 'ralph', `cycle-${cycle}`);
    const outputFile = path.join(cycleDir, 'final.md');
    const prompt = buildRalphPrompt({ id, mission, contract, cycle, previous: last });
    await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'ralph.cycle.start', cycle });
    const result = await runCodexExec({ root, prompt, outputFile, json: true, profile: 'sks-ralph', logDir: cycleDir });
    await writeJsonAtomic(path.join(cycleDir, 'process.json'), { code: result.code, stdout_tail: result.stdout, stderr_tail: result.stderr, stdout_bytes: result.stdoutBytes, stderr_bytes: result.stderrBytes, truncated: result.truncated, timed_out: result.timedOut });
    last = await safeReadText(outputFile, result.stdout || result.stderr || '');
    if (containsUserQuestion(last)) {
      await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'ralph.guard.question_blocked', cycle });
      last = `${last}\n\n${noQuestionContinuationReason()}`;
      continue;
    }
    const gate = await evaluateDoneGate(root, id);
    if (gate.passed) {
      await setCurrent(root, { mission_id: id, mode: 'RALPH', phase: 'RALPH_DONE', questions_allowed: true });
      await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'ralph.done', cycle });
      await enforceRetention(root).catch(() => {});
      console.log(`Ralph done: ${id}`);
      return;
    }
    await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'ralph.cycle.continue', cycle, reasons: gate.reasons });
    await enforceRetention(root).catch(() => {});
  }
  await setCurrent(root, { mission_id: id, mode: 'RALPH', phase: 'RALPH_PAUSED_MAX_CYCLES', questions_allowed: true });
  console.log(`Ralph paused after max cycles: ${id}`);
}

function buildRalphPrompt({ id, mission, contract, cycle, previous }) {
  return `You are running Sneakoscope Codex Ralph mode.\nMISSION: ${id}\nTASK: ${mission.prompt}\nCYCLE: ${cycle}\nNO-QUESTION LOCK: Do not ask the user. Resolve using decision-contract.json.\nDATABASE SAFETY: Destructive database operations are forbidden. Do not run DROP, TRUNCATE, db reset, db push, branch reset/merge/delete, project deletion, RLS disable, or live execute_sql writes. Use read-only/project-scoped Supabase MCP only unless the sealed contract explicitly allows migration files for local or preview branch.\nDECISION CONTRACT:\n${JSON.stringify(contract, null, 2)}\nPERFORMANCE POLICY: keep outputs concise; raw logs stay in files; summarize evidence only. If the task claims performance, token, or accuracy improvement, run sks eval run or sks eval compare and record the report path in done-gate.json evidence.\nDESIGN POLICY: if the task creates HTML/UI/prototype/deck-like visual artifacts, use the installed design-artifact-expert skill, inspect design context first, verify rendered output, and record design verification in done-gate.json.\nLOOP: plan, read before write, implement within contract, run/justify tests, update .sneakoscope/missions/${id}/done-gate.json.\nPrevious cycle tail:\n${String(previous || '').slice(-2500)}\n`;
}

async function safeReadText(file, fallback = '') {
  try { return await fsp.readFile(file, 'utf8'); } catch { return fallback; }
}

async function ralphRunMock(root, id, dir) {
  await writeJsonAtomic(path.join(dir, 'done-gate.json'), { passed: true, unsupported_critical_claims: 0, database_safety_violation: false, database_safety_reviewed: true, visual_drift: 'low', wiki_drift: 'low', tests_required: false, test_evidence_present: false, evidence: ['mock Ralph loop completed'], notes: ['mock run'] });
  await evaluateDoneGate(root, id);
  await setCurrent(root, { mission_id: id, mode: 'RALPH', phase: 'RALPH_DONE', questions_allowed: true });
  await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'ralph.mock.done' });
  await enforceRetention(root).catch(() => {});
  console.log(`Mock Ralph done: ${id}`);
}

async function ralphStatus(args) {
  const root = await projectRoot();
  const id = await resolveMissionId(root, args[0]);
  if (!id) throw new Error('Usage: sks ralph status <mission-id|latest>');
  const { dir, mission } = await loadMission(root, id);
  const state = await readJson(stateFile(root), {});
  const contract = await readJson(path.join(dir, 'decision-contract.json'), null);
  const gate = await readJson(path.join(dir, 'done-gate.evaluated.json'), await readJson(path.join(dir, 'done-gate.json'), null));
  console.log(JSON.stringify({ mission, state, contract_sealed: Boolean(contract), done_gate: gate }, null, 2));
}

async function resolveMissionId(root, arg) { return (!arg || arg === 'latest') ? findLatestMission(root) : arg; }
function readMaxCycles(args, fallback) { const i = args.indexOf('--max-cycles'); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback; }

async function selftest() {
  const tmp = tmpdir();
  process.chdir(tmp);
  await initProject(tmp, {});
  const defaultHooks = await readJson(path.join(tmp, '.codex', 'hooks.json'));
  if (defaultHooks.hooks.PreToolUse[0].hooks[0].command !== 'sks hook pre-tool') throw new Error('selftest failed: global install hook command changed');
  const absoluteHookTmp = tmpdir();
  await initProject(absoluteHookTmp, { globalCommand: '/usr/local/bin/sks' });
  const absoluteHooks = await readJson(path.join(absoluteHookTmp, '.codex', 'hooks.json'));
  if (absoluteHooks.hooks.PreToolUse[0].hooks[0].command !== '/usr/local/bin/sks hook pre-tool') throw new Error('selftest failed: absolute global hook command missing');
  const projectScopeTmp = tmpdir();
  await initProject(projectScopeTmp, { installScope: 'project' });
  const projectHooks = await readJson(path.join(projectScopeTmp, '.codex', 'hooks.json'));
  if (projectHooks.hooks.PreToolUse[0].hooks[0].command !== 'node ./node_modules/sneakoscope/bin/sks.mjs hook pre-tool') throw new Error('selftest failed: project install hook command missing');
  const researchSkillExists = await exists(path.join(tmp, '.agents', 'skills', 'research-discovery', 'SKILL.md'));
  if (!researchSkillExists) throw new Error('selftest failed: research skill not installed');
  const { id, dir, mission } = await createMission(tmp, { mode: 'ralph', prompt: '로그인 세션 만료 UX 개선 supabase db' });
  const schema = buildQuestionSchema(mission.prompt);
  await writeQuestions(dir, schema);
  if (validateAnswers(schema, {}).ok) throw new Error('selftest failed: empty answers valid');
  const answers = {};
  for (const s of schema.slots) answers[s.id] = s.options ? (s.type === 'array' ? [s.options[0]] : s.options[0]) : (s.type.includes('array') ? ['selftest'] : (s.id === 'DB_MAX_BLAST_RADIUS' ? 'no_live_dml' : 'selftest'));
  await writeJsonAtomic(path.join(dir, 'answers.json'), answers);
  const sealed = await sealContract(dir, mission);
  if (!sealed.ok) throw new Error('selftest failed: answers rejected');
  await setCurrent(tmp, { mission_id: id, mode: 'RALPH', phase: 'RALPH_RUNNING_NO_QUESTIONS' });
  if (!containsUserQuestion('확인해 주세요?')) throw new Error('selftest failed: question guard');
  if (classifySql('drop table users;').level !== 'destructive') throw new Error('selftest failed: destructive sql not detected');
  if (classifyCommand('supabase db reset').level !== 'destructive') throw new Error('selftest failed: supabase db reset not detected');
  const dbDecision = await checkDbOperation(tmp, { mission_id: id }, { tool_name: 'mcp__supabase__execute_sql', sql: 'drop table users;' }, { duringRalph: true });
  if (dbDecision.action !== 'block') throw new Error('selftest failed: destructive MCP SQL allowed');
  const nonDbDecision = await checkDbOperation(tmp, {}, { command: 'npm test' }, { duringRalph: true });
  if (nonDbDecision.action !== 'allow') throw new Error('selftest failed: non-DB command blocked by DB guard');
  const evalReport = runEvaluationBenchmark({ iterations: 5 });
  if (!evalReport.comparison.meaningful_improvement) throw new Error('selftest failed: evaluation benchmark did not show meaningful improvement');
  const { dir: researchDir, mission: researchMission } = await createMission(tmp, { mode: 'research', prompt: '새로운 코드 리뷰 방법론 연구' });
  const researchPlan = await writeResearchPlan(researchDir, researchMission.prompt, {});
  const researchGate = await writeMockResearchResult(researchDir, researchPlan);
  if (!researchGate.passed) throw new Error('selftest failed: mock research gate did not pass');
  await writeJsonAtomic(path.join(dir, 'done-gate.json'), { passed: true, unsupported_critical_claims: 0, database_safety_violation: false, database_safety_reviewed: true, visual_drift: 'low', wiki_drift: 'low', tests_required: false });
  const gate = await evaluateDoneGate(tmp, id);
  if (!gate.passed) throw new Error('selftest failed: done gate');
  const gxDir = path.join(tmp, '.sneakoscope', 'gx', 'cartridges', 'selftest');
  await writeJsonAtomic(path.join(gxDir, 'vgraph.json'), defaultVGraph('selftest'));
  await writeJsonAtomic(path.join(gxDir, 'beta.json'), defaultBeta('selftest'));
  const render = await renderCartridge(gxDir, { format: 'all' });
  if (!render.outputs.includes('render.svg')) throw new Error('selftest failed: gx svg not rendered');
  const validation = await validateCartridge(gxDir);
  if (!validation.ok) throw new Error('selftest failed: gx validation rejected');
  const drift = await driftCartridge(gxDir);
  if (drift.status !== 'low') throw new Error('selftest failed: gx drift is high');
  const snapshot = await snapshotCartridge(gxDir);
  if (!snapshot.files.svg || !snapshot.files.html) throw new Error('selftest failed: gx snapshot incomplete');
  const gc = await enforceRetention(tmp, { dryRun: true });
  if (!gc.report.exists) throw new Error('selftest failed: storage report');
  console.log('Sneakoscope Codex selftest passed.');
  console.log(`temp: ${tmp}`);
}

async function profile(sub, args) {
  const root = await projectRoot();
  if (sub === 'show') return console.log(JSON.stringify(await readJson(path.join(root, '.sneakoscope', 'model', 'current.json'), { model: 'gpt-5.5' }), null, 2));
  if (sub === 'set') { await writeJsonAtomic(path.join(root, '.sneakoscope', 'model', 'current.json'), { model: args[0] || 'gpt-5.5', set_at: nowIso() }); return console.log(`Model profile set: ${args[0] || 'gpt-5.5'}`); }
  console.error('Usage: sks profile show|set <model>');
}

async function hproof(sub, args) {
  if (sub !== 'check') return console.error('Usage: sks hproof check [mission-id]');
  const root = await projectRoot();
  const id = await resolveMissionId(root, args[0]);
  if (!id) throw new Error('No mission found.');
  console.log(JSON.stringify(await evaluateDoneGate(root, id), null, 2));
}

async function evalCommand(sub, args) {
  if (!sub || sub === 'help' || sub === '--help') {
    console.log('Usage: sks eval run [--json] [--out report.json] [--iterations N] | sks eval compare --baseline old.json --candidate new.json [--json]');
    return;
  }
  if (sub === 'thresholds') return console.log(JSON.stringify(DEFAULT_EVAL_THRESHOLDS, null, 2));
  const root = await projectRoot();
  if (sub === 'run') {
    const iterations = Number(readFlagValue(args, '--iterations', 200));
    const report = runEvaluationBenchmark({ iterations });
    const saved = await saveEvalReport(root, args, report, 'eval');
    if (flag(args, '--json')) return console.log(JSON.stringify({ ...report, report_path: saved }, null, 2));
    printEvalRun(report, saved);
    return;
  }
  if (sub === 'compare') {
    const positional = positionalArgs(args);
    const baselinePath = readFlagValue(args, '--baseline', positional[0]);
    const candidatePath = readFlagValue(args, '--candidate', positional[1]);
    if (!baselinePath || !candidatePath) throw new Error('Usage: sks eval compare --baseline old.json --candidate new.json [--json]');
    const report = compareEvaluationReports(await readJson(path.resolve(baselinePath)), await readJson(path.resolve(candidatePath)));
    const saved = await saveEvalReport(root, args, report, 'eval-compare');
    if (flag(args, '--json')) return console.log(JSON.stringify({ ...report, report_path: saved }, null, 2));
    printEvalCompare(report, saved);
    return;
  }
  console.error('Usage: sks eval run|compare|thresholds');
  process.exitCode = 1;
}

async function saveEvalReport(root, args, report, prefix) {
  if (flag(args, '--no-save')) return null;
  const requested = readFlagValue(args, '--out', null);
  const file = requested
    ? path.resolve(requested)
    : path.join(root, '.sneakoscope', 'reports', `${prefix}-${nowIso().replace(/[:.]/g, '-')}.json`);
  await ensureDir(path.dirname(file));
  await writeJsonAtomic(file, report);
  return file;
}

function pct(x) {
  return `${(100 * x).toFixed(1)}%`;
}

function printEvalRun(report, saved) {
  const c = report.comparison;
  console.log('Sneakoscope Eval');
  console.log(`Scenario:  ${report.scenario.id}`);
  console.log(`Tokens:    ${report.baseline.estimated_tokens} -> ${report.candidate.estimated_tokens} (${pct(c.token_savings_pct)} saved)`);
  console.log(`Accuracy:  ${report.baseline.quality.accuracy_proxy} -> ${report.candidate.quality.accuracy_proxy} (${c.accuracy_delta >= 0 ? '+' : ''}${c.accuracy_delta})`);
  console.log(`Recall:    ${report.candidate.quality.required_recall}`);
  console.log(`Precision: ${report.baseline.quality.relevance_precision} -> ${report.candidate.quality.relevance_precision}`);
  console.log(`Build ms:  ${report.baseline.context_build_ms_per_run} -> ${report.candidate.context_build_ms_per_run}`);
  console.log(`Meaningful improvement: ${c.meaningful_improvement ? 'yes' : 'no'}`);
  if (saved) console.log(`Report:    ${saved}`);
}

function printEvalCompare(report, saved) {
  const c = report.comparison;
  console.log('Sneakoscope Eval Compare');
  console.log(`Baseline:  ${report.baseline_label}`);
  console.log(`Candidate: ${report.candidate_label}`);
  console.log(`Tokens:    ${report.baseline.estimated_tokens} -> ${report.candidate.estimated_tokens} (${pct(c.token_savings_pct)} saved)`);
  console.log(`Accuracy:  ${report.baseline.quality.accuracy_proxy} -> ${report.candidate.quality.accuracy_proxy} (${c.accuracy_delta >= 0 ? '+' : ''}${c.accuracy_delta})`);
  console.log(`Meaningful improvement: ${c.meaningful_improvement ? 'yes' : 'no'}`);
  if (saved) console.log(`Report:    ${saved}`);
}

async function memory(sub, args) { return gc(args || []); }

async function gc(args) {
  const root = await projectRoot();
  const res = await enforceRetention(root, { dryRun: flag(args, '--dry-run') });
  if (flag(args, '--json')) return console.log(JSON.stringify(res, null, 2));
  console.log(flag(args, '--dry-run') ? 'Sneakoscope Codex GC dry run' : 'Sneakoscope Codex GC completed');
  console.log(`Storage: ${res.report.total_human || '0 B'}`);
  console.log(`Actions: ${res.actions.length}`);
  for (const a of res.actions.slice(0, 20)) console.log(`- ${a.action} ${a.path || a.mission || ''} ${a.bytes ? formatBytes(a.bytes) : ''}`);
}

async function stats(args) {
  const root = await projectRoot();
  const report = await storageReport(root);
  const pkgBytes = await dirSize(packageRoot()).catch(() => 0);
  const out = { package: { bytes: pkgBytes, human: formatBytes(pkgBytes) }, storage: report };
  if (flag(args, '--json')) return console.log(JSON.stringify(out, null, 2));
  console.log('Sneakoscope Codex Stats');
  console.log(`Package: ${out.package.human}`);
  console.log(`State:   ${report.total_human || '0 B'}`);
  for (const [name, sec] of Object.entries(report.sections || {})) console.log(`- ${name}: ${sec.human}`);
}

function positionalArgs(args = []) {
  const out = [];
  const valueFlags = new Set(['--format', '--iterations', '--out', '--baseline', '--candidate', '--install-scope', '--max-cycles', '--depth']);
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (valueFlags.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith('--')) out.push(arg);
  }
  return out;
}

function readFlagValue(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function cartridgeName(args, fallback = 'architecture-atlas') {
  const raw = positionalArgs(args)[0] || fallback;
  return String(raw).trim().replace(/[\\/]+/g, '-').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

function cartridgeDir(root, name) {
  return path.join(root, '.sneakoscope', 'gx', 'cartridges', name);
}

function defaultVGraph(name) {
  return {
    id: name,
    title: 'Sneakoscope Context Map',
    version: 1,
    nodes: [
      { id: 'source', label: 'vgraph source', kind: 'source', layer: 'input', status: 'safe' },
      { id: 'contract', label: 'decision contract', kind: 'guard', layer: 'policy', status: 'safe' },
      { id: 'proof', label: 'H-Proof gate', kind: 'guard', layer: 'verification', status: 'safe' }
    ],
    edges: [
      { from: 'source', to: 'contract', label: 'constrains' },
      { from: 'contract', to: 'proof', label: 'verifies' }
    ],
    invariants: [
      'vgraph.json remains the source of truth',
      'rendered SVG hash must match source hash'
    ],
    tests: [
      'sks gx validate',
      'sks gx drift'
    ],
    risks: []
  };
}

function defaultBeta(name) {
  return {
    id: name,
    version: 1,
    read_order: ['title', 'layers', 'nodes', 'edges', 'invariants', 'tests'],
    renderer: 'sneakoscope-codex-deterministic-svg'
  };
}

async function gx(sub, args) {
  const root = await projectRoot();
  const name = cartridgeName(args);
  const dir = cartridgeDir(root, name);
  if (sub === 'init') {
    const vgraphPath = path.join(dir, 'vgraph.json');
    const betaPath = path.join(dir, 'beta.json');
    const created = [];
    if (!(await exists(vgraphPath)) || flag(args, '--force')) {
      await writeJsonAtomic(vgraphPath, defaultVGraph(name));
      created.push('vgraph.json');
    }
    if (!(await exists(betaPath)) || flag(args, '--force')) {
      await writeJsonAtomic(betaPath, defaultBeta(name));
      created.push('beta.json');
    }
    const render = await renderCartridge(dir, { format: 'all' });
    const validation = await validateCartridge(dir);
    const drift = await driftCartridge(dir);
    console.log(JSON.stringify({ cartridge: path.relative(root, dir), created, render, validation: validation.ok, drift: drift.status }, null, 2));
    return;
  }
  if (sub === 'render') {
    const format = readFlagValue(args, '--format', 'all');
    console.log(JSON.stringify(await renderCartridge(dir, { format }), null, 2));
    return;
  }
  if (sub === 'validate') {
    const validation = await validateCartridge(dir);
    console.log(JSON.stringify(validation, null, 2));
    process.exitCode = validation.ok ? 0 : 2;
    return;
  }
  if (sub === 'drift') {
    const drift = await driftCartridge(dir);
    console.log(JSON.stringify(drift, null, 2));
    process.exitCode = drift.status === 'low' ? 0 : 2;
    return;
  }
  if (sub === 'snapshot') {
    await renderCartridge(dir, { format: 'all' });
    console.log(JSON.stringify(await snapshotCartridge(dir), null, 2));
    return;
  }
  console.error('Usage: sks gx init|render|validate|drift|snapshot');
  process.exitCode = 1;
}

async function team(args) {
  const prompt = promptOf(args);
  const root = await projectRoot();
  const { id, dir } = await createMission(root, { mode: 'team', prompt });
  const schema = buildQuestionSchema(prompt);
  await writeQuestions(dir, schema);
  console.log(`Team mission created: ${id}`);
  console.log('Team mode also requires mandatory clarification before implementation.');
}

async function db(sub, args) {
  const root = await projectRoot();
  if (sub === 'policy') {
    console.log(JSON.stringify(await loadDbSafetyPolicy(root), null, 2));
    return;
  }
  if (sub === 'scan') {
    const report = await scanDbSafety(root, { includeMigrations: flag(args, '--migrations') });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 2;
    return;
  }
  if (sub === 'mcp-config') {
    const projectIdx = args.indexOf('--project-ref');
    const featuresIdx = args.indexOf('--features');
    const projectRef = projectIdx >= 0 ? args[projectIdx + 1] : '<project_ref>';
    const features = featuresIdx >= 0 ? args[featuresIdx + 1] : 'database,docs';
    console.log(JSON.stringify(safeSupabaseMcpConfig({ projectRef, readOnly: true, features }), null, 2));
    return;
  }
  if (sub === 'classify' || sub === 'check') {
    const sqlIdx = args.indexOf('--sql');
    const commandIdx = args.indexOf('--command');
    const fileIdx = args.indexOf('--file');
    let result;
    if (fileIdx >= 0 && args[fileIdx + 1]) result = await checkSqlFile(path.resolve(args[fileIdx + 1]));
    else if (commandIdx >= 0 && args[commandIdx + 1]) result = classifyCommand(args[commandIdx + 1]);
    else if (sqlIdx >= 0 && args[sqlIdx + 1]) result = classifySql(args[sqlIdx + 1]);
    else if (sub === 'check' && args[0]) result = await checkSqlFile(path.resolve(args[0]));
    else result = classifySql(args.join(' ').trim());
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = ['destructive', 'write', 'possible_db'].includes(result.level) ? 2 : 0;
    return;
  }
  if (sub === 'scan-payload') {
    const raw = await fsp.readFile(0, 'utf8');
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const decision = await checkDbOperation(root, {}, payload, { duringRalph: false });
    console.log(JSON.stringify(decision, null, 2));
    process.exitCode = decision.action === 'block' ? 2 : 0;
    return;
  }
  console.error('Usage: sks db policy | db scan [--migrations] | db mcp-config --project-ref <id> | db check --sql "..." | db check --command "..." | db check --file file.sql');
  process.exitCode = 1;
}
