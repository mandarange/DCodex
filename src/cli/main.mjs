import path from 'node:path';
import fsp from 'node:fs/promises';
import { projectRoot, readJson, writeJsonAtomic, writeTextAtomic, appendJsonlBounded, nowIso, exists, tmpdir, packageRoot, dirSize, formatBytes } from '../core/fsx.mjs';
import { initProject } from '../core/init.mjs';
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

const flag = (args, name) => args.includes(name);
const promptOf = (args) => args.filter((x) => !String(x).startsWith('--')).join(' ').trim();

export async function main(args) {
  const [cmd, sub, ...rest] = args;
  const tail = sub === undefined ? [] : [sub, ...rest];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return help();
  if (cmd === 'doctor') return doctor(tail);
  if (cmd === 'init') return init(tail);
  if (cmd === 'selftest') return selftest(tail);
  if (cmd === 'ralph') return ralph(sub, rest);
  if (cmd === 'hook') return emitHook(sub);
  if (cmd === 'profile') return profile(sub, rest);
  if (cmd === 'hproof') return hproof(sub, rest);
  if (cmd === 'memory') return memory(sub, rest);
  if (cmd === 'gx') return gx(sub, rest);
  if (cmd === 'team') return team(tail);
  if (cmd === 'db') return db(sub, rest);
  if (cmd === 'gc') return gc(tail);
  if (cmd === 'stats') return stats(tail);
  console.error(`Unknown command: ${cmd}`);
  process.exitCode = 1;
}

function help() {
  console.log(`Sneakoscope Codex\n\nUsage:\n  sks doctor [--fix] [--json]\n  sks init\n  sks selftest [--mock]\n  sks ralph prepare "task"\n  sks ralph answer <mission-id|latest> <answers.json>\n  sks ralph run <mission-id|latest> [--mock] [--max-cycles N]\n  sks ralph status <mission-id|latest>\n  sks db policy\n  sks db scan [--migrations] [--json]\n  sks db mcp-config --project-ref <ref>\n  sks db check --sql "DROP TABLE users"\n  sks db check --command "supabase db reset"\n  sks gc [--dry-run] [--json]\n  sks stats [--json]\n`);
}

async function doctor(args) {
  const root = await projectRoot();
  if (flag(args, '--fix')) await initProject(root, {});
  const codex = await getCodexInfo();
  const rust = await rustInfo();
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 20;
  const storage = await storageReport(root);
  const pkgBytes = await dirSize(packageRoot()).catch(() => 0);
  const dbPolicyExists = await exists(path.join(root, '.sneakoscope', 'db-safety.json'));
  const dbScan = await scanDbSafety(root).catch((err) => ({ ok: false, findings: [{ id: 'db_safety_scan_failed', severity: 'high', reason: err.message }] }));
  const result = {
    node: { ok: nodeOk, version: process.version }, root, codex, rust,
    sneakoscope: { ok: await exists(path.join(root, '.sneakoscope')) },
    db_guard: { ok: dbPolicyExists && dbScan.ok, policy: dbPolicyExists ? await loadDbSafetyPolicy(root) : null, scan: dbScan },
    hooks: { ok: await exists(path.join(root, '.codex', 'hooks.json')) },
    skills: { ok: await exists(path.join(root, '.agents', 'skills')) },
    package: { bytes: pkgBytes, human: formatBytes(pkgBytes) }, storage
  };
  result.ready = nodeOk && Boolean(codex.bin) && result.sneakoscope.ok && result.db_guard.ok;
  if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  console.log('Sneakoscope Codex Doctor\n');
  console.log(`Node:      ${nodeOk ? 'ok' : 'fail'} ${process.version}`);
  console.log(`Project:   ${root}`);
  console.log(`Codex:     ${codex.bin ? 'ok' : 'missing'} ${codex.version || ''}`);
  console.log(`Rust acc.: ${rust.available ? rust.version : 'optional-missing'}`);
  console.log(`State:     ${result.sneakoscope.ok ? 'ok' : 'missing .sneakoscope'}`);
  console.log(`DB Guard:  ${result.db_guard.ok ? 'ok' : 'blocked'} ${dbScan.findings?.length || 0} finding(s)`);
  console.log(`Hooks:     ${result.hooks.ok ? 'ok' : 'missing .codex/hooks.json'}`);
  console.log(`Skills:    ${result.skills.ok ? 'ok' : 'missing .agents/skills'}`);
  console.log(`Package:   ${result.package.human}`);
  console.log(`Storage:   ${storage.total_human || '0 B'}`);
  console.log(`Ready:     ${result.ready ? 'yes' : 'no'}`);
  if (!codex.bin) console.log('\nCodex CLI missing. Install separately: npm i -g @openai/codex, or set SKS_CODEX_BIN.');
  if (!result.ready && !flag(args, '--fix')) console.log('Run: sks doctor --fix');
}

async function init(args) {
  const root = await projectRoot();
  const res = await initProject(root, { force: flag(args, '--force') });
  console.log(`Initialized Sneakoscope Codex in ${root}`);
  for (const x of res.created) console.log(`- ${x}`);
}

async function ralph(sub, args) {
  if (sub === 'prepare') return ralphPrepare(args);
  if (sub === 'answer') return ralphAnswer(args);
  if (sub === 'run') return ralphRun(args);
  if (sub === 'status') return ralphStatus(args);
  console.error('Usage: sks ralph <prepare|answer|run|status>');
  process.exitCode = 1;
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
  return `You are running Sneakoscope Codex Ralph mode.\nMISSION: ${id}\nTASK: ${mission.prompt}\nCYCLE: ${cycle}\nNO-QUESTION LOCK: Do not ask the user. Resolve using decision-contract.json.\nDATABASE SAFETY: Destructive database operations are forbidden. Do not run DROP, TRUNCATE, db reset, db push, branch reset/merge/delete, project deletion, RLS disable, or live execute_sql writes. Use read-only/project-scoped Supabase MCP only unless the sealed contract explicitly allows migration files for local or preview branch.\nDECISION CONTRACT:\n${JSON.stringify(contract, null, 2)}\nPERFORMANCE POLICY: keep outputs concise; raw logs stay in files; summarize evidence only.\nLOOP: plan, read before write, implement within contract, run/justify tests, update .sneakoscope/missions/${id}/done-gate.json.\nPrevious cycle tail:\n${String(previous || '').slice(-2500)}\n`;
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
  await writeJsonAtomic(path.join(dir, 'done-gate.json'), { passed: true, unsupported_critical_claims: 0, database_safety_violation: false, database_safety_reviewed: true, visual_drift: 'low', wiki_drift: 'low', tests_required: false });
  const gate = await evaluateDoneGate(tmp, id);
  if (!gate.passed) throw new Error('selftest failed: done gate');
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

async function gx(sub, args) {
  const root = await projectRoot();
  if (sub === 'init') {
    const name = args[0] || 'architecture-atlas';
    const dir = path.join(root, '.sneakoscope', 'gx', 'cartridges', name);
    await writeJsonAtomic(path.join(dir, 'vgraph.json'), { id: name, version: 1, nodes: [], edges: [], invariants: [], tests: [] });
    await writeJsonAtomic(path.join(dir, 'beta.json'), { id: name, version: 1, read_order: ['grid', 'layers', 'nodes', 'edges', 'tests'] });
    await writeTextAtomic(path.join(dir, 'image-prompt.md'), 'Create a clean technical architecture sheet from vgraph.json. Use GPT Image 2 only.');
    console.log(`GX cartridge initialized: ${path.relative(root, dir)}`);
    return;
  }
  if (['render', 'validate', 'drift'].includes(sub)) return console.log(`GX ${sub}: metadata only; image generation is performed by Codex $imagegen in live mode.`);
  console.error('Usage: sks gx init|render|validate|drift');
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
