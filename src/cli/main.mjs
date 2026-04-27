import path from 'node:path';
import fsp from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { projectRoot, readJson, writeJsonAtomic, writeTextAtomic, appendJsonlBounded, nowIso, exists, ensureDir, tmpdir, packageRoot, dirSize, formatBytes, which, runProcess, PACKAGE_VERSION } from '../core/fsx.mjs';
import { initProject, normalizeInstallScope, sksCommandPrefix } from '../core/init.mjs';
import { getCodexInfo, runCodexExec } from '../core/codex-adapter.mjs';
import { createMission, loadMission, findLatestMission, missionDir, setCurrent, stateFile } from '../core/mission.mjs';
import { buildQuestionSchema, writeQuestions } from '../core/questions.mjs';
import { sealContract, validateAnswers } from '../core/decision-contract.mjs';
import { buildQaLoopQuestionSchema, buildQaLoopPrompt, evaluateQaGate, qaStatus, writeMockQaResult, writeQaLoopArtifacts } from '../core/qa-loop.mjs';
import { containsUserQuestion, noQuestionContinuationReason } from '../core/no-question-guard.mjs';
import { evaluateDoneGate, defaultDoneGate } from '../core/hproof.mjs';
import { emitHook } from '../core/hooks-runtime.mjs';
import { storageReport, enforceRetention, pruneWikiArtifacts } from '../core/retention.mjs';
import { classifySql, classifyCommand, loadDbSafetyPolicy, safeSupabaseMcpConfig, checkSqlFile, checkDbOperation, scanDbSafety } from '../core/db-safety.mjs';
import { checkHarnessModification, harnessGuardStatus, isHarnessSourceProject } from '../core/harness-guard.mjs';
import { formatHarnessConflictReport, llmHarnessCleanupPrompt, scanHarnessConflicts } from '../core/harness-conflicts.mjs';
import { context7Docs, context7Resolve, context7Text, context7Tools } from '../core/context7-client.mjs';
import { installVersionGitHook, runVersionPreCommit, versioningStatus } from '../core/version-manager.mjs';
import { rustInfo } from '../core/rust-accelerator.mjs';
import { renderCartridge, validateCartridge, driftCartridge, snapshotCartridge } from '../core/gx-renderer.mjs';
import { DEFAULT_EVAL_THRESHOLDS, compareEvaluationReports, defaultEvaluationScenario, runEvaluationBenchmark } from '../core/evaluation.mjs';
import { buildResearchPrompt, evaluateResearchGate, writeMockResearchResult, writeResearchPlan } from '../core/research.mjs';
import { contextCapsule } from '../core/triwiki-attention.mjs';
import { rgbaKey, rgbaToWikiCoord, validateWikiCoordinateIndex } from '../core/wiki-coordinate.mjs';
import { COMMAND_CATALOG, DOLLAR_COMMAND_ALIASES, DOLLAR_COMMANDS, DOLLAR_SKILL_NAMES, RECOMMENDED_SKILLS, ROUTES, USAGE_TOPICS, context7ConfigToml, hasContext7ConfigText, reasoningInstruction, routePrompt, routeReasoning, routeRequiresSubagents, triwikiContextTracking } from '../core/routes.mjs';
import { context7Evidence, evaluateStop, recordContext7Evidence, recordSubagentEvidence } from '../core/pipeline.mjs';
import { appendTeamEvent, formatRoleCounts, initTeamLive, normalizeTeamSpec, parseTeamSpecArgs, parseTeamSpecText, readTeamDashboard, readTeamLive, readTeamTranscriptTail } from '../core/team-live.mjs';
import { CODEX_APP_DOCS_URL, codexAppIntegrationStatus, formatCodexAppStatus } from '../core/codex-app.mjs';
import { buildTmuxLaunchPlan, defaultTmuxSessionName, formatTmuxBanner, launchTmuxUi, runTmuxStatus, sanitizeTmuxSessionName } from '../core/tmux-ui.mjs';
import { autoReviewProfileName, autoReviewStatus, autoReviewSummary, enableAutoReview, disableAutoReview } from '../core/auto-review.mjs';

const flag = (args, name) => args.includes(name);
const promptOf = (args) => args.filter((x) => !String(x).startsWith('--')).join(' ').trim();
const REPOSITORY_URL = 'https://github.com/mandarange/Sneakoscope-Codex.git';

function installScopeFromArgs(args = [], fallback = 'global') {
  if (flag(args, '--project')) return 'project';
  if (flag(args, '--global')) return 'global';
  const i = args.indexOf('--install-scope');
  return normalizeInstallScope(i >= 0 && args[i + 1] ? args[i + 1] : fallback);
}

export async function main(args) {
  if (isAutoReviewFlag(args[0])) return autoReviewCommand('start', args.slice(1));
  const [cmd, sub, ...rest] = args;
  const tail = sub === undefined ? [] : [sub, ...rest];
  if (!cmd) return shouldLaunchTmuxUi() ? tmuxCommand('start', []) : help();
  if (cmd === '--help' || cmd === '-h') return help();
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') return version();
  if (cmd === 'postinstall') return postinstall();
  if (cmd === 'wizard' || cmd === 'ui') return wizard(tail);
  if (cmd === 'tmux') return String(sub || '').startsWith('--') ? tmuxCommand('start', tail) : tmuxCommand(sub, rest);
  if (cmd === 'auto-review' || cmd === 'autoreview') return autoReviewCommand(sub, rest);
  if (cmd === 'update-check') return updateCheck(tail);
  if (cmd === 'help') return help(tail);
  if (cmd === 'commands') return commands(tail);
  if (cmd === 'usage') return usage(tail);
  if (cmd === 'quickstart') return quickstart();
  if (cmd === 'codex-app') return codexAppHelp(tail);
  if (cmd === 'dollar-commands' || cmd === 'dollars' || cmd === '$') return dollarCommands(tail);
  if (String(cmd).toLowerCase() === 'dfix') return dfixHelp();
  if (cmd === 'qa-loop') return qaLoop(sub, rest);
  if (cmd === 'context7') return context7(sub, rest);
  if (cmd === 'pipeline') return pipeline(sub, rest);
  if (cmd === 'guard') return guard(sub, rest);
  if (cmd === 'conflicts') return conflicts(sub, rest);
  if (cmd === 'versioning') return versioning(sub, rest);
  if (cmd === 'reasoning') return reasoningCommand(tail);
  if (cmd === 'aliases') return aliases();
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
  if (cmd === 'wiki') return wiki(sub, rest);
  if (cmd === 'gc') return gc(tail);
  if (cmd === 'stats') return stats(tail);
  console.error(`Unknown command: ${cmd}`);
  process.exitCode = 1;
}

function help(args = []) {
  const topic = args[0];
  if (topic) return usage([topic]);
  console.log(`Sneakoscope Codex

Usage:
  sks help [topic]
  sks version
  sks update-check [--json]
  sks wizard
  sks commands [--json]
  sks usage [${USAGE_TOPICS}]
  sks quickstart
  sks codex-app
  sks auto-review status|enable|start [--high]
  sks --Auto-review [--high]
  sks tmux [--session name] [--no-attach]
  sks tmux status [--once]
  sks dollar-commands [--json]
  sks dfix
  sks qa-loop prepare "target"
  sks qa-loop answer <mission-id|latest> <answers.json>
  sks qa-loop run <mission-id|latest> [--mock] [--max-cycles N]
  sks qa-loop status <mission-id|latest>
  sks context7 check|setup|tools|resolve|docs|evidence ...
  sks pipeline status|resume [--json]
  sks pipeline answer <mission-id|latest> <answers.json>
  sks guard check [--json]
  sks conflicts check|prompt [--json]
  sks versioning status|bump|pre-commit [--json]
  sks reasoning ["prompt"] [--json]
  sks aliases
  sks setup [--install-scope global|project] [--local-only] [--force] [--json]
  sks fix-path [--install-scope global|project] [--json]
  sks doctor [--fix] [--local-only] [--json] [--install-scope global|project]
  sks init [--install-scope global|project] [--local-only]
  sks selftest [--mock]
  sks ralph prepare "task"
  sks ralph answer <mission-id|latest> <answers.json>
  sks ralph run <mission-id|latest> [--mock] [--max-cycles N]
  sks ralph status <mission-id|latest>
  sks team "task" [executor:5 reviewer:2 user:1] [--json]
  sks team log|tail|watch|status [mission-id|latest]
  sks team event [mission-id|latest] --agent <name> --phase <phase> --message "..."
  sks research prepare "topic" [--depth frontier]
  sks research run <mission-id|latest> [--mock] [--max-cycles N]
  sks research status <mission-id|latest>
  sks db policy
  sks db scan [--migrations] [--json]
  sks db mcp-config --project-ref <ref>
  sks db check --sql "DROP TABLE users"
  sks db check --command "supabase db reset"
  sks hproof check [mission-id|latest]
  sks eval run [--json] [--out report.json]
  sks eval compare --baseline old.json --candidate new.json [--json]
  sks wiki coords --rgba 12,34,56,255
  sks wiki pack [--json] [--role worker|verifier] [--max-anchors N]
  sks wiki refresh [--json] [--role worker|verifier] [--max-anchors N] [--prune] [--dry-run]
  sks wiki prune [--json] [--dry-run]
  sks wiki validate [context-pack.json]
  sks gx init [name]
  sks gx render [name] [--format svg|html|all]
  sks gx validate [name]
  sks gx drift [name]
  sks gx snapshot [name]
  sks profile show
  sks profile set <model>
  sks gc [--dry-run] [--json]
  sks memory [--dry-run] [--json]
  sks stats [--json]

Codex App prompt commands:
${formatDollarCommandsCompact('  ')}

Discovery:
  sks commands       Full command list with descriptions
  sks usage ralph    Workflow examples for one topic
  sks dollar-commands Codex App $ commands: ${dollarCommandNames()}
`);
}

function version() {
  console.log(`sneakoscope ${PACKAGE_VERSION}`);
}

function shouldShowWizard() {
  return Boolean(input.isTTY && output.isTTY && process.env.SKS_NO_WIZARD !== '1' && process.env.CI !== 'true');
}

function shouldLaunchTmuxUi() {
  return Boolean(input.isTTY && output.isTTY && process.env.SKS_NO_TMUX !== '1' && process.env.CI !== 'true');
}

function isAutoReviewFlag(value) {
  return /^--?auto[-_]?review$/i.test(String(value || ''));
}

async function postinstall() {
  const installRoot = path.resolve(process.env.INIT_CWD || process.cwd());
  const conflictScan = await scanHarnessConflicts(installRoot);
  if (conflictScan.hard_block) {
    await postinstallHarnessConflictNotice(conflictScan);
    return;
  }
  console.log('\nSneakoscope Codex installed.');
  const shim = await ensureSksCommandDuringInstall();
  if (shim.status === 'present') console.log(`SKS command: available (${shim.command}).`);
  else if (shim.status === 'created') console.log(`SKS command: shim created at ${shim.command}.`);
  else if (shim.status === 'created_not_on_path') console.log(`SKS command: shim created at ${shim.command}. Add ${path.dirname(shim.command)} to PATH, or run npx -y -p sneakoscope sks.`);
  else if (shim.status === 'skipped') console.log(`SKS command: skipped (${shim.reason}).`);
  else console.log(`SKS command: shim unavailable. Use npx -y -p sneakoscope sks. ${shim.error || ''}`.trim());
  const context7Install = await ensureGlobalContext7DuringInstall();
  if (context7Install.status === 'present') console.log('Context7 MCP: already configured for Codex.');
  else if (context7Install.status === 'installed') console.log('Context7 MCP: configured for Codex.');
  else if (context7Install.status === 'codex_missing') console.log('Context7 MCP: Codex CLI missing. Install @openai/codex or set SKS_CODEX_BIN, then run `sks context7 setup --scope global` or `sks setup` in a project.');
  else if (context7Install.status === 'skipped') console.log(`Context7 MCP: skipped (${context7Install.reason}).`);
  else if (context7Install.status === 'failed') console.log(`Context7 MCP: auto setup failed. Run \`sks context7 setup --scope global\` or \`sks setup\`. ${context7Install.error || ''}`.trim());
  const appSetup = await ensureCodexAppProjectDuringInstall(installRoot, { shim });
  if (appSetup.status === 'installed') console.log(`Codex App project setup: installed in ${appSetup.root} (${appSetup.install_scope}; canonical picker skills include ${appSetup.aliases.join(', ')}).`);
  else if (appSetup.status === 'partial') console.log(`Codex App project setup: repaired with missing skill warning (${appSetup.missing_skills.join(', ')}). Run \`sks doctor --fix\`.`);
  else if (appSetup.status === 'skipped') console.log(`Codex App project setup: skipped (${appSetup.reason}).`);
  else if (appSetup.status === 'failed') console.log(`Codex App project setup: auto setup failed. Run \`sks doctor --fix\`. ${appSetup.error || ''}`.trim());
  console.log('Run `sks` to open the tmux-based SKS/Codex CLI runtime. If Codex App or its first-party MCP/plugin tools are missing, SKS will block launch and print the setup path.');
  console.log('Check app/tool readiness with: `sks codex-app check` and `sks tmux check`.');
  console.log('Project-only setup: `sks wizard` -> choose project, or `npx sks setup --install-scope project`.\n');
}

async function postinstallHarnessConflictNotice(conflictScan) {
  console.log('\nSneakoscope Codex package installed, but SKS setup is blocked.');
  console.log(formatHarnessConflictReport(conflictScan, { includePrompt: false }));
  console.log('\nWhat this means: npm can finish installing the package, but `sks setup` and `sks doctor --fix` will refuse to activate SKS until the conflicting harness is removed with human approval.');
  console.log('No files were removed by postinstall.');
  console.log('Cleanup requires a human-approved Codex App session. Recommended model: GPT-5.5, reasoning: high.');
  if (shouldAskPostinstallQuestion()) {
    const answer = await askPostinstallQuestion('Show the cleanup prompt now? [y/N] ');
    if (/^(y|yes|예|네|응)$/i.test(answer.trim())) {
      console.log('\nCleanup prompt:\n');
      console.log(llmHarnessCleanupPrompt(conflictScan));
    } else {
      console.log('Cleanup prompt skipped. You can print it later with: sks conflicts prompt');
    }
  } else {
    console.log('Print the cleanup prompt later with: sks conflicts prompt');
  }
  console.log('After approved cleanup, rerun: sks setup && sks doctor --fix && sks selftest --mock\n');
}

function shouldAskPostinstallQuestion() {
  if (process.env.SKS_POSTINSTALL_PROMPT === '1') return true;
  return Boolean(input.isTTY && output.isTTY && process.env.CI !== 'true' && process.env.SKS_POSTINSTALL_NO_PROMPT !== '1');
}

async function askPostinstallQuestion(question) {
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function ensureSksCommandDuringInstall(opts = {}) {
  if (process.env.SKS_SKIP_POSTINSTALL_SHIM === '1' && !opts.force) return { status: 'skipped', reason: 'SKS_SKIP_POSTINSTALL_SHIM=1' };
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? '';
  const existing = await findCommandOnPath('sks', pathEnv);
  if (isStableSksBin(existing)) return { status: 'present', command: existing };
  const nodeBin = opts.nodeBin || process.execPath;
  const target = opts.target || path.join(packageRoot(), 'bin', 'sks.mjs');
  const dirs = candidateShimDirs(pathEnv, opts.home || process.env.HOME);
  const script = process.platform === 'win32'
    ? `@echo off\r\n"${nodeBin}" "${target}" %*\r\n`
    : `#!/bin/sh\nexec "${nodeBin}" "${target}" "$@"\n`;
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  let createdFallback = null;
  let lastError = '';
  for (const entry of dirs) {
    const dest = path.join(entry.dir, `sks${suffix}`);
    try {
      await ensureDir(entry.dir);
      await writeTextAtomic(dest, script);
      if (process.platform !== 'win32') await fsp.chmod(dest, 0o755).catch(() => {});
      if (entry.onPath) return { status: 'created', command: dest };
      createdFallback ||= dest;
    } catch (err) {
      lastError = err.message;
    }
  }
  if (createdFallback) return { status: 'created_not_on_path', command: createdFallback };
  return { status: 'failed', error: lastError };
}

function candidateShimDirs(pathEnv, home) {
  const seen = new Set();
  const out = [];
  for (const raw of String(pathEnv || '').split(path.delimiter).filter(Boolean)) {
    const dir = path.resolve(raw);
    if (seen.has(dir) || isTransientNpmBinPath(dir)) continue;
    seen.add(dir);
    out.push({ dir, onPath: true });
  }
  for (const raw of [home && path.join(home, '.local', 'bin'), home && path.join(home, 'bin')].filter(Boolean)) {
    const dir = path.resolve(raw);
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push({ dir, onPath: false });
  }
  return out;
}

async function findCommandOnPath(name, pathEnv) {
  const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of String(pathEnv || '').split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${name}${suffix}`);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

async function ensureGlobalContext7DuringInstall() {
  if (process.env.SKS_SKIP_POSTINSTALL_CONTEXT7 === '1') return { status: 'skipped', reason: 'SKS_SKIP_POSTINSTALL_CONTEXT7=1' };
  const codex = await getCodexInfo().catch(() => ({}));
  if (!codex.bin) return { status: 'codex_missing' };
  const list = await runProcess(codex.bin, ['mcp', 'list'], { timeoutMs: 8000, maxOutputBytes: 32 * 1024 }).catch((err) => ({ code: 1, stderr: err.message, stdout: '' }));
  if (list.code === 0 && /context7/i.test(`${list.stdout}\n${list.stderr}`)) return { status: 'present' };
  const add = await runProcess(codex.bin, ['mcp', 'add', 'context7', '--', 'npx', '-y', '@upstash/context7-mcp@latest'], { timeoutMs: 30000, maxOutputBytes: 64 * 1024 }).catch((err) => ({ code: 1, stderr: err.message, stdout: '' }));
  if (add.code === 0) return { status: 'installed' };
  return { status: 'failed', error: `${add.stderr || add.stdout || 'codex mcp add failed'}`.trim() };
}

async function ensureCodexAppProjectDuringInstall(installRoot, opts = {}) {
  if (process.env.SKS_SKIP_POSTINSTALL_SETUP === '1') return { status: 'skipped', reason: 'SKS_SKIP_POSTINSTALL_SETUP=1' };
  if (process.env.CI === 'true') return { status: 'skipped', reason: 'CI=true' };
  const root = path.resolve(installRoot || process.cwd());
  if (!(await isProjectSetupCandidate(root))) return { status: 'skipped', reason: 'no package.json, .git, .codex, .agents, or AGENTS.md in INIT_CWD' };
  try {
    const installScope = await isProjectPackageInstall(root) ? 'project' : 'global';
    const globalCommand = opts.shim?.command && opts.shim.status !== 'created_not_on_path'
      ? opts.shim.command
      : await globalSksCommand();
    await initProject(root, { installScope, globalCommand, localOnly: false });
    const skills = await checkRequiredSkills(root);
    return {
      status: skills.ok ? 'installed' : 'partial',
      root,
      install_scope: installScope,
      aliases: DOLLAR_COMMAND_ALIASES.map((x) => x.app_skill),
      missing_skills: skills.missing
    };
  } catch (err) {
    return { status: 'failed', root, error: err.message };
  }
}

async function isProjectSetupCandidate(root) {
  for (const marker of ['package.json', '.git', '.codex', '.agents', 'AGENTS.md']) {
    if (await exists(path.join(root, marker))) return true;
  }
  return false;
}

async function isProjectPackageInstall(root) {
  const installedPackage = path.join(root, 'node_modules', 'sneakoscope');
  if (!(await exists(path.join(installedPackage, 'package.json')))) return false;
  const [installedReal, packageReal] = await Promise.all([
    fsp.realpath(installedPackage).catch(() => installedPackage),
    fsp.realpath(packageRoot()).catch(() => packageRoot())
  ]);
  return installedReal === packageReal;
}

async function wizard(args = []) {
  if (!shouldShowWizard() && !flag(args, '--force')) return help();
  const rl = readline.createInterface({ input, output });
  try {
    console.log('Sneakoscope Codex Setup UI\n');
    console.log(`Current package: ${PACKAGE_VERSION}`);
    const latest = await npmPackageVersion('sneakoscope');
    if (latest.version) {
      const needsUpdate = compareVersions(latest.version, PACKAGE_VERSION) > 0;
      console.log(`Latest on npm:   ${latest.version}${needsUpdate ? ' (update available)' : ''}`);
      if (needsUpdate) {
        const update = await askChoice(rl, 'Update SKS before setup?', ['yes', 'no'], 'yes');
        if (update === 'yes') {
          console.log('\nRun this update command, then rerun `sks`:');
          console.log('  npm i -g sneakoscope\n');
          return;
        }
        console.log('Skipping update for this setup run.\n');
      }
    } else if (latest.error) {
      console.log(`Latest on npm:   unknown (${latest.error})`);
    }

    const scope = await askChoice(rl, 'Install scope for this project?', ['global', 'project', 'commands', 'quit'], 'global');
    if (scope === 'quit') return;
    if (scope === 'commands') {
      quickstart();
      return;
    }
    if (scope === 'project') {
      console.log('\nProject-only setup needs the package installed in this project:');
      console.log('  npm i -D sneakoscope');
      const proceed = await askChoice(rl, 'Continue with project setup after that dependency exists?', ['yes', 'no'], 'no');
      if (proceed !== 'yes') return;
    }

    const runSetup = await askChoice(rl, `Run sks setup with ${scope} scope now?`, ['yes', 'no'], 'yes');
    if (runSetup === 'yes') await setup(['--install-scope', scope]);
    const runDoctor = await askChoice(rl, 'Run sks doctor --fix now?', ['yes', 'no'], 'yes');
    if (runDoctor === 'yes') await doctor(['--fix', '--install-scope', scope]);
    const runSelftest = await askChoice(rl, 'Run sks selftest --mock now?', ['yes', 'no'], 'yes');
    if (runSelftest === 'yes') await selftest(['--mock']);
    console.log('\nSetup UI complete. Useful next commands:');
    console.log('  sks commands');
    console.log('  sks dollar-commands');
    console.log('  sks codex-app');
  } finally {
    rl.close();
  }
}

async function askChoice(rl, question, choices, fallback) {
  const suffix = choices.map((c) => c === fallback ? c.toUpperCase() : c).join('/');
  const raw = (await rl.question(`${question} [${suffix}] `)).trim().toLowerCase();
  const value = raw || fallback;
  const hit = choices.find((c) => c.toLowerCase() === value || c[0].toLowerCase() === value);
  return hit || fallback;
}

async function updateCheck(args = []) {
  const latest = await npmPackageVersion('sneakoscope');
  const result = {
    package: 'sneakoscope',
    current: PACKAGE_VERSION,
    latest: latest.version,
    update_available: latest.version ? compareVersions(latest.version, PACKAGE_VERSION) > 0 : false,
    error: latest.error || null
  };
  if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  console.log('Sneakoscope Codex Update Check');
  console.log(`Current: ${result.current}`);
  console.log(`Latest:  ${result.latest || 'unknown'}`);
  console.log(`Update:  ${result.update_available ? 'available' : 'not needed'}`);
  if (result.error) console.log(`Error:   ${result.error}`);
  if (result.update_available) console.log('Run:     npm i -g sneakoscope');
}

function commands(args = []) {
  if (flag(args, '--json')) return console.log(JSON.stringify({ aliases: ['sks', 'sneakoscope'], dollar_commands: DOLLAR_COMMANDS, app_skill_aliases: DOLLAR_COMMAND_ALIASES, commands: COMMAND_CATALOG }, null, 2));
  console.log('Sneakoscope Codex Commands\n');
  console.log('Aliases: sks, sneakoscope\n');
  const width = Math.max(...COMMAND_CATALOG.map((c) => c.usage.length));
  for (const c of COMMAND_CATALOG) console.log(`${c.usage.padEnd(width)}  ${c.description}`);
  console.log('\nCodex App $ Commands\n');
  console.log('Use these inside Codex App or another agent prompt. They are prompt routes, not terminal commands.\n');
  console.log(formatDollarCommandsDetailed());
  console.log(`\nCanonical Codex App picker skills: ${DOLLAR_COMMAND_ALIASES.map((x) => x.app_skill).join(', ')}`);
}

function dollarCommands(args = []) {
  if (flag(args, '--json')) return console.log(JSON.stringify({ dollar_commands: DOLLAR_COMMANDS, app_skill_aliases: DOLLAR_COMMAND_ALIASES }, null, 2));
  console.log('Sneakoscope Codex $ Commands\n');
  console.log('Use these inside Codex App or another agent prompt. Shells treat $ as variable syntax, so these are prompt commands, not terminal commands.\n');
  console.log(formatDollarCommandsDetailed());
  console.log(`\nCanonical Codex App picker skills: ${DOLLAR_COMMAND_ALIASES.map((x) => x.app_skill).join(', ')}`);
  console.log('\nDefault pipeline: questions infer $Answer, simple design/content edits infer $DFix, and execution prompts use SKS routing with ambiguity gates.');
}

function formatDollarCommandsDetailed(indent = '') {
  const width = Math.max(...DOLLAR_COMMANDS.map((c) => c.command.length));
  return DOLLAR_COMMANDS.map((c) => `${indent}${c.command.padEnd(width)}  ${c.route}: ${c.description}`).join('\n');
}

function formatDollarCommandsCompact(indent = '') {
  const width = Math.max(...DOLLAR_COMMANDS.map((c) => c.command.length));
  return DOLLAR_COMMANDS.map((c) => `${indent}${c.command.padEnd(width)}  ${c.route}`).join('\n');
}

function dollarCommandNames() {
  return DOLLAR_COMMANDS.map((c) => c.command).join(', ');
}

function dfixHelp() {
  console.log(`SKS DFix Mode

Prompt command:
  $DFix <small design/content request>

Examples:
  $DFix 글자 색 파란색으로 바꿔줘
  $DFix 내용을 영어로 바꿔줘
  $DFix Change the CTA label to "Start"

Purpose:
  Fast design/content fixes only. DFix bypasses the general SKS prompt pipeline and uses an ultralight task list.

Rules:
  List the exact micro-edits, inspect only needed files, apply only those edits.
  Do not run mission state, ambiguity gates, TriWiki refresh, Context7 routing, subagents, Ralph, Research, eval, or broad redesign.
  Run only cheap verification when useful.
`);
}

async function context7(sub = 'check', args = []) {
  const root = await projectRoot();
  const action = sub || 'check';
  if (action === 'check') {
    const result = await checkContext7(root);
    if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
    console.log('SKS Context7 MCP\n');
    console.log(`Project config: ${result.project.ok ? 'ok' : 'missing'} ${result.project.path}`);
    console.log(`Global config:  ${result.global.ok ? 'ok' : 'missing'} ${result.global.path}`);
    console.log(`Codex mcp list: ${result.codex_mcp_list.ok ? 'ok' : result.codex_mcp_list.checked ? 'missing' : 'not checked'}`);
    console.log(`Ready:          ${result.ok ? 'yes' : 'no'}`);
    if (!result.ok) console.log('\nRun: sks context7 setup --scope project');
    return;
  }
  if (action === 'tools') {
    const result = await context7Tools({ timeoutMs: readNumberOption(args, '--timeout-ms', 30000) });
    if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
    console.log('SKS Context7 Local MCP Tools\n');
    console.log(`Server: ${result.server.info?.name || 'context7'} ${result.server.info?.version || ''}`.trim());
    console.log(`Command: ${result.server.command} ${result.server.args.join(' ')}`);
    console.log(`Tools:  ${result.tool_names.join(', ') || 'none'}`);
    if (!result.tool_names.includes('resolve-library-id') || !result.tool_names.some((name) => name === 'query-docs' || name === 'get-library-docs')) {
      process.exitCode = 1;
      console.log('\nContext7 local MCP is missing the required resolve/docs tools.');
    }
    return;
  }
  if (action === 'resolve') {
    const positional = positionalArgs(args);
    const libraryName = positional.join(' ').trim();
    if (!libraryName) throw new Error('Usage: sks context7 resolve <library-name> [--query "..."] [--json]');
    const result = await context7Resolve(libraryName, {
      query: readOption(args, '--query', libraryName),
      timeoutMs: readNumberOption(args, '--timeout-ms', 30000)
    });
    if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
    console.log('SKS Context7 Resolve\n');
    console.log(`Library: ${libraryName}`);
    console.log(`ID:      ${result.library_id || 'not resolved'}`);
    console.log(`Server:  ${result.server.info?.name || 'context7'} ${result.server.info?.version || ''}`.trim());
    const text = context7Text(result.result).split(/\n/).slice(0, 24).join('\n').trim();
    if (text) console.log(`\n${text}`);
    if (!result.ok || !result.library_id) process.exitCode = 1;
    return;
  }
  if (action === 'docs') {
    const positional = positionalArgs(args);
    const libraryNameOrId = positional.join(' ').trim();
    if (!libraryNameOrId) throw new Error('Usage: sks context7 docs <library-name|/org/project> [--query "..."] [--topic "..."] [--tokens N] [--json]');
    const result = await context7Docs(libraryNameOrId, {
      query: readOption(args, '--query', readOption(args, '--topic', libraryNameOrId)),
      topic: readOption(args, '--topic', libraryNameOrId),
      tokens: readNumberOption(args, '--tokens', 2000),
      timeoutMs: readNumberOption(args, '--timeout-ms', 30000)
    });
    if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
    printContext7DocsResult(result, { title: 'SKS Context7 Docs' });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === 'evidence') {
    const positional = positionalArgs(args);
    const missionArg = positional.shift();
    const libraryNameOrId = positional.join(' ').trim();
    if (!missionArg || !libraryNameOrId) throw new Error('Usage: sks context7 evidence <mission-id|latest> <library-name|/org/project> [--query "..."] [--topic "..."] [--tokens N] [--json]');
    const missionId = await resolveMissionId(root, missionArg);
    if (!missionId) throw new Error('No mission found for Context7 evidence.');
    const result = await context7Docs(libraryNameOrId, {
      query: readOption(args, '--query', readOption(args, '--topic', libraryNameOrId)),
      topic: readOption(args, '--topic', libraryNameOrId),
      tokens: readNumberOption(args, '--tokens', 2000),
      timeoutMs: readNumberOption(args, '--timeout-ms', 30000)
    });
    const state = { ...(await readJson(stateFile(root), {})), mission_id: missionId };
    await recordContext7Evidence(root, state, { tool_name: 'resolve-library-id', library: libraryNameOrId, library_id: result.library_id, source: result.resolve ? 'sks context7 evidence' : 'sks context7 evidence explicit-library-id' });
    if (result.docs_tool) {
      await recordContext7Evidence(root, state, { tool_name: result.docs_tool, library_id: result.library_id, source: 'sks context7 evidence' });
    }
    const evidence = await context7Evidence(root, state);
    const out = { ...result, mission_id: missionId, evidence };
    if (flag(args, '--json')) return console.log(JSON.stringify(out, null, 2));
    printContext7DocsResult(result, { title: 'SKS Context7 Evidence' });
    console.log(`\nMission:  ${missionId}`);
    console.log(`Evidence: ${evidence.ok ? 'ok' : 'missing'} resolve=${evidence.resolve ? 'yes' : 'no'} docs=${evidence.docs ? 'yes' : 'no'} events=${evidence.count}`);
    if (!result.ok || !evidence.ok) process.exitCode = 1;
    return;
  }
  if (action === 'setup') {
    const scope = readOption(args, '--scope', flag(args, '--global') ? 'global' : 'project');
    const transport = readOption(args, '--transport', flag(args, '--remote') ? 'remote' : 'local');
    if (!['project', 'global'].includes(scope)) throw new Error('Invalid Context7 scope. Use project or global.');
    if (!['local', 'remote'].includes(transport)) throw new Error('Invalid Context7 transport. Use local or remote.');
    if (scope === 'project') {
      const changed = await ensureProjectContext7Config(root, transport);
      const result = await checkContext7(root);
      if (flag(args, '--json')) return console.log(JSON.stringify({ changed, ...result }, null, 2));
      console.log(`Context7 project MCP ${changed ? 'configured' : 'already configured'} in .codex/config.toml`);
      console.log(`Ready: ${result.ok ? 'yes' : 'no'}`);
      return;
    }
    const codex = await getCodexInfo();
    if (!codex.bin) throw new Error('Codex CLI missing. Install separately: npm i -g @openai/codex, or set SKS_CODEX_BIN.');
    const cmdArgs = transport === 'remote'
      ? ['mcp', 'add', 'context7', '--url', 'https://mcp.context7.com/mcp']
      : ['mcp', 'add', 'context7', '--', 'npx', '-y', '@upstash/context7-mcp@latest'];
    const result = await runProcess(codex.bin, cmdArgs, { timeoutMs: 30000, maxOutputBytes: 64 * 1024 });
    if (flag(args, '--json')) return console.log(JSON.stringify({ command: `${codex.bin} ${cmdArgs.join(' ')}`, result }, null, 2));
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'codex mcp add failed');
    console.log('Context7 global MCP configured.');
    return;
  }
  throw new Error(`Unknown context7 command: ${action}`);
}

function printContext7DocsResult(result, opts = {}) {
  console.log(`${opts.title || 'SKS Context7 Docs'}\n`);
  console.log(`Library ID: ${result.library_id || 'not resolved'}`);
  console.log(`Docs tool:  ${result.docs_tool || 'missing'}`);
  console.log(`Server:     ${result.server?.info?.name || 'context7'} ${result.server?.info?.version || ''}`.trim());
  const text = context7Text(result.docs).split(/\n/).slice(0, 48).join('\n').trim();
  if (text) console.log(`\n${text}`);
  if (result.error) console.log(`\nError: ${result.error}`);
}

async function pipeline(sub = 'status', args = []) {
  const root = await projectRoot();
  const action = sub || 'status';
  if (action === 'answer') return pipelineAnswer(root, args);
  const state = await readJson(stateFile(root), {});
  const evidence = await context7Evidence(root, state);
  const stop = await evaluateStop(root, state, { last_assistant_message: 'SKS Honest Mode verification evidence gap' }, { noQuestion: false });
  const result = {
    root,
    state,
    context7: evidence,
    stop_gate: state.stop_gate || null,
    next_action: stop?.reason || 'No active blocking route gate detected.'
  };
  if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  if (action !== 'status' && action !== 'resume') throw new Error(`Unknown pipeline command: ${action}`);
  console.log('SKS Pipeline\n');
  console.log(`Mode:      ${state.mode || 'IDLE'}`);
  console.log(`Route:     ${state.route_command || state.route || 'none'}`);
  console.log(`Phase:     ${state.phase || 'IDLE'}`);
  console.log(`Mission:   ${state.mission_id || 'none'}`);
  console.log(`Reasoning: ${state.reasoning_effort || 'medium'}${state.reasoning_profile ? ` (${state.reasoning_profile})` : ''}${state.reasoning_temporary ? ' temporary' : ''}`);
  console.log(`Stop gate: ${state.stop_gate || 'none'}`);
  console.log(`Context7:  ${state.context7_required ? (evidence.ok ? 'ok' : 'required-missing') : 'optional'} (${evidence.count || 0} event(s))`);
  console.log(`Next:      ${result.next_action}`);
}

async function pipelineAnswer(root, args = []) {
  const [missionArg, answerFile] = args;
  const id = await resolveMissionId(root, missionArg);
  if (!id || !answerFile) throw new Error('Usage: sks pipeline answer <mission-id|latest> <answers.json>');
  const { dir, mission } = await loadMission(root, id);
  const answers = await readJson(path.resolve(answerFile));
  await writeJsonAtomic(path.join(dir, 'answers.json'), answers);
  const result = await sealContract(dir, mission);
  if (!result.ok) {
    console.error('Answer validation failed. SKS ambiguity gate remains locked.');
    console.error(JSON.stringify(result.validation, null, 2));
    process.exitCode = 2;
    return;
  }
  const routeContext = await readJson(path.join(dir, 'route-context.json'), {});
  const route = ROUTES.find((candidate) => candidate.id === routeContext.route || candidate.command === routeContext.command)
    || routePrompt(routeContext.command || routeContext.route || '$SKS');
  await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'pipeline.clarification.contract_sealed', route: route?.id || routeContext.route, hash: result.contract.sealed_hash });
  if (route?.id === 'QALoop') await writeQaLoopArtifacts(dir, mission, result.contract);
  await setCurrent(root, {
    mission_id: id,
    route: route?.id || routeContext.route || 'SKS',
    route_command: route?.command || routeContext.command || '$SKS',
    mode: route?.mode || routeContext.mode || 'SKS',
    phase: `${route?.mode || routeContext.mode || 'SKS'}_CLARIFICATION_CONTRACT_SEALED`,
    context7_required: Boolean(routeContext.context7_required),
    context7_verified: false,
    subagents_required: route ? routeRequiresSubagents(route, routeContext.task || mission.prompt || '') : false,
    subagents_verified: false,
    visible_progress_required: true,
    context_tracking: 'triwiki',
    required_skills: route?.requiredSkills || [],
    stop_gate: route?.stopGate || routeContext.original_stop_gate || 'honest_mode',
    clarification_required: false,
    clarification_passed: true,
    ambiguity_gate_required: true,
    ambiguity_gate_passed: true,
    implementation_allowed: true,
    reasoning_effort: route ? routeReasoning(route, routeContext.task || mission.prompt || '').effort : 'medium',
    reasoning_profile: route ? routeReasoning(route, routeContext.task || mission.prompt || '').profile : 'sks-task-medium',
    reasoning_temporary: true,
    prompt: routeContext.task || mission.prompt || ''
  });
  if (flag(args, '--json')) return console.log(JSON.stringify({ ok: true, mission_id: id, route: route?.id || routeContext.route, hash: result.contract.sealed_hash, validation: result.validation }, null, 2));
  console.log(`SKS ambiguity gate passed for ${id}`);
  console.log(`Route: ${route?.command || routeContext.command || '$SKS'}`);
  console.log(`Hash: ${result.contract.sealed_hash}`);
  console.log('Next: continue the original route lifecycle using decision-contract.json.');
}

async function guard(sub = 'check', args = []) {
  const root = await projectRoot();
  const action = sub || 'check';
  if (action !== 'check' && action !== 'status') throw new Error(`Unknown guard command: ${action}`);
  const status = await harnessGuardStatus(root);
  if (flag(args, '--json')) return console.log(JSON.stringify(status, null, 2));
  console.log('SKS Harness Guard\n');
  console.log(`Status:    ${status.ok ? 'ok' : 'blocked'}`);
  console.log(`Locked:    ${status.locked ? 'yes' : 'no'}`);
  console.log(`Exception: ${status.source_exception ? 'Sneakoscope engine source repo' : 'none'}`);
  console.log(`Policy:    ${status.policy_path}${status.policy_exists ? '' : ' (missing)'}`);
  console.log(`Checked:   ${status.fingerprints_checked} fingerprint(s)`);
  if (status.missing.length) console.log(`Missing:   ${status.missing.join(', ')}`);
  if (status.changed.length) console.log(`Changed:   ${status.changed.join(', ')}`);
}

async function conflicts(sub = 'check', args = []) {
  const root = await projectRoot();
  const action = sub || 'check';
  if (action !== 'check' && action !== 'prompt') throw new Error(`Unknown conflicts command: ${action}`);
  const scan = await scanHarnessConflicts(root);
  const result = { ...scan, cleanup_prompt: scan.hard_block ? llmHarnessCleanupPrompt(scan) : null };
  if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  if (action === 'prompt') return console.log(llmHarnessCleanupPrompt(scan));
  console.log('SKS Harness Conflict Check\n');
  console.log(`Status:    ${scan.hard_block ? 'blocked' : 'ok'}`);
  console.log(`Conflicts: ${scan.conflicts.length}`);
  if (scan.conflicts.length) console.log(formatHarnessConflictReport(scan));
}

async function versioning(sub = 'status', args = []) {
  const root = await projectRoot();
  const action = sub || 'status';
  if (action === 'status' || action === 'check') {
    const status = await versioningStatus(root);
    if (flag(args, '--json')) return console.log(JSON.stringify(status, null, 2));
    console.log('SKS Project Versioning\n');
    console.log(`Enabled:   ${status.enabled ? 'yes' : 'no'}${status.reason ? ` (${status.reason})` : ''}`);
    console.log(`Version:   ${status.package_version || 'none'}`);
    console.log(`Bump:      ${status.bump || 'patch'}`);
    console.log(`Hook:      ${status.hook_installed ? 'installed' : 'missing'}${status.hook_path ? ` ${status.hook_path}` : ''}`);
    console.log(`Last seen: ${status.last_version || 'none'}`);
    if (!status.ok) console.log('Run: sks doctor --fix');
    return;
  }
  if (action === 'hook' || action === 'install-hook') {
    const res = await installVersionGitHook(root, await globalSksCommand());
    if (flag(args, '--json')) return console.log(JSON.stringify(res, null, 2));
    console.log(res.installed ? `Version hook installed: ${res.hook_path}` : `Version hook skipped: ${res.reason}`);
    return;
  }
  if (action === 'bump') {
    const res = await runVersionPreCommit(root, { force: true });
    if (flag(args, '--json')) return console.log(JSON.stringify(res, null, 2));
    if (!res.ok) {
      console.error(`Version bump failed: ${res.reason || 'unknown'}`);
      process.exitCode = 2;
      return;
    }
    console.log(res.changed ? `Project version bumped: ${res.previous_version} -> ${res.version}` : `Project version already advanced: ${res.version}`);
    console.log(`Staged: ${res.staged_files?.join(', ') || 'none'}`);
    return;
  }
  if (action === 'pre-commit') {
    const res = await runVersionPreCommit(root);
    if (flag(args, '--json')) return console.log(JSON.stringify(res, null, 2));
    if (!res.ok) {
      console.error(`SKS versioning failed: ${res.reason || 'unknown'}`);
      process.exitCode = 2;
      return;
    }
    if (res.skipped) return;
    console.log(res.changed ? `SKS versioning: ${res.previous_version} -> ${res.version}` : `SKS versioning: ${res.version} already unique`);
    return;
  }
  console.error('Usage: sks versioning status|bump|pre-commit [--json]');
  process.exitCode = 1;
}

async function reasoningCommand(args = []) {
  const prompt = promptOf(args);
  const route = routePrompt(prompt || '$SKS');
  const info = routeReasoning(route, prompt);
  const result = { route: route?.command || '$SKS', effort: info.effort, profile: info.profile, reason: info.reason, temporary: true, instruction: reasoningInstruction(info) };
  if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  console.log('SKS Reasoning Route\n');
  console.log(`Route:      ${result.route}`);
  console.log(`Effort:     ${result.effort}`);
  console.log(`Profile:    ${result.profile}`);
  console.log(`Reason:     ${result.reason}`);
  console.log('Lifecycle:  temporary; return to default/user-selected profile after the route gate passes');
}

async function checkContext7(root) {
  const projectPath = path.join(root, '.codex', 'config.toml');
  const globalPath = path.join(process.env.HOME || '', '.codex', 'config.toml');
  const projectText = await safeReadText(projectPath);
  const globalText = await safeReadText(globalPath);
  const codex = await getCodexInfo().catch(() => ({}));
  let list = { checked: false, ok: false, stdout: '', stderr: '' };
  if (codex.bin) {
    const out = await runProcess(codex.bin, ['mcp', 'list'], { timeoutMs: 8000, maxOutputBytes: 32 * 1024 }).catch((err) => ({ code: 1, stderr: err.message, stdout: '' }));
    list = { checked: true, ok: out.code === 0 && /context7/i.test(`${out.stdout}\n${out.stderr}`), stdout: out.stdout || '', stderr: out.stderr || '' };
  }
  const result = {
    project: { path: projectPath, ok: hasContext7ConfigText(projectText) },
    global: { path: globalPath, ok: hasContext7ConfigText(globalText) },
    codex_mcp_list: list
  };
  result.ok = result.project.ok || result.global.ok || result.codex_mcp_list.ok;
  return result;
}

async function ensureProjectContext7Config(root, transport = 'local') {
  const configPath = path.join(root, '.codex', 'config.toml');
  await ensureDir(path.dirname(configPath));
  const current = await safeReadText(configPath);
  const block = context7ConfigToml(transport).trim();
  const existingBlock = /(^|\n)\[mcp_servers\.context7\]\n[\s\S]*?(?=\n\[[^\]]+\]|\s*$)/;
  if (existingBlock.test(current)) {
    const next = current.replace(existingBlock, `$1${block}\n`);
    if (next === current) return false;
    await writeTextAtomic(configPath, next.endsWith('\n') ? next : `${next}\n`);
    return true;
  }
  if (hasContext7ConfigText(current)) return false;
  await writeTextAtomic(configPath, `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${block}\n`);
  return true;
}

function readOption(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function readNumberOption(args, name, fallback) {
  const raw = readOption(args, name, null);
  if (raw === null || raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function tmuxCommand(sub = 'start', args = []) {
  const action = sub || 'start';
  if (action === 'status' || action === 'banner') {
    if (flag(args, '--json')) {
      const status = await codexAppIntegrationStatus();
      return console.log(JSON.stringify(status, null, 2));
    }
    await runTmuxStatus(action === 'banner' ? ['--once', ...args] : args);
    return;
  }
  if (action === 'check') {
    const root = await projectRoot();
    const plan = await buildTmuxLaunchPlan({ root, session: readOption(args, '--session', null) });
    if (flag(args, '--json')) return console.log(JSON.stringify(plan, null, 2));
    console.log(formatTmuxBanner(plan.app));
    console.log('');
    console.log(`tmux:      ${plan.tmux.ok ? 'ok' : 'missing'} ${plan.tmux.version || ''}`.trim());
    console.log(`Session:   ${plan.session}`);
    console.log(`Project:   ${plan.root}`);
    console.log(`Ready:     ${plan.ready ? 'yes' : 'no'}`);
    if (!plan.ready) {
      console.log('\nBlockers:');
      for (const blocker of Array.from(new Set(plan.blockers))) console.log(`- ${blocker}`);
      process.exitCode = 1;
    }
    return;
  }
  if (['start', 'attach', 'connect', 'open'].includes(action)) return launchTmuxUi(args);
  console.error('Usage: sks tmux [check|status|banner] [--session name] [--no-attach]');
  process.exitCode = 1;
}

async function autoReviewCommand(sub = 'status', args = []) {
  const action = sub || 'status';
  const high = flag(args, '--high') || action === '--high';
  const cleanArgs = args.filter((arg) => arg !== '--high');
  if (action === 'status' || action === 'check') {
    const status = await autoReviewStatus();
    if (flag(args, '--json')) return console.log(JSON.stringify(status, null, 2));
    console.log(autoReviewSummary(status));
    return;
  }
  if (action === 'disable') {
    const status = await disableAutoReview();
    if (flag(args, '--json')) return console.log(JSON.stringify(status, null, 2));
    console.log(autoReviewSummary(status));
    return;
  }
  if (action === 'enable') {
    const status = await enableAutoReview({ high });
    if (flag(args, '--json')) return console.log(JSON.stringify(status, null, 2));
    console.log(autoReviewSummary(status));
    console.log(`\nProfile ready: ${status.profile_name}`);
    console.log(`Launch: codex --profile ${status.profile_name}`);
    return;
  }
  if (['start', 'open', 'attach', '--high'].includes(action)) {
    const profile = autoReviewProfileName({ high });
    const status = await enableAutoReview({ high });
    if (flag(args, '--json')) return console.log(JSON.stringify(status, null, 2));
    console.log(`SKS Auto-Review enabled: ${profile}`);
    const sessionArg = readOption(cleanArgs, '--session', null);
    const session = sessionArg || sanitizeTmuxSessionName(`${profile}-${defaultTmuxSessionName(process.cwd())}`);
    return launchTmuxUi([...cleanArgs, '--session', session], { codexArgs: ['--profile', profile] });
  }
  console.error('Usage: sks auto-review status|enable|disable|start [--high] [--json]');
  console.error('Alias: sks --Auto-review [--high]');
  process.exitCode = 1;
}

function quickstart() {
  console.log(`Sneakoscope Codex Quickstart

Install from npm and make the CLI/App pair ready:
  npm i -g sneakoscope
  npm i -g @openai/codex
  # Install and open Codex App too: ${CODEX_APP_DOCS_URL}
  sks

Initialize this project for CLI and Codex App:
  sks setup

Verify:
  sks codex-app check
  sks tmux check
  sks auto-review status
  sks doctor --fix
  sks context7 check
  sks selftest --mock
  sks commands
  sks dollar-commands

If hooks cannot find the command:
  sks fix-path

Project-only install:
  npm i -D sneakoscope
  npx sks setup --install-scope project

Local-only install artifacts:
  sks setup --local-only
  # writes generated SKS files but excludes .sneakoscope/, .codex/, .agents/, AGENTS.md through .git/info/exclude
  # user-owned AGENTS.md is preserved; an existing SKS managed block is refreshed

GitHub install for unreleased commits:
  npm i -g git+${REPOSITORY_URL}
`);
}

async function codexAppHelp(args = []) {
  const action = args[0] || 'help';
  if (action === 'check' || action === 'status') {
    const status = await codexAppIntegrationStatus();
    if (flag(args, '--json')) return console.log(JSON.stringify(status, null, 2));
    console.log(formatCodexAppStatus(status, { includeRaw: flag(args, '--verbose') }));
    if (!status.ok) process.exitCode = 1;
    return;
  }
  if (action === 'open') {
    const status = await codexAppIntegrationStatus();
    if (status.app.installed && process.platform === 'darwin') await runProcess('open', ['-a', 'Codex'], { timeoutMs: 5000, maxOutputBytes: 16 * 1024 }).catch(() => null);
    else if (process.platform === 'darwin') await runProcess('open', [CODEX_APP_DOCS_URL], { timeoutMs: 5000, maxOutputBytes: 16 * 1024 }).catch(() => null);
    console.log(formatCodexAppStatus(status));
    return;
  }
  const status = await codexAppIntegrationStatus();
  console.log(`Sneakoscope Codex App Usage

${formatCodexAppStatus(status)}

Run once in the project:
  sks setup

CLI tmux runtime:
  sks
  sks tmux check
  sks tmux --session ${sanitizeTmuxSessionName(defaultTmuxSessionName(process.cwd()))}

Generated app files:
  .codex/config.toml       profiles, multi_agent, Team limits, and Context7 MCP
  .codex/hooks.json        hook events routed through SKS guards
  .agents/skills/          official repo-local Codex App skills
  .codex/agents/           local Codex subagent roles for Team mode
  .codex/SNEAKOSCOPE.md    app quick reference
  AGENTS.md                repository rules

Prompt command routes:
${formatDollarCommandsCompact('  ')}

Useful prompts inside Codex App:
  $DFix 글자 색 바꿔줘
  $DFix 내용을 영어로 바꿔줘
  $Answer 이 훅은 왜 이렇게 동작해?
  $SKS show me available workflows
  $Team agree on the plan, then implement with specialists
  $QA-LOOP run UI and API E2E against local dev
  $Ralph implement this with mandatory clarification
  $Research investigate this idea
  $AutoResearch improve this workflow with experiments.
  $DB check this migration safely
  $GX render a visual context cartridge
  $Help show available SKS commands

Repair hook PATH issues:
  sks fix-path

Discover usage:
  sks commands
  sks usage codex-app
  sks codex-app check
  sks tmux check
  sks dollar-commands
  sks context7 check
  sks pipeline status
  sks reasoning "prompt"
  sks dfix
  sks team "task"
  sks team watch latest
`);
}

function aliases() {
  console.log(`Sneakoscope Codex Aliases

Binary aliases:
  sks
  sneakoscope

Command aliases:
  sks memory    -> sks gc
  sks --help    -> sks help
  sks -h        -> sks help

Codex App prompt commands:
${formatDollarCommandsCompact('  ')}

Examples:
  sks setup
  sneakoscope setup
  sks commands
  sneakoscope commands
`);
}

function usage(args = []) {
  const topic = String(args[0] || 'overview').toLowerCase();
  const blocks = {
    overview: `Sneakoscope Codex Usage

Discovery:
  sks help
  sks update-check
  sks wizard
  sks commands
  sks quickstart
  sks codex-app
  sks codex-app check
  sks tmux check
  sks dollar-commands
  sks context7 check
  sks pipeline status

Common workflows:
  sks usage install
  sks usage tmux
  sks usage team
  sks usage qa-loop
  sks usage ralph
  sks usage research
  sks usage db
  sks usage context7
  sks usage pipeline
  sks usage guard
  sks usage reasoning
  sks usage hproof
  sks usage wiki
  sks usage dfix
`,
    install: `Install and Setup

Global install:
  npm i -g sneakoscope
  npm i -g @openai/codex
  # Install and open Codex App too: ${CODEX_APP_DOCS_URL}
  sks setup
  sks codex-app check
  sks tmux check
  sks doctor --fix
  sks context7 check
  sks selftest --mock

Repair an older broken global install:
  npm uninstall -g sneakoscope
  npm i -g sneakoscope

PATH fallback after global install:
  npx -y -p sneakoscope sks setup
  npx -y -p sneakoscope sks doctor --fix
  npx -y -p sneakoscope sks context7 check

Project-only install:
  npm i -D sneakoscope
  npx sks setup --install-scope project

Local-only install artifacts:
  sks setup --local-only
  # excludes .sneakoscope/, .codex/, .agents/, AGENTS.md through .git/info/exclude
  # user-owned AGENTS.md is preserved; an existing SKS managed block is refreshed

GitHub install for unreleased commits:
  npm i -g git+${REPOSITORY_URL}
  sks setup
`,
    tmux: `SKS tmux Runtime

Open the managed tmux runtime:
  sks

Check readiness without attaching:
  sks tmux check

Create or attach a named session:
  sks tmux --session sks-my-project

Inspect the ㅅㅋㅅ ASCII status surface:
  sks tmux status --once

Requirements:
  Codex App must be installed and opened at least once so first-party MCP/plugin tools are available to Codex CLI.
  Codex CLI must be installed: npm i -g @openai/codex
  tmux must be installed: macOS brew install tmux; Linux use your distro package manager.

QA priority inside this runtime:
  Browser Use first for local browser targets such as localhost, 127.0.0.1, file://, and browser-tab inspection.
  Computer Use for desktop apps, screenshots, and browser/app evidence.
`,
    'auto-review': `Codex Auto-Review

Enable persistent Codex automatic approval review:
  sks auto-review enable

Enable and launch high-reasoning SKS tmux:
  sks --Auto-review --high
  sks auto-review start --high

Inspect or disable:
  sks auto-review status
  sks auto-review disable

Effect:
  Writes approvals_reviewer = "auto_review" to Codex config and creates sks-auto-review / sks-auto-review-high profiles.
  Automatic review applies only to approval prompts that are already interactive under approval_policy = "on-request" or granular approval policies.
`,
    team: `Team Workflow

Initialize Team support:
  sks setup

Create a Team mission:
  sks team "task" executor:5 reviewer:2 user:1
  sks team "task" --agents 5
  sks team watch latest
  sks team event latest --agent analysis_scout_1 --phase parallel_analysis_scouting --message "mapped repo slice"

Inside Codex App:
  $Team executor:5 run parallel analysis scouts, refresh TriWiki, debate the options, agree on one objective, close the debate team, then form a fresh development team with disjoint write scopes.

Expected phases:
  1. Read relevant TriWiki, then parallel analysis scouts run exactly N read-only investigation slices and write source-backed findings to team-analysis.md.
  2. Parent refreshes TriWiki with sks wiki refresh or sks wiki pack and validates .sneakoscope/wiki/context-pack.json before debate.
  3. Debate team has exactly N role participants and maps stubborn user friction, code paths, risks, DB safety, tests, and implementation options using the refreshed pack.
  4. Parent records useful scout, role-agent, result, and handoff lines into team-live.md and team-transcript.jsonl.
  5. Parent agent synthesizes the agreed objective, constraints, acceptance criteria, and parallel work slices, then refreshes/validates TriWiki.
  6. Debate agents are closed.
  7. Fresh N-person executor_N development team reads relevant TriWiki plus current source and handles disjoint slices in parallel.
  8. Strict reviewers and user_N personas validate TriWiki again, then check correctness, DB safety, missing tests, final evidence, and practical friction.

Session budget:
  default: 3 subagent sessions
  executor:N means N analysis scouts, N debate participants, and a separate N-person executor development team
  role counts: executor:5 reviewer:2 user:1 planner:1
  legacy override: --agents N, --sessions N, or --team-size N
  max shorthand: --max-agents uses the configured default maximum of 6 sessions/agents
  parent orchestrator is not counted

Live visibility:
  sks team status <mission-id|latest>
  sks team log <mission-id|latest>
  sks team tail <mission-id|latest>
  sks team watch <mission-id|latest> --follow

Generated Codex App support:
  .codex/config.toml enables multi_agent and [agents] limits.
  .codex/agents/*.toml defines analysis_scout, team_consensus, implementation_worker, db_safety_reviewer, and qa_reviewer.
  .agents/skills/team/SKILL.md explains the orchestration protocol.
`,
    'qa-loop': `QA-LOOP Workflow

Prepare:
  sks qa-loop prepare "QA this app"

Answer generated slots:
  cat .sneakoscope/missions/<MISSION_ID>/questions.md
  cp .sneakoscope/missions/<MISSION_ID>/required-answers.schema.json answers.json
  sks qa-loop answer <MISSION_ID> answers.json

Run:
  sks qa-loop run <MISSION_ID> --max-cycles 8
  sks qa-loop status latest

Inside Codex App:
  $QA-LOOP run UI and API E2E against local dev

Safety:
  UI E2E requires Browser Use or Computer Use evidence, or it must be reported as not verified.
  Login credentials are test-only, runtime-only, and must not be saved to artifacts or TriWiki.
  Non-local/deployed targets are read-only smoke by default; destructive removal scenarios are never allowed there.

Artifacts:
  qa-ledger.json
  qa-report.md
  qa-gate.json
`,
    setup: `Setup Repair

Initialize:
  sks setup

Refresh hook command paths:
  sks fix-path

Inspect readiness:
  sks doctor
  sks doctor --fix
  sks doctor --json
`,
    ralph: `Ralph Workflow

Prepare:
  sks ralph prepare "task"

Answer generated slots:
  cat .sneakoscope/missions/<MISSION_ID>/questions.md
  cp .sneakoscope/missions/<MISSION_ID>/required-answers.schema.json answers.json
  sks ralph answer <MISSION_ID> answers.json

Run:
  sks ralph run <MISSION_ID> --max-cycles 8
  sks ralph status latest

Local smoke run:
  sks ralph run latest --mock
`,
    research: `Research Workflow

Prepare:
  sks research prepare "topic" --depth frontier

Run:
  sks research run latest --max-cycles 3

Inspect:
  sks research status latest
`,
    db: `Database Safety

Policy:
  sks db policy

Scan project config:
  sks db scan --migrations

Generate safe Supabase MCP config:
  sks db mcp-config --project-ref <ref> --features database,docs

Classify/check operations:
  sks db classify --sql "DROP TABLE users"
  sks db check --command "supabase db reset"
  sks db check --file ./migration.sql
`,
    'codex-app': `Codex App

Initialize app files:
  sks setup

Inspect app guidance:
  sks codex-app
  sks codex-app check
  sks tmux check
  sks dollar-commands
  cat .codex/SNEAKOSCOPE.md

Use inside Codex App:
  $DFix 글자 색 바꿔줘
  $DFix 내용을 영어로 바꿔줘
  $SKS show me available workflows
  $Team agree on the plan, then implement with specialists
  $QA-LOOP run UI and API E2E against local dev
  $Ralph implement this with mandatory clarification
  $Research investigate this idea
  $AutoResearch improve this workflow with experiments
  $DB check this migration safely
  $GX render a visual context cartridge
  $Help show available SKS commands
`,
    dfix: `DFix Ultralight Design/Content Fix

Use inside Codex App:
  $DFix 글자 색 파란색으로 바꿔줘
  $DFix 내용을 영어로 바꿔줘
  $DFix Change the button label to "Start"

Behavior:
  Bypass the general SKS prompt pipeline and mission state.
  Use an ultralight task list: locate target, edit only that target, verify cheaply.
  Do not start Ralph, Research, eval, TriWiki refresh, Context7 routing, subagents, or a broad redesign.

CLI help:
  sks dfix
`,
    dollar: `Dollar Commands

Use inside Codex App or an agent prompt:
${formatDollarCommandsCompact('  ')}

Terminal discovery:
  sks dollar-commands
  sks dollar-commands --json
`,
    context7: `Context7 MCP

Check project/global readiness:
  sks context7 check
  sks context7 check --json

Configure project-local stdio MCP:
  sks context7 setup --scope project --transport local

Configure project remote fallback:
  sks context7 setup --scope project --transport remote

Configure global Codex MCP only when explicitly chosen:
  sks context7 setup --scope global --transport local

Call the project-local stdio MCP directly:
  sks context7 tools
  sks context7 resolve "OpenAI Codex" --query "hooks customization"
  sks context7 docs /websites/developers_openai_codex --query "hooks customization"
  sks context7 evidence latest /websites/developers_openai_codex --query "hooks customization"

Required evidence flow:
  1. Context7 resolve-library-id
  2. Context7 query-docs (or legacy get-library-docs)
  3. SKS PostToolUse records context7-evidence.jsonl
`,
    pipeline: `Skill-First Pipeline

Inspect active route:
  sks pipeline status
  sks pipeline status --json

Next action hint:
  sks pipeline resume

Seal mandatory ambiguity-removal answers:
  sks pipeline answer latest answers.json
  sks pipeline answer <mission-id> answers.json

Questions use the $Answer path: TriWiki/web/Context7 evidence when useful, Honest Mode fact-checking, then direct reply. DFix uses an ultralight task-list path for simple design/content fixes. Execution routes start with mandatory ambiguity-removal questions and are routed through state, skills, mission artifacts, Context7 evidence when required, and a Stop hook gate before completion.
`,
    guard: `Harness Guard

Check installed harness self-protection:
  sks guard check
  sks guard check --json

Protected after setup:
  .codex/config.toml
  .codex/hooks.json
  .codex/SNEAKOSCOPE.md
  .agents/skills/
  .codex/agents/
  .sneakoscope/manifest.json
  .sneakoscope/policy.json
  .sneakoscope/db-safety.json
  .sneakoscope/harness-guard.json
  AGENTS.md
  node_modules/sneakoscope

Hooks block LLM tool writes to those paths and block LLM-issued SKS maintenance commands such as sks setup, sks init, sks doctor --fix, sks context7 setup, and npm uninstall sneakoscope.

Exception:
  Only the Sneakoscope engine source repo can edit harness source files automatically.
`,
    conflicts: `Harness Conflict Gate

Check for incompatible Codex harnesses:
  sks conflicts check
  sks conflicts check --json

Print the LLM cleanup prompt:
  sks conflicts prompt

Install behavior:
  npm install/postinstall prints a clean setup-blocked notice when OMX, DCodex, or their global/repo-level traces are detected.
  npm can finish installing the package, but sks setup and sks doctor --fix refuse to continue until a human approves cleanup.
  If cleanup is denied, SKS cannot be installed in that environment.

Cleanup operator:
  Use Codex App with GPT-5.5 high mode.
  Paste the prompt from sks conflicts prompt.
  The LLM must ask for explicit approval before deleting or moving conflicting harness artifacts.
`,
    versioning: `Project Versioning

SKS installs a managed Git pre-commit hook during setup.
Every commit in a package.json project gets a patch version bump in the same commit:
  sks versioning status
  sks versioning bump
  sks versioning hook

Commit behavior:
  package.json version is bumped before Git writes the commit.
  package-lock.json and npm-shrinkwrap.json are kept in sync when present.
  The hook stages those version files automatically.

Collision policy:
  SKS uses a lock in the Git common directory, so multiple workers or worktrees cannot reuse the same version.
  If another worker already used a version, the next commit bumps above the last seen version.

Emergency bypass:
  SKS_DISABLE_VERSIONING=1 git commit ...
`,
    reasoning: `Reasoning Routing

Inspect:
  sks reasoning "change button copy"
  sks reasoning "check this migration"
  sks reasoning "research this idea" --json

Policy:
  medium  simple fulfillment, command discovery, copy/color/mechanical edits
  high    logical work, safety, DB, orchestration, implementation, refactors
  xhigh   research, AutoResearch, hypotheses, falsification, benchmarks, SEO/GEO experiments

Routing is temporary. Return to the default or user-selected profile after the route gate passes.
`,
    eval: `Evaluation

Run benchmark:
  sks eval run
  sks eval run --json --out report.json

Compare reports:
  sks eval compare --baseline old.json --candidate new.json

Show thresholds:
  sks eval thresholds
`,
    hproof: `H-Proof

Evaluate a mission done gate:
  sks hproof check latest
  sks hproof check <mission-id>

Purpose:
  Blocks completion when unsupported critical claims, DB safety issues, missing tests, or high visual/wiki drift remain.
`,
    wiki: `LLM Wiki Context Continuity

Convert RGBA channels to deterministic wiki coordinates:
  sks wiki coords --rgba 12,34,56,255

Build a hydratable context pack:
  sks wiki pack
  sks wiki pack --json --role verifier --max-anchors 48

Validate a saved pack:
  sks wiki validate
  sks wiki validate .sneakoscope/wiki/context-pack.json

Refresh everything in one pass:
  sks wiki refresh
  sks wiki refresh --prune

Prune stale, oversized, or low-trust wiki artifacts:
  sks wiki prune
  sks wiki prune --dry-run --json

Model:
  R -> domain angle
  G -> layer radius through sin()
  B -> phase angle
  A -> concentration/confidence

TriWiki keeps selected claims as text and preserves the rest as anchor ids, RGBA keys, coordinate tuples, source pointers, and hashes so later turns can hydrate the needed context instead of relying on lossy summaries.
`,
    gx: `GX Visual Context

Create:
  sks gx init architecture-atlas

Render and verify:
  sks gx render architecture-atlas --format all
  sks gx validate architecture-atlas
  sks gx drift architecture-atlas
  sks gx snapshot architecture-atlas
`
  };
  const text = blocks[topic] || blocks.overview;
  console.log(text);
}

async function setup(args) {
  const root = await projectRoot();
  const conflicts = await scanHarnessConflicts(root);
  if (conflicts.hard_block) return blockForHarnessConflicts(conflicts, args);
  const installScope = installScopeFromArgs(args);
  const localOnly = flag(args, '--local-only');
  const globalCommand = await globalSksCommand();
  const res = await initProject(root, { force: flag(args, '--force'), installScope, globalCommand, localOnly });
  const install = await installStatus(root, installScope, { globalCommand });
  const versioningInfo = await versioningStatus(root);
  const appRuntime = await codexAppIntegrationStatus();
  const hooksPath = path.join(root, '.codex', 'hooks.json');
  const result = {
    root,
    install,
    hooks: hooksPath,
    codex_app: {
      config: path.join(root, '.codex', 'config.toml'),
      hooks: hooksPath,
      skills: path.join(root, '.agents', 'skills'),
      agents: path.join(root, '.codex', 'agents'),
      quick_reference: path.join(root, '.codex', 'SNEAKOSCOPE.md'),
      agents_rules: path.join(root, 'AGENTS.md')
    },
    codex_app_runtime: appRuntime,
    created: res.created,
    versioning: versioningInfo,
    local_only: localOnly,
    next: ['sks context7 check', 'sks selftest --mock', 'sks doctor', 'sks commands']
  };
  if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  console.log('Sneakoscope Codex Setup\n');
  console.log(`Project:   ${root}`);
  console.log(`Install:   ${install.ok ? 'ok' : 'missing'} ${install.scope} (${install.command_prefix})`);
  console.log(`Hooks:     ${path.relative(root, hooksPath)}`);
  console.log(`Version:   ${versioningInfo.enabled ? (versioningInfo.hook_installed ? 'auto-bump enabled' : 'auto-bump hook missing') : 'not enabled'}${versioningInfo.package_version ? ` (${versioningInfo.package_version})` : ''}`);
  if (localOnly) console.log('Git:       local-only (.git/info/exclude; user AGENTS preserved, SKS managed block refreshed)');
  console.log(`Codex App: .codex/config.toml, .codex/hooks.json, .agents/skills, .codex/agents, .codex/SNEAKOSCOPE.md`);
  console.log(`App tools: ${appRuntime.ok ? 'ok' : 'needs setup'} Codex App=${appRuntime.app.installed ? 'ok' : 'missing'} Browser Use=${appRuntime.mcp.has_browser_use ? 'ok' : 'missing'} Computer Use=${appRuntime.mcp.has_computer_use ? 'ok' : 'missing'}`);
  console.log(`Prompt:    intent-first routing, $Answer fact-check route, $DFix ultralight design/content route, Context7 gate`);
  console.log(`Skills:    .agents/skills`);
  console.log(`Next:      sks context7 check; sks selftest --mock; sks commands; sks dollar-commands`);
  if (!install.ok && install.scope === 'global') console.log('\nGlobal command missing. Run: npm i -g sneakoscope');
  if (!install.ok && install.scope === 'project') console.log('\nProject package missing. Run: npm i -D sneakoscope');
  if (!appRuntime.ok) console.log('\nCodex App and first-party Browser Use/Computer Use tools are required for SKS tmux/QA parity. Run: sks codex-app check');
}

async function fixPath(args) {
  const root = await projectRoot();
  const conflicts = await scanHarnessConflicts(root);
  if (conflicts.hard_block) return blockForHarnessConflicts(conflicts, args);
  const manifest = await readJson(path.join(root, '.sneakoscope', 'manifest.json'), null);
  const installScope = args.includes('--install-scope') || flag(args, '--project') || flag(args, '--global')
    ? installScopeFromArgs(args)
    : normalizeInstallScope(manifest?.installation?.scope || 'global');
  const globalCommand = await globalSksCommand();
  await initProject(root, { installScope, globalCommand, localOnly: flag(args, '--local-only') || Boolean(manifest?.git?.local_only) });
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
  let conflictScan = await scanHarnessConflicts(root);
  let repairApplied = false;
  if (flag(args, '--fix') && !conflictScan.hard_block) {
    const fixScope = requestedScope || 'global';
    const existingManifest = await readJson(path.join(root, '.sneakoscope', 'manifest.json'), null);
    await initProject(root, { installScope: fixScope, globalCommand: await globalSksCommand(), localOnly: flag(args, '--local-only') || Boolean(existingManifest?.git?.local_only), force: true, repair: true });
    repairApplied = true;
    conflictScan = await scanHarnessConflicts(root);
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
  const context7Status = await checkContext7(root);
  const appRuntime = await codexAppIntegrationStatus({ codex });
  const skillStatus = await checkRequiredSkills(root);
  const guardStatus = await harnessGuardStatus(root);
  const versioningInfo = await versioningStatus(root);
  const codexApp = {
    config: { ok: await exists(path.join(root, '.codex', 'config.toml')) },
    hooks: { ok: await exists(path.join(root, '.codex', 'hooks.json')) },
    versioning: versioningInfo,
    skills: skillStatus,
    agents: { ok: await exists(path.join(root, '.codex', 'agents')) },
    quick_reference: { ok: await exists(path.join(root, '.codex', 'SNEAKOSCOPE.md')) },
    agents_rules: { ok: await exists(path.join(root, 'AGENTS.md')) }
  };
  const result = {
    node: { ok: nodeOk, version: process.version }, root, codex, rust,
    install,
    repair: { applied: repairApplied, blocked_by_other_harness: flag(args, '--fix') && conflictScan.hard_block },
    harness_conflicts: {
      ok: conflictScan.ok,
      hard_block: conflictScan.hard_block,
      requires_human_approval: conflictScan.requires_human_approval,
      conflicts: conflictScan.conflicts,
      cleanup_prompt: conflictScan.hard_block ? llmHarnessCleanupPrompt(conflictScan) : null
    },
    sneakoscope: { ok: await exists(path.join(root, '.sneakoscope')) },
    context7: context7Status,
    codex_app_runtime: appRuntime,
    harness_guard: guardStatus,
    versioning: versioningInfo,
    db_guard: { ok: dbPolicyExists && dbScan.ok, policy: dbPolicyExists ? await loadDbSafetyPolicy(root) : null, scan: dbScan },
    hooks: { ok: await exists(path.join(root, '.codex', 'hooks.json')) },
    skills: { ok: await exists(path.join(root, '.agents', 'skills')) },
    codex_app: {
      ...codexApp,
      ok: codexApp.config.ok && codexApp.hooks.ok && codexApp.skills.ok && codexApp.agents.ok && codexApp.quick_reference.ok && codexApp.agents_rules.ok
    },
    package: { bytes: pkgBytes, human: formatBytes(pkgBytes) }, storage
  };
  result.ready = !result.harness_conflicts.hard_block && nodeOk && Boolean(codex.bin) && install.ok && result.sneakoscope.ok && result.context7.ok && appRuntime.ok && result.harness_guard.ok && result.versioning.ok && result.db_guard.ok && result.codex_app.ok && result.skills.ok;
  if (result.harness_conflicts.hard_block) process.exitCode = 1;
  if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  console.log('Sneakoscope Codex Doctor\n');
  console.log(`Node:      ${nodeOk ? 'ok' : 'fail'} ${process.version}`);
  console.log(`Project:   ${root}`);
  console.log(`Codex:     ${codex.bin ? 'ok' : 'missing'} ${codex.version || ''}`);
  console.log(`Install:   ${install.ok ? 'ok' : 'missing'} ${install.scope} (${install.command_prefix})`);
  console.log(`Conflicts: ${result.harness_conflicts.hard_block ? 'blocked' : 'ok'} ${result.harness_conflicts.conflicts.length} finding(s)`);
  if (repairApplied) console.log('Repair:    regenerated SKS managed files from the installed package template');
  if (flag(args, '--fix') && result.harness_conflicts.hard_block) console.log('Repair:    skipped because another Codex harness needs human-approved removal first');
  console.log(`Rust acc.: ${rust.available ? rust.version : 'optional-missing'}`);
  console.log(`State:     ${result.sneakoscope.ok ? 'ok' : 'missing .sneakoscope'}`);
  console.log(`Context7:  ${result.context7.ok ? 'ok' : 'missing MCP config'} project=${result.context7.project.ok ? 'ok' : 'missing'} global=${result.context7.global.ok ? 'ok' : 'missing'}`);
  console.log(`App tools: ${appRuntime.ok ? 'ok' : 'needs setup'} Codex App=${appRuntime.app.installed ? 'ok' : 'missing'} Browser Use=${appRuntime.mcp.has_browser_use ? 'ok' : 'missing'} Computer Use=${appRuntime.mcp.has_computer_use ? 'ok' : 'missing'}`);
  console.log(`Guard:     ${result.harness_guard.ok ? 'ok' : 'blocked'}${result.harness_guard.source_exception ? ' source-exception' : ''}`);
  console.log(`Version:   ${result.versioning.ok ? 'ok' : 'missing'}${result.versioning.enabled ? ` ${result.versioning.package_version || ''}` : ` ${result.versioning.reason || 'disabled'}`}`);
  console.log(`DB Guard:  ${result.db_guard.ok ? 'ok' : 'blocked'} ${dbScan.findings?.length || 0} finding(s)`);
  console.log(`Hooks:     ${result.hooks.ok ? 'ok' : 'missing .codex/hooks.json'}`);
  console.log(`Codex App: ${result.codex_app.ok ? 'ok' : 'missing app files'} .codex/config.toml .codex/hooks.json .agents/skills .codex/agents .codex/SNEAKOSCOPE.md`);
  console.log(`Skills:    ${result.skills.ok ? 'ok' : `missing ${result.skills.missing.length} skill(s)`}`);
  console.log(`Package:   ${result.package.human}`);
  console.log(`Storage:   ${storage.total_human || '0 B'}`);
  console.log(`Ready:     ${result.ready ? 'yes' : 'no'}`);
  if (!codex.bin) console.log('\nCodex CLI missing. Install separately: npm i -g @openai/codex, or set SKS_CODEX_BIN.');
  if (!install.ok && install.scope === 'global') console.log('SKS global command missing. Install: npm i -g sneakoscope');
  if (!install.ok && install.scope === 'project') console.log('SKS project package missing. Install in this project: npm i -D sneakoscope');
  if (result.harness_conflicts.hard_block) console.log(`\n${formatHarnessConflictReport(conflictScan)}`);
  if (!result.context7.ok) console.log('Context7 MCP missing. Run: sks context7 setup --scope project');
  if (!appRuntime.ok) console.log('Codex App or first-party MCP/plugin tools missing. Run: sks codex-app check');
  if (!result.harness_guard.ok) console.log('Harness guard failed. Run: sks setup from a real terminal, then sks guard check.');
  if (!result.versioning.ok) console.log('Versioning hook missing. Run: sks versioning hook, or sks doctor --fix.');
  if (!result.skills.ok) console.log(`Missing skills: ${result.skills.missing.join(', ')}. Run: sks setup`);
  if (!result.ready && !flag(args, '--fix')) console.log('Run: sks doctor --fix');
}

async function checkRequiredSkills(root) {
  const expected = Array.from(new Set([
    ...DOLLAR_SKILL_NAMES,
    ...RECOMMENDED_SKILLS
  ])).sort();
  const missing = [];
  for (const name of expected) {
    if (!(await exists(path.join(root, '.agents', 'skills', name, 'SKILL.md')))) missing.push(name);
  }
  return { ok: missing.length === 0, expected, missing };
}

async function init(args) {
  const root = await projectRoot();
  const conflicts = await scanHarnessConflicts(root);
  if (conflicts.hard_block) return blockForHarnessConflicts(conflicts, args);
  const installScope = installScopeFromArgs(args);
  const localOnly = flag(args, '--local-only');
  const globalCommand = await globalSksCommand();
  const res = await initProject(root, { force: flag(args, '--force'), installScope, globalCommand, localOnly });
  console.log(`Initialized Sneakoscope Codex in ${root}`);
  console.log(`Install scope: ${installScope} (${sksCommandPrefix(installScope, { globalCommand })})`);
  if (localOnly) console.log('Git mode: local-only (.git/info/exclude)');
  for (const x of res.created) console.log(`- ${x}`);
}

function blockForHarnessConflicts(scan, args = []) {
  const result = { ready: false, install_blocked: true, harness_conflicts: scan, cleanup_prompt: llmHarnessCleanupPrompt(scan) };
  process.exitCode = 1;
  if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  console.error(formatHarnessConflictReport(scan));
  console.error('\nSKS setup cannot continue while another Codex harness is present.');
}

async function globalSksCommand() {
  return await discoverGlobalSksCommand() || 'sks';
}

async function installStatus(root, scope, opts = {}) {
  const discoveredGlobalBin = await discoverGlobalSksCommand();
  const configuredGlobalBin = await configuredSksBin(opts.globalCommand);
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

async function discoverGlobalSksCommand() {
  const configured = await configuredSksBin(process.env.SKS_BIN);
  if (configured) return configured;
  for (const name of ['sks', 'sneakoscope']) {
    const found = await which(name).catch(() => null);
    if (isStableSksBin(found)) return found;
  }
  return await npmGlobalSksBin();
}

async function configuredSksBin(candidate) {
  if (!candidate || candidate === 'sks') return null;
  return isStableSksBin(candidate) && await exists(candidate) ? candidate : null;
}

function isStableSksBin(candidate) {
  return Boolean(candidate) && !isTransientNpmBinPath(candidate);
}

function isTransientNpmBinPath(candidate) {
  const normalized = String(candidate || '').split(path.sep).join('/');
  return normalized.includes('/_npx/')
    || normalized.includes('/_cacache/tmp/')
    || /\/npm-cache\/_npx\//.test(normalized)
    || (/\/node_modules\/\.bin\/sks$/.test(normalized) && normalized.includes('/.npm-cache/'));
}

async function npmGlobalSksBin() {
  const npm = await which('npm').catch(() => null);
  if (!npm) return null;
  const result = await runProcess(npm, ['prefix', '-g'], { timeoutMs: 10000, maxOutputBytes: 4096 });
  if (result.code !== 0) return null;
  const prefix = result.stdout.trim().split(/\r?\n/).pop();
  if (!prefix) return null;
  const binDir = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
  const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const name of ['sks', 'sneakoscope']) {
    for (const suffix of suffixes) {
      const candidate = path.join(binDir, `${name}${suffix}`);
      if (isStableSksBin(candidate) && await exists(candidate)) return candidate;
    }
  }
  return null;
}

async function npmPackageVersion(name) {
  const npm = await which('npm').catch(() => null);
  if (!npm) return { error: 'npm not found' };
  const result = await runProcess(npm, ['view', name, 'version'], { timeoutMs: 5000, maxOutputBytes: 4096 });
  if (result.code !== 0) return { error: `${result.stderr || result.stdout || 'npm view failed'}`.trim() };
  return { version: result.stdout.trim().split(/\s+/).pop() };
}

function compareVersions(a, b) {
  const pa = String(a || '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b || '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
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

async function qaLoop(sub, args) {
  const known = new Set(['prepare', 'answer', 'run', 'status', 'help', '--help', '-h']);
  const action = known.has(sub) ? sub : 'prepare';
  const actionArgs = action === 'prepare' && sub && !known.has(sub) ? [sub, ...args] : args;
  if (action === 'prepare') return qaLoopPrepare(actionArgs);
  if (action === 'answer') return qaLoopAnswer(actionArgs);
  if (action === 'run') return qaLoopRun(actionArgs);
  if (action === 'status') return qaLoopStatus(actionArgs);
  console.log(`SKS QA-LOOP

Usage:
  sks qa-loop prepare "target"
  sks qa-loop answer <mission-id|latest> <answers.json>
  sks qa-loop run <mission-id|latest> [--mock] [--max-cycles N]
  sks qa-loop status <mission-id|latest>

Prompt route:
  $QA-LOOP run UI and API E2E against local dev
`);
}

function qaRoute() {
  return ROUTES.find((route) => route.id === 'QALoop') || routePrompt('$QA-LOOP');
}

async function qaLoopPrepare(args) {
  const root = await projectRoot();
  if (!(await exists(path.join(root, '.sneakoscope')))) await initProject(root, {});
  const prompt = promptOf(args);
  if (!prompt) throw new Error('Missing QA target prompt.');
  const { id, dir } = await createMission(root, { mode: 'qaloop', prompt });
  const schema = buildQaLoopQuestionSchema(prompt);
  const route = qaRoute();
  await writeQuestions(dir, schema);
  await writeJsonAtomic(path.join(dir, 'route-context.json'), { route: 'QALoop', command: '$QA-LOOP', mode: 'QALOOP', task: prompt, required_skills: route?.requiredSkills || [], context7_required: false, original_stop_gate: 'qa-gate.json', clarification_gate: true });
  await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'qaloop.prepare.questions_created', slots: schema.slots.length });
  await setCurrent(root, { mission_id: id, route: 'QALoop', route_command: '$QA-LOOP', mode: 'QALOOP', phase: 'QALOOP_CLARIFICATION_AWAITING_ANSWERS', questions_allowed: true, implementation_allowed: false, clarification_required: true, ambiguity_gate_required: true, stop_gate: 'clarification-gate', reasoning_effort: 'high', reasoning_profile: 'sks-logic-high', reasoning_temporary: true });
  console.log(`QA-LOOP mission created: ${id}`);
  console.log('QA-LOOP is locked until all required answers are supplied.');
  console.log(`Questions: ${path.relative(root, path.join(dir, 'questions.md'))}`);
  console.log(`Answer schema: ${path.relative(root, path.join(dir, 'required-answers.schema.json'))}`);
  console.log('\nRequired questions:');
  console.log(formatRalphQuestionsForCli(schema));
}

async function qaLoopAnswer(args) {
  const root = await projectRoot();
  const [missionArg, answerFile] = args;
  const id = await resolveMissionId(root, missionArg);
  if (!id || !answerFile) throw new Error('Usage: sks qa-loop answer <mission-id|latest> <answers.json>');
  const { dir, mission } = await loadMission(root, id);
  const answers = await readJson(path.resolve(answerFile));
  await writeJsonAtomic(path.join(dir, 'answers.json'), answers);
  const result = await sealContract(dir, mission);
  if (!result.ok) {
    console.error('Answer validation failed. QA-LOOP remains locked.');
    console.error(JSON.stringify(result.validation, null, 2));
    process.exitCode = 2;
    return;
  }
  const artifactResult = await writeQaLoopArtifacts(dir, mission, result.contract);
  await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'qaloop.contract.sealed', hash: result.contract.sealed_hash, checklist_count: artifactResult.checklist_count });
  await setCurrent(root, { mission_id: id, route: 'QALoop', route_command: '$QA-LOOP', mode: 'QALOOP', phase: 'QALOOP_CLARIFICATION_CONTRACT_SEALED', questions_allowed: false, implementation_allowed: true, clarification_required: false, clarification_passed: true, ambiguity_gate_passed: true, stop_gate: 'qa-gate.json', reasoning_effort: 'high', reasoning_profile: 'sks-logic-high', reasoning_temporary: true });
  console.log(`QA-LOOP contract sealed for ${id}`);
  console.log(`Hash: ${result.contract.sealed_hash}`);
  console.log(`Checklist: ${artifactResult.checklist_count} cases`);
  console.log(`Report: ${path.relative(root, path.join(dir, 'qa-report.md'))}`);
  console.log(`Run: sks qa-loop run ${id} --max-cycles ${answers.MAX_QA_CYCLES || 8}`);
}

async function qaLoopRun(args) {
  const root = await projectRoot();
  const id = await resolveMissionId(root, args[0]);
  if (!id) throw new Error('Usage: sks qa-loop run <mission-id|latest> [--mock] [--max-cycles N]');
  const { dir, mission } = await loadMission(root, id);
  const contractPath = path.join(dir, 'decision-contract.json');
  if (!(await exists(contractPath))) throw new Error('QA-LOOP cannot run: decision-contract.json is missing.');
  const contract = await readJson(contractPath);
  if (!(await exists(path.join(dir, 'qa-ledger.json')))) await writeQaLoopArtifacts(dir, mission, contract);
  const safetyScan = await scanDbSafety(root);
  if (!safetyScan.ok) {
    console.error('QA-LOOP cannot run: SKS safety scan found unsafe project data-tool configuration.');
    console.error(JSON.stringify(safetyScan.findings, null, 2));
    process.exitCode = 2;
    return;
  }
  const fallbackCycles = Number.parseInt(contract.answers?.MAX_QA_CYCLES, 10) || 8;
  const maxCycles = readMaxCycles(args, fallbackCycles);
  const mock = flag(args, '--mock');
  await setCurrent(root, { mission_id: id, route: 'QALoop', route_command: '$QA-LOOP', mode: 'QALOOP', phase: 'QALOOP_RUNNING_NO_QUESTIONS', questions_allowed: false, stop_gate: 'qa-gate.json', reasoning_effort: 'high', reasoning_profile: 'sks-logic-high', reasoning_temporary: true });
  await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'qaloop.run.started', maxCycles, mock });
  if (mock) {
    const gate = await writeMockQaResult(dir, mission, contract);
    await setCurrent(root, { mission_id: id, mode: 'QALOOP', phase: gate.passed ? 'QALOOP_DONE' : 'QALOOP_PAUSED', questions_allowed: true });
    console.log(`Mock QA-LOOP done: ${id}`);
    console.log(`Gate: ${gate.passed ? 'passed' : 'blocked'}`);
    return;
  }
  const codex = await getCodexInfo();
  if (!codex.bin) {
    console.error('Codex CLI not found. Running mock QA-LOOP instead.');
    const gate = await writeMockQaResult(dir, mission, contract);
    await setCurrent(root, { mission_id: id, mode: 'QALOOP', phase: gate.passed ? 'QALOOP_DONE' : 'QALOOP_PAUSED', questions_allowed: true });
    console.log(`Mock QA-LOOP done: ${id}`);
    return;
  }
  let last = '';
  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    const cycleDir = path.join(dir, 'qa-loop', `cycle-${cycle}`);
    const outputFile = path.join(cycleDir, 'final.md');
    const prompt = buildQaLoopPrompt({ id, mission, contract, cycle, previous: last });
    await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'qaloop.cycle.start', cycle });
    const result = await runCodexExec({ root, prompt, outputFile, json: true, profile: 'sks-logic-high', logDir: cycleDir });
    await writeJsonAtomic(path.join(cycleDir, 'process.json'), { code: result.code, stdout_tail: result.stdout, stderr_tail: result.stderr, stdout_bytes: result.stdoutBytes, stderr_bytes: result.stderrBytes, truncated: result.truncated, timed_out: result.timedOut });
    last = await safeReadText(outputFile, result.stdout || result.stderr || '');
    if (containsUserQuestion(last)) {
      await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'qaloop.guard.question_blocked', cycle });
      last = `${last}\n\n${noQuestionContinuationReason()}`;
      continue;
    }
    const gate = await evaluateQaGate(dir);
    if (gate.passed) {
      await setCurrent(root, { mission_id: id, mode: 'QALOOP', phase: 'QALOOP_DONE', questions_allowed: true });
      await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'qaloop.done', cycle });
      console.log(`QA-LOOP done: ${id}`);
      return;
    }
    await appendJsonlBounded(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'qaloop.cycle.continue', cycle, reasons: gate.reasons });
  }
  await setCurrent(root, { mission_id: id, mode: 'QALOOP', phase: 'QALOOP_PAUSED_MAX_CYCLES', questions_allowed: true });
  console.log(`QA-LOOP paused after max cycles: ${id}`);
}

async function qaLoopStatus(args) {
  const root = await projectRoot();
  const id = await resolveMissionId(root, args[0]);
  if (!id) throw new Error('Usage: sks qa-loop status <mission-id|latest>');
  const { dir, mission } = await loadMission(root, id);
  const state = await readJson(stateFile(root), {});
  const status = await qaStatus(dir);
  if (flag(args, '--json')) return console.log(JSON.stringify({ mission, state, qa: status }, null, 2));
  console.log('SKS QA-LOOP Status\n');
  console.log(`Mission:   ${id}`);
  console.log(`Phase:     ${state.phase || mission.phase}`);
  console.log(`Checklist: ${status.checklist_count ?? 'none'}`);
  console.log(`Report:    ${status.report_written ? 'present' : 'missing'}`);
  console.log(`Gate:      ${status.gate?.passed ? 'passed' : 'not passed'}`);
  if (status.gate?.reasons?.length) console.log(`Reasons:   ${status.gate.reasons.join(', ')}`);
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
  await setCurrent(root, { mission_id: id, mode: 'RALPH', phase: 'RALPH_AWAITING_ANSWERS', questions_allowed: true, implementation_allowed: false });
  console.log(`Mission created: ${id}`);
  console.log('Ralph Prepare completed. Ralph run is locked until all required answers are supplied.');
  console.log(`Questions: ${path.relative(root, path.join(dir, 'questions.md'))}`);
  console.log(`Answer schema: ${path.relative(root, path.join(dir, 'required-answers.schema.json'))}`);
  console.log('\nRequired questions:');
  console.log(formatRalphQuestionsForCli(schema));
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

function formatRalphQuestionsForCli(schema) {
  return schema.slots.map((s, i) => {
    const options = s.options ? ` Options: ${s.options.join(', ')}.` : '';
    const examples = s.examples ? ` Examples: ${s.examples.join(', ')}.` : '';
    return `${i + 1}. ${s.id}: ${s.question}${options}${examples}`;
  }).join('\n');
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
  const guardStatus = await harnessGuardStatus(tmp);
  if (!guardStatus.ok || !guardStatus.locked || guardStatus.source_exception) throw new Error('selftest failed: harness guard not locked in installed project');
  const repairTmp = tmpdir();
  await initProject(repairTmp, {});
  await writeTextAtomic(path.join(repairTmp, '.agents', 'skills', 'team', 'SKILL.md'), 'tampered\n');
  await writeTextAtomic(path.join(repairTmp, '.agents', 'skills', 'agent-team', 'SKILL.md'), '---\nname: agent-team\ndescription: Fallback Codex App picker alias for $Team.\n---\n');
  await writeTextAtomic(path.join(repairTmp, '.codex', 'skills', 'team', 'SKILL.md'), 'legacy mirror\n');
  await initProject(repairTmp, { force: true, repair: true });
  const repairedTeamSkill = await safeReadText(path.join(repairTmp, '.agents', 'skills', 'team', 'SKILL.md'));
  if (!repairedTeamSkill.includes('SKS Team multi-agent orchestration') || repairedTeamSkill.includes('tampered')) throw new Error('selftest failed: doctor repair did not regenerate team skill');
  if (await exists(path.join(repairTmp, '.agents', 'skills', 'agent-team', 'SKILL.md'))) throw new Error('selftest failed: doctor repair did not remove deprecated agent-team alias skill');
  if (await exists(path.join(repairTmp, '.codex', 'skills', 'team', 'SKILL.md'))) throw new Error('selftest failed: doctor repair did not remove legacy .codex/skills');
  const conflictTmp = tmpdir();
  await ensureDir(path.join(conflictTmp, '.omx'));
  const conflictScan = await scanHarnessConflicts(conflictTmp, { home: path.join(conflictTmp, 'home') });
  if (!conflictScan.hard_block || !formatHarnessConflictReport(conflictScan).includes('GPT-5.5')) throw new Error('selftest failed: OMX conflict did not block with cleanup prompt');
  const postinstallConflict = await runProcess(process.execPath, [path.join(packageRoot(), 'bin', 'sks.mjs'), 'postinstall'], { cwd: conflictTmp, env: { INIT_CWD: conflictTmp, HOME: path.join(conflictTmp, 'home'), SKS_SKIP_POSTINSTALL_SHIM: '1', SKS_SKIP_POSTINSTALL_CONTEXT7: '1' }, timeoutMs: 15000, maxOutputBytes: 128 * 1024 });
  if (postinstallConflict.code !== 0) throw new Error('selftest failed: postinstall conflict notice should not make npm install fail');
  const postinstallConflictOutput = String(`${postinstallConflict.stdout}\n${postinstallConflict.stderr}`);
  if (!postinstallConflictOutput.includes('SKS setup is blocked') || postinstallConflictOutput.includes('Cleanup prompt:')) throw new Error('selftest failed: postinstall conflict notice did not stay informational');
  const postinstallConflictPrompt = await runProcess(process.execPath, [path.join(packageRoot(), 'bin', 'sks.mjs'), 'postinstall'], { cwd: conflictTmp, input: 'y\n', env: { INIT_CWD: conflictTmp, HOME: path.join(conflictTmp, 'home'), SKS_SKIP_POSTINSTALL_SHIM: '1', SKS_SKIP_POSTINSTALL_CONTEXT7: '1', SKS_POSTINSTALL_PROMPT: '1' }, timeoutMs: 15000, maxOutputBytes: 128 * 1024 });
  if (postinstallConflictPrompt.code !== 0 || !String(postinstallConflictPrompt.stdout || '').includes('Goal: completely remove the conflicting Codex harnesses')) throw new Error('selftest failed: interactive postinstall prompt did not print cleanup prompt');
  const postinstallSetupTmp = tmpdir();
  await writeJsonAtomic(path.join(postinstallSetupTmp, 'package.json'), { name: 'postinstall-setup-smoke', version: '0.0.0' });
  const postinstallSetup = await runProcess(process.execPath, [path.join(packageRoot(), 'bin', 'sks.mjs'), 'postinstall'], { cwd: postinstallSetupTmp, env: { INIT_CWD: postinstallSetupTmp, HOME: path.join(postinstallSetupTmp, 'home'), SKS_SKIP_POSTINSTALL_SHIM: '1', SKS_SKIP_POSTINSTALL_CONTEXT7: '1' }, timeoutMs: 15000, maxOutputBytes: 128 * 1024 });
  if (postinstallSetup.code !== 0) throw new Error(`selftest failed: postinstall setup exited ${postinstallSetup.code}: ${postinstallSetup.stderr}`);
  if (await exists(path.join(postinstallSetupTmp, '.agents', 'skills', 'agent-team', 'SKILL.md'))) throw new Error('selftest failed: postinstall installed deprecated agent-team fallback skill');
  if (!String(postinstallSetup.stdout || '').includes('Codex App project setup: installed')) throw new Error('selftest failed: postinstall did not report automatic Codex App setup');
  const guardBlocked = await checkHarnessModification(tmp, { tool_name: 'apply_patch', command: '*** Update File: .agents/skills/team/SKILL.md\n+tamper\n' });
  if (guardBlocked.action !== 'block') throw new Error('selftest failed: harness guard allowed skill tampering');
  const setupBlocked = await checkHarnessModification(tmp, { command: 'sks setup --force' });
  if (setupBlocked.action !== 'block') throw new Error('selftest failed: harness guard allowed setup maintenance command');
  const appEditAllowed = await checkHarnessModification(tmp, { tool_name: 'apply_patch', command: '*** Update File: src/app.js\n+ok\n' });
  if (appEditAllowed.action === 'block') throw new Error('selftest failed: harness guard blocked app source edit');
  const sourceEditAllowed = await checkHarnessModification(packageRoot(), { tool_name: 'apply_patch', command: '*** Update File: src/core/init.mjs\n+ok\n' });
  if (sourceEditAllowed.action === 'block' || !(await isHarnessSourceProject(packageRoot()))) throw new Error('selftest failed: harness source exception not honored');
  const defaultHooks = await readJson(path.join(tmp, '.codex', 'hooks.json'));
  if (defaultHooks.hooks.PreToolUse[0].hooks[0].command !== 'sks hook pre-tool') throw new Error('selftest failed: global install hook command changed');
  const sharedHooksTmp = tmpdir();
  await ensureDir(path.join(sharedHooksTmp, '.codex'));
  await writeJsonAtomic(path.join(sharedHooksTmp, '.codex', 'hooks.json'), {
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: 'node ./old/sks.mjs hook user-prompt-submit' }] },
        { hooks: [{ type: 'command', command: 'node ./user-hook.mjs' }] }
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'node ./user-stop.mjs' }] }]
    },
    user_key: true
  });
  await initProject(sharedHooksTmp, {});
  const sharedHooks = await readJson(path.join(sharedHooksTmp, '.codex', 'hooks.json'));
  if (!sharedHooks.user_key) throw new Error('selftest failed: hooks merge dropped root metadata');
  if (!sharedHooks.hooks.UserPromptSubmit.some((entry) => entry.hooks?.some((hook) => hook.command === 'node ./user-hook.mjs'))) throw new Error('selftest failed: hooks merge dropped user hook');
  if (JSON.stringify(sharedHooks).includes('node ./old/sks.mjs hook user-prompt-submit')) throw new Error('selftest failed: hooks merge kept stale SKS hook');
  if (sharedHooks.hooks.UserPromptSubmit.filter((entry) => entry.hooks?.some((hook) => hook.command === 'sks hook user-prompt-submit')).length !== 1) throw new Error('selftest failed: hooks merge did not install exactly one SKS prompt hook');
  const absoluteHookTmp = tmpdir();
  await initProject(absoluteHookTmp, { globalCommand: '/usr/local/bin/sks' });
  const absoluteHooks = await readJson(path.join(absoluteHookTmp, '.codex', 'hooks.json'));
  if (absoluteHooks.hooks.PreToolUse[0].hooks[0].command !== '/usr/local/bin/sks hook pre-tool') throw new Error('selftest failed: absolute global hook command missing');
  const projectScopeTmp = tmpdir();
  await initProject(projectScopeTmp, { installScope: 'project' });
  const projectHooks = await readJson(path.join(projectScopeTmp, '.codex', 'hooks.json'));
  if (projectHooks.hooks.PreToolUse[0].hooks[0].command !== 'node ./node_modules/sneakoscope/bin/sks.mjs hook pre-tool') throw new Error('selftest failed: project install hook command missing');
  const sourceHookTmp = tmpdir();
  await writeJsonAtomic(path.join(sourceHookTmp, 'package.json'), { name: 'sneakoscope', version: '0.0.0' });
  await ensureDir(path.join(sourceHookTmp, 'bin'));
  await ensureDir(path.join(sourceHookTmp, 'src', 'core'));
  await writeTextAtomic(path.join(sourceHookTmp, 'bin', 'sks.mjs'), '#!/usr/bin/env node\n');
  await writeTextAtomic(path.join(sourceHookTmp, 'src', 'core', 'init.mjs'), '');
  await writeTextAtomic(path.join(sourceHookTmp, 'src', 'core', 'hooks-runtime.mjs'), '');
  await initProject(sourceHookTmp, { installScope: 'global', globalCommand: '/usr/local/bin/sks' });
  const sourceHooks = await readJson(path.join(sourceHookTmp, '.codex', 'hooks.json'));
  if (sourceHooks.hooks.PreToolUse[0].hooks[0].command !== 'node ./bin/sks.mjs hook pre-tool') throw new Error('selftest failed: source repo hook command should use local bin');
  const versionTmp = tmpdir();
  await runProcess('git', ['init'], { cwd: versionTmp, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  await runProcess('git', ['config', 'user.email', 'sks-selftest@example.invalid'], { cwd: versionTmp, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  await runProcess('git', ['config', 'user.name', 'SKS Selftest'], { cwd: versionTmp, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  await writeJsonAtomic(path.join(versionTmp, 'package.json'), { name: 'sks-version-selftest', version: '0.1.0' });
  await writeJsonAtomic(path.join(versionTmp, 'package-lock.json'), { name: 'sks-version-selftest', version: '0.1.0', lockfileVersion: 3, packages: { '': { name: 'sks-version-selftest', version: '0.1.0' } } });
  await runProcess('git', ['add', 'package.json', 'package-lock.json'], { cwd: versionTmp, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  await runProcess('git', ['commit', '--no-verify', '-m', 'initial'], { cwd: versionTmp, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  await writeTextAtomic(path.join(versionTmp, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
  await initProject(versionTmp, {});
  const versionStatus = await versioningStatus(versionTmp);
  if (!versionStatus.ok || !versionStatus.enabled || !versionStatus.hook_installed) throw new Error('selftest failed: versioning hook not installed');
  const versionHookText = await safeReadText(versionStatus.hook_path);
  if (!versionHookText.includes('versioning pre-commit')) throw new Error('selftest failed: versioning hook command missing');
  if (versionHookText.indexOf('versioning pre-commit') > versionHookText.indexOf('exit 0')) throw new Error('selftest failed: versioning hook was appended after an early exit');
  await writeTextAtomic(path.join(versionTmp, 'README.md'), 'version selftest\n');
  await runProcess('git', ['add', 'README.md'], { cwd: versionTmp, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  const firstVersionBump = await runVersionPreCommit(versionTmp);
  if (!firstVersionBump.ok || firstVersionBump.version !== '0.1.1' || !firstVersionBump.changed) throw new Error('selftest failed: first version bump did not advance patch version');
  const bumpedPackage = await readJson(path.join(versionTmp, 'package.json'));
  const bumpedLock = await readJson(path.join(versionTmp, 'package-lock.json'));
  if (bumpedPackage.version !== '0.1.1' || bumpedLock.version !== '0.1.1' || bumpedLock.packages[''].version !== '0.1.1') throw new Error('selftest failed: package lock versions not synced');
  const firstCached = await runProcess('git', ['diff', '--cached', '--name-only'], { cwd: versionTmp, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  if (!firstCached.stdout.includes('package.json') || !firstCached.stdout.includes('package-lock.json')) throw new Error('selftest failed: version files not staged');
  await runProcess('git', ['commit', '--no-verify', '-m', 'first versioned commit'], { cwd: versionTmp, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  await writeJsonAtomic(versionStatus.state_path, { schema_version: 1, last_version: '0.1.5', updated_at: nowIso(), pid: process.pid, changed: true });
  await writeTextAtomic(path.join(versionTmp, 'CHANGELOG.md'), 'collision selftest\n');
  await runProcess('git', ['add', 'CHANGELOG.md'], { cwd: versionTmp, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  const collisionBump = await runVersionPreCommit(versionTmp);
  if (!collisionBump.ok || collisionBump.version !== '0.1.6') throw new Error('selftest failed: version collision state did not bump above last seen version');
  const localOnlyTmp = tmpdir();
  await ensureDir(path.join(localOnlyTmp, '.git'));
  await writeTextAtomic(path.join(localOnlyTmp, 'AGENTS.md'), 'existing local rules\n');
  await initProject(localOnlyTmp, { localOnly: true });
  const localExclude = await safeReadText(path.join(localOnlyTmp, '.git', 'info', 'exclude'));
  if (!localExclude.includes('.codex/') || !localExclude.includes('AGENTS.md')) throw new Error('selftest failed: local-only git excludes missing');
  const localAgents = await safeReadText(path.join(localOnlyTmp, 'AGENTS.md'));
  if (localAgents.trim() !== 'existing local rules') throw new Error('selftest failed: local-only modified existing AGENTS.md');
  const localManifest = await readJson(path.join(localOnlyTmp, '.sneakoscope', 'manifest.json'));
  if (!localManifest.git?.local_only) throw new Error('selftest failed: local-only manifest missing');
  const managedAgentsTmp = tmpdir();
  await ensureDir(path.join(managedAgentsTmp, '.git'));
  await writeTextAtomic(path.join(managedAgentsTmp, 'AGENTS.md'), '<!-- BEGIN Sneakoscope Codex GX MANAGED BLOCK -->\nold managed rules\n<!-- END Sneakoscope Codex GX MANAGED BLOCK -->\n');
  await initProject(managedAgentsTmp, { localOnly: true });
  const managedAgents = await safeReadText(path.join(managedAgentsTmp, 'AGENTS.md'));
  if (!managedAgents.includes('TriWiki is the context-tracking SSOT') || managedAgents.includes('old managed rules')) throw new Error('selftest failed: local-only did not refresh managed AGENTS.md block');
  if (!isTransientNpmBinPath('/tmp/.npm/_npx/abc/node_modules/.bin/sks')) throw new Error('selftest failed: npx bin path not recognized as transient');
  if (!isTransientNpmBinPath('/tmp/.npm-cache/_cacache/tmp/git-cloneabc/bin/sks.mjs')) throw new Error('selftest failed: npm cache git clone path not recognized as transient');
  if (isTransientNpmBinPath('/usr/local/bin/sks')) throw new Error('selftest failed: stable global bin marked transient');
  const oldPath = process.env.PATH;
  const oldSksBin = process.env.SKS_BIN;
  const fakeNpxBin = path.join(tmp, '.npm', '_npx', 'abc', 'node_modules', '.bin');
  await ensureDir(fakeNpxBin);
  await writeJsonAtomic(path.join(fakeNpxBin, 'sks'), { fake: true });
  try {
    process.env.PATH = fakeNpxBin;
    delete process.env.SKS_BIN;
    const discovered = await discoverGlobalSksCommand();
    if (isTransientNpmBinPath(discovered)) throw new Error('selftest failed: transient npx bin selected as global command');
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldSksBin === undefined) delete process.env.SKS_BIN;
    else process.env.SKS_BIN = oldSksBin;
  }
  const shimTmp = tmpdir();
  const shimDir = path.join(shimTmp, 'bin');
  const shimResult = await ensureSksCommandDuringInstall({ force: true, pathEnv: shimDir, home: shimTmp, target: path.join(packageRoot(), 'bin', 'sks.mjs'), nodeBin: process.execPath });
  if (shimResult.status !== 'created' || !(await exists(path.join(shimDir, process.platform === 'win32' ? 'sks.cmd' : 'sks')))) throw new Error('selftest failed: sks command shim not created');
  const codexSkillMirrorExists = await exists(path.join(tmp, '.codex', 'skills', 'research-discovery', 'SKILL.md'));
  if (codexSkillMirrorExists) throw new Error('selftest failed: generated .codex/skills mirror still installed');
  const codexAppSkillExists = await exists(path.join(tmp, '.agents', 'skills', 'research-discovery', 'SKILL.md'));
  if (!codexAppSkillExists) throw new Error('selftest failed: Codex App skill not installed');
  for (const { command } of DOLLAR_COMMANDS) {
    const skillName = command.slice(1).toLowerCase();
    const dollarSkillExists = await exists(path.join(tmp, '.agents', 'skills', skillName, 'SKILL.md'));
    if (!dollarSkillExists) throw new Error(`selftest failed: ${command} skill not installed`);
  }
  const promptPipelineSkillExists = await exists(path.join(tmp, '.agents', 'skills', 'prompt-pipeline', 'SKILL.md'));
  if (!promptPipelineSkillExists) throw new Error('selftest failed: prompt pipeline skill not installed');
  const promptPipelineText = await safeReadText(path.join(tmp, '.agents', 'skills', 'prompt-pipeline', 'SKILL.md'));
  if (!promptPipelineText.includes('TriWiki context-tracking SSOT')) throw new Error('selftest failed: prompt pipeline missing TriWiki context-tracking SSOT');
  if (!promptPipelineText.includes('before every route stage') || !promptPipelineText.includes('sks wiki refresh')) throw new Error('selftest failed: prompt pipeline missing per-stage TriWiki policy');
  for (const supportSkill of ['reasoning-router', 'pipeline-runner', 'context7-docs', 'seo-geo-optimizer']) {
    if (!(await exists(path.join(tmp, '.agents', 'skills', supportSkill, 'SKILL.md')))) throw new Error(`selftest failed: ${supportSkill} skill not installed`);
  }
  if (!(await exists(path.join(tmp, '.agents', 'skills', 'reasoning-router', 'agents', 'openai.yaml')))) throw new Error('selftest failed: skill metadata missing');
  const hookGuardPayload = JSON.stringify({ cwd: tmp, tool_name: 'apply_patch', command: '*** Update File: .agents/skills/team/SKILL.md\n+tamper\n' });
  const hookGuardResult = await runProcess(process.execPath, [path.join(packageRoot(), 'bin', 'sks.mjs'), 'hook', 'pre-tool'], { cwd: tmp, input: hookGuardPayload, env: { SKS_DISABLE_UPDATE_CHECK: '1' }, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  const hookGuardJson = JSON.parse(hookGuardResult.stdout);
  if (hookGuardJson.decision !== 'block' || !String(hookGuardJson.reason || '').includes('harness guard')) throw new Error('selftest failed: hook did not block harness tampering');
  const camelHookGuardPayload = JSON.stringify({ cwd: tmp, toolName: 'apply_patch', toolInput: { command: '*** Update File: .agents/skills/team/SKILL.md\n+tamper\n' } });
  const camelHookGuardResult = await runProcess(process.execPath, [path.join(packageRoot(), 'bin', 'sks.mjs'), 'hook', 'pre-tool'], { cwd: tmp, input: camelHookGuardPayload, env: { SKS_DISABLE_UPDATE_CHECK: '1' }, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  const camelHookGuardJson = JSON.parse(camelHookGuardResult.stdout);
  if (camelHookGuardJson.decision !== 'block') throw new Error('selftest failed: hook did not block camelCase Codex tool payload');
  if (new Set(DOLLAR_COMMANDS.map((c) => c.command)).size !== DOLLAR_COMMANDS.length) throw new Error('selftest failed: duplicate dollar commands');
  if (!DOLLAR_COMMAND_ALIASES.some((alias) => alias.canonical === '$QA-LOOP' && alias.app_skill === '$qa-loop')) throw new Error('selftest failed: $QA-LOOP picker skill missing');
  if (DOLLAR_COMMAND_ALIASES.some((alias) => ['$agent-team', '$qaloop', '$wiki-refresh', '$wikirefresh'].includes(alias.app_skill))) throw new Error('selftest failed: duplicate picker aliases still present');
  if (routePrompt('$agent-team run specialists')) throw new Error('selftest failed: deprecated $agent-team route still resolved');
  if (routePrompt('$QA-LOOP run UI E2E')?.id !== 'QALoop' || routePrompt('$QALoop deployed smoke')) throw new Error('selftest failed: QA-LOOP route is not standardized to $QA-LOOP');
  if (routePrompt('$WikiRefresh 갱신')) throw new Error('selftest failed: deprecated $WikiRefresh route still resolved');
  if (routePrompt('위키 갱신해줘')?.id !== 'Wiki') throw new Error('selftest failed: wiki refresh text did not route to Wiki');
  if (!COMMAND_CATALOG.some((c) => c.name === 'context7') || !COMMAND_CATALOG.some((c) => c.name === 'pipeline') || !COMMAND_CATALOG.some((c) => c.name === 'qa-loop')) throw new Error('selftest failed: context7/pipeline/qa-loop commands missing from catalog');
  const registryDollarCommands = DOLLAR_COMMANDS.map((c) => c.command);
  const manifest = await readJson(path.join(tmp, '.sneakoscope', 'manifest.json'));
  const policy = await readJson(path.join(tmp, '.sneakoscope', 'policy.json'));
  const manifestDollarCommands = manifest.prompt_pipeline?.dollar_commands || [];
  const policyDollarCommands = policy.prompt_pipeline?.dollar_commands || [];
  if (JSON.stringify(manifestDollarCommands) !== JSON.stringify(registryDollarCommands)) throw new Error('selftest failed: manifest dollar command drift');
  if (JSON.stringify(policyDollarCommands) !== JSON.stringify(registryDollarCommands)) throw new Error('selftest failed: policy dollar command drift');
  if (!manifest.harness_guard?.immutable_to_llm_edits || !policy.harness_guard?.immutable_to_llm_edits) throw new Error('selftest failed: harness guard missing from manifest/policy');
  if (manifest.llm_wiki?.ssot !== 'triwiki' || policy.llm_wiki?.ssot !== 'triwiki') throw new Error('selftest failed: TriWiki context tracking not recorded in manifest/policy');
  const codexAppQuickRefExists = await exists(path.join(tmp, '.codex', 'SNEAKOSCOPE.md'));
  if (!codexAppQuickRefExists) throw new Error('selftest failed: Codex App quick reference missing');
  const codexAppQuickRefText = await safeReadText(path.join(tmp, '.codex', 'SNEAKOSCOPE.md'));
  if (!codexAppQuickRefText.includes('dollar-commands')) throw new Error('selftest failed: Codex App quick reference missing dollar-command discovery');
  if (!codexAppQuickRefText.includes('Context Tracking') || !codexAppQuickRefText.includes('TriWiki')) throw new Error('selftest failed: Codex App quick reference missing TriWiki context tracking');
  if (!codexAppQuickRefText.includes('Before each route phase') || !codexAppQuickRefText.includes('every stage')) throw new Error('selftest failed: Codex App quick reference missing per-stage TriWiki policy');
  for (const { command } of DOLLAR_COMMANDS) {
    if (!codexAppQuickRefText.includes(command)) throw new Error(`selftest failed: Codex App quick reference missing ${command}`);
  }
  const hookRalphTmp = tmpdir();
  await initProject(hookRalphTmp, {});
  const hookBin = path.join(packageRoot(), 'bin', 'sks.mjs');
  const hookPayload = JSON.stringify({ cwd: hookRalphTmp, prompt: '$Ralph 로그인 세션 만료 UX 개선 supabase db' });
  const hookResult = await runProcess(process.execPath, [hookBin, 'hook', 'user-prompt-submit'], { cwd: hookRalphTmp, input: hookPayload, env: { SKS_DISABLE_UPDATE_CHECK: '1' }, timeoutMs: 15000, maxOutputBytes: 256 * 1024 });
  if (hookResult.code !== 0) throw new Error(`selftest failed: $Ralph hook exited ${hookResult.code}: ${hookResult.stderr}`);
  const hookJson = JSON.parse(hookResult.stdout);
  if ('statusMessage' in hookJson || 'additionalContext' in hookJson) throw new Error('selftest failed: hook emitted Codex schema-invalid top-level fields');
  if (!hookJson.hookSpecificOutput?.additionalContext?.includes('MANDATORY $Ralph route activated')) throw new Error('selftest failed: $Ralph hook did not activate Ralph prepare pipeline');
  if (hookJson.hookSpecificOutput?.hookEventName !== 'UserPromptSubmit' || !hookJson.hookSpecificOutput?.additionalContext?.includes('MANDATORY $Ralph route activated')) throw new Error('selftest failed: $Ralph hook did not emit official UserPromptSubmit additionalContext');
  if (!String(hookJson.systemMessage || '').includes('Ralph clarification gate')) throw new Error('selftest failed: $Ralph hook missing visible status message');
  if (!hookJson.hookSpecificOutput?.additionalContext?.includes('GOAL_PRECISE')) throw new Error('selftest failed: $Ralph hook did not provide clarification questions');
  const hookState = await readJson(stateFile(hookRalphTmp), {});
  if (hookState.phase !== 'RALPH_AWAITING_ANSWERS') throw new Error('selftest failed: $Ralph hook did not set awaiting-answers state');
  if (!(await exists(path.join(missionDir(hookRalphTmp, hookState.mission_id), 'questions.md')))) throw new Error('selftest failed: $Ralph hook did not write questions.md');
  const stopResult = await runProcess(process.execPath, [hookBin, 'hook', 'stop'], { cwd: hookRalphTmp, input: JSON.stringify({ cwd: hookRalphTmp, last_assistant_message: 'I will implement now.' }), env: { SKS_DISABLE_UPDATE_CHECK: '1' }, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  if (stopResult.code !== 0) throw new Error(`selftest failed: stop hook exited ${stopResult.code}: ${stopResult.stderr}`);
  const stopJson = JSON.parse(stopResult.stdout);
  if (stopJson.decision !== 'block' || !String(stopJson.reason || '').includes('mandatory clarification')) throw new Error('selftest failed: Stop hook did not block missing Ralph questions');
  if (!String(stopJson.reason || '').includes('Required questions') || !String(stopJson.reason || '').includes('GOAL_PRECISE')) throw new Error('selftest failed: Stop hook did not reprint Ralph questions');
  if (!String(stopJson.reason || '').includes('sks ralph answer')) throw new Error('selftest failed: Stop hook did not provide Ralph answer command');
  if (!String(stopJson.systemMessage || '').includes('clarification questions')) throw new Error('selftest failed: Stop hook missing clarification status message');
  const hookTeamTmp = tmpdir();
  await initProject(hookTeamTmp, {});
  const hookTeamPayload = JSON.stringify({ cwd: hookTeamTmp, prompt: '$Team 버튼 UX 수정 executor:2 reviewer:1 user:1' });
  const hookTeamResult = await runProcess(process.execPath, [hookBin, 'hook', 'user-prompt-submit'], { cwd: hookTeamTmp, input: hookTeamPayload, env: { SKS_DISABLE_UPDATE_CHECK: '1' }, timeoutMs: 15000, maxOutputBytes: 256 * 1024 });
  if (hookTeamResult.code !== 0) throw new Error(`selftest failed: $Team hook exited ${hookTeamResult.code}: ${hookTeamResult.stderr}`);
  const hookTeamJson = JSON.parse(hookTeamResult.stdout);
  if (!hookTeamJson.hookSpecificOutput?.additionalContext?.includes('MANDATORY ambiguity-removal gate activated')) throw new Error('selftest failed: $Team hook did not force ambiguity gate before Team execution');
  if (!hookTeamJson.hookSpecificOutput?.additionalContext?.includes('GOAL_PRECISE')) throw new Error('selftest failed: $Team ambiguity gate did not provide questions');
  if (!hookTeamJson.hookSpecificOutput?.additionalContext?.includes('Codex plan-tool interaction')) throw new Error('selftest failed: $Team ambiguity gate did not inject plan-tool guidance');
  const hookTeamState = await readJson(stateFile(hookTeamTmp), {});
  if (hookTeamState.phase !== 'TEAM_CLARIFICATION_AWAITING_ANSWERS' || hookTeamState.implementation_allowed !== false) throw new Error('selftest failed: $Team hook did not lock execution behind ambiguity gate');
  if (await exists(path.join(missionDir(hookTeamTmp, hookTeamState.mission_id), 'team-plan.json'))) throw new Error('selftest failed: Team plan was created before ambiguity gate passed');
  const hookTeamStopResult = await runProcess(process.execPath, [hookBin, 'hook', 'stop'], { cwd: hookTeamTmp, input: JSON.stringify({ cwd: hookTeamTmp, last_assistant_message: 'I will execute Team now.' }), env: { SKS_DISABLE_UPDATE_CHECK: '1' }, timeoutMs: 15000, maxOutputBytes: 128 * 1024 });
  if (hookTeamStopResult.code !== 0) throw new Error(`selftest failed: Team stop hook exited ${hookTeamStopResult.code}: ${hookTeamStopResult.stderr}`);
  const hookTeamStopJson = JSON.parse(hookTeamStopResult.stdout);
  if (hookTeamStopJson.decision !== 'block' || !String(hookTeamStopJson.reason || '').includes('mandatory ambiguity-removal')) throw new Error('selftest failed: Stop hook did not block missing Team ambiguity answers');
  if (!String(hookTeamStopJson.reason || '').includes('Required questions') || !String(hookTeamStopJson.reason || '').includes('GOAL_PRECISE')) throw new Error('selftest failed: Stop hook did not reprint Team ambiguity questions');
  if (!String(hookTeamStopJson.reason || '').includes('sks pipeline answer')) throw new Error('selftest failed: Stop hook did not provide pipeline answer command');
  if (!String(hookTeamStopJson.reason || '').includes('Codex plan-tool interaction')) throw new Error('selftest failed: Stop hook did not reprint plan-tool guidance');
  const hookTeamSchema = await readJson(path.join(missionDir(hookTeamTmp, hookTeamState.mission_id), 'required-answers.schema.json'));
  if (!hookTeamSchema.slots.find((s) => s.id === 'NON_GOALS')?.allow_empty) throw new Error('selftest failed: NON_GOALS does not allow an empty array answer');
  const hookTeamAnswers = {};
  for (const s of hookTeamSchema.slots) hookTeamAnswers[s.id] = s.options ? (s.type === 'array' ? [s.options[0]] : s.options[0]) : (s.type.includes('array') ? ['selftest'] : (s.id === 'DB_MAX_BLAST_RADIUS' ? 'no_live_dml' : 'selftest'));
  hookTeamAnswers.NON_GOALS = [];
  const hookTeamAnswersPath = path.join(hookTeamTmp, 'team-answers.json');
  await writeJsonAtomic(hookTeamAnswersPath, hookTeamAnswers);
  const pipelineAnswerResult = await runProcess(process.execPath, [hookBin, 'pipeline', 'answer', 'latest', hookTeamAnswersPath], { cwd: hookTeamTmp, env: { SKS_DISABLE_UPDATE_CHECK: '1' }, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  if (pipelineAnswerResult.code !== 0) throw new Error(`selftest failed: pipeline answer exited ${pipelineAnswerResult.code}: ${pipelineAnswerResult.stderr}`);
  const answeredTeamState = await readJson(stateFile(hookTeamTmp), {});
  if (answeredTeamState.phase !== 'TEAM_CLARIFICATION_CONTRACT_SEALED' || !answeredTeamState.ambiguity_gate_passed || answeredTeamState.implementation_allowed !== true) throw new Error('selftest failed: pipeline answer did not pass Team ambiguity gate');
  if (!(await exists(path.join(missionDir(hookTeamTmp, hookTeamState.mission_id), 'decision-contract.json')))) throw new Error('selftest failed: pipeline answer did not seal decision contract');
  const hookQaTmp = tmpdir();
  await initProject(hookQaTmp, {});
  const hookQaPayload = JSON.stringify({ cwd: hookQaTmp, prompt: '$QA-LOOP run UI and API E2E against local dev' });
  const hookQaResult = await runProcess(process.execPath, [hookBin, 'hook', 'user-prompt-submit'], { cwd: hookQaTmp, input: hookQaPayload, env: { SKS_DISABLE_UPDATE_CHECK: '1' }, timeoutMs: 15000, maxOutputBytes: 256 * 1024 });
  if (hookQaResult.code !== 0) throw new Error(`selftest failed: $QA-LOOP hook exited ${hookQaResult.code}: ${hookQaResult.stderr}`);
  const hookQaJson = JSON.parse(hookQaResult.stdout);
  const hookQaContext = hookQaJson.hookSpecificOutput?.additionalContext || '';
  if (!hookQaContext.includes('MANDATORY ambiguity-removal gate activated') || !hookQaContext.includes('QA_SCOPE') || !hookQaContext.includes('UI_COMPUTER_USE_ACK')) throw new Error('selftest failed: $QA-LOOP hook did not provide QA-specific questions');
  const hookQaState = await readJson(stateFile(hookQaTmp), {});
  if (hookQaState.phase !== 'QALOOP_CLARIFICATION_AWAITING_ANSWERS' || hookQaState.implementation_allowed !== false) throw new Error('selftest failed: $QA-LOOP hook did not lock execution behind ambiguity gate');
  const hookQaSchema = await readJson(path.join(missionDir(hookQaTmp, hookQaState.mission_id), 'required-answers.schema.json'));
  const hookQaAnswers = {};
  for (const s of hookQaSchema.slots) hookQaAnswers[s.id] = s.options ? (s.type === 'array' ? [s.options[0]] : s.options[0]) : (s.type.includes('array') ? ['selftest'] : 'selftest');
  const hookQaAnswersPath = path.join(hookQaTmp, 'qa-answers.json');
  await writeJsonAtomic(hookQaAnswersPath, hookQaAnswers);
  const qaAnswerResult = await runProcess(process.execPath, [hookBin, 'pipeline', 'answer', 'latest', hookQaAnswersPath], { cwd: hookQaTmp, env: { SKS_DISABLE_UPDATE_CHECK: '1' }, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  if (qaAnswerResult.code !== 0) throw new Error(`selftest failed: QA pipeline answer exited ${qaAnswerResult.code}: ${qaAnswerResult.stderr}`);
  const qaMissionDir = missionDir(hookQaTmp, hookQaState.mission_id);
  if (!(await exists(path.join(qaMissionDir, 'qa-report.md'))) || !(await exists(path.join(qaMissionDir, 'qa-ledger.json'))) || !(await exists(path.join(qaMissionDir, 'qa-gate.json')))) throw new Error('selftest failed: QA artifacts missing after answer');
  const qaRunResult = await runProcess(process.execPath, [hookBin, 'qa-loop', 'run', 'latest', '--mock'], { cwd: hookQaTmp, env: { SKS_DISABLE_UPDATE_CHECK: '1' }, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  if (qaRunResult.code !== 0) throw new Error(`selftest failed: qa-loop mock run exited ${qaRunResult.code}: ${qaRunResult.stderr}`);
  const qaGate = await readJson(path.join(qaMissionDir, 'qa-gate.evaluated.json'));
  if (!qaGate.passed) throw new Error('selftest failed: qa-loop mock gate did not pass');
  const hookDfixTmp = tmpdir();
  await initProject(hookDfixTmp, {});
  const hookDfixPayload = JSON.stringify({ cwd: hookDfixTmp, prompt: '$DFix 버튼 라벨 바꿔줘' });
  const hookDfixResult = await runProcess(process.execPath, [hookBin, 'hook', 'user-prompt-submit'], { cwd: hookDfixTmp, input: hookDfixPayload, env: { SKS_DISABLE_UPDATE_CHECK: '1' }, timeoutMs: 15000, maxOutputBytes: 128 * 1024 });
  if (hookDfixResult.code !== 0) throw new Error(`selftest failed: $DFix hook exited ${hookDfixResult.code}: ${hookDfixResult.stderr}`);
  const hookDfixJson = JSON.parse(hookDfixResult.stdout);
  if (hookDfixJson.hookSpecificOutput?.additionalContext?.includes('MANDATORY ambiguity-removal gate activated')) throw new Error('selftest failed: $DFix incorrectly triggered ambiguity gate');
  if (hookDfixJson.hookSpecificOutput?.additionalContext?.includes('SKS skill-first pipeline active')) throw new Error('selftest failed: $DFix entered the general SKS prompt pipeline');
  if (hookDfixJson.hookSpecificOutput?.additionalContext?.includes('Mission:')) throw new Error('selftest failed: $DFix created route mission state');
  if (!hookDfixJson.hookSpecificOutput?.additionalContext?.includes('DFix ultralight pipeline active')) throw new Error('selftest failed: $DFix hook missing ultralight pipeline guidance');
  if (!hookDfixJson.hookSpecificOutput?.additionalContext?.includes('Task list:')) throw new Error('selftest failed: $DFix hook missing micro task list');
  if (!hookDfixJson.systemMessage?.includes('DFix ultralight')) throw new Error('selftest failed: $DFix hook missing ultralight system message');
  const hookDfixState = await readJson(stateFile(hookDfixTmp), {});
  if (String(hookDfixState.phase || '').includes('CLARIFICATION_AWAITING_ANSWERS')) throw new Error('selftest failed: $DFix state entered clarification gate');
  const inferredDfixPayload = JSON.stringify({ cwd: hookTeamTmp, prompt: '버튼 라벨 바꿔줘' });
  const inferredDfixResult = await runProcess(process.execPath, [hookBin, 'hook', 'user-prompt-submit'], { cwd: hookTeamTmp, input: inferredDfixPayload, env: { SKS_DISABLE_UPDATE_CHECK: '1' }, timeoutMs: 15000, maxOutputBytes: 128 * 1024 });
  if (inferredDfixResult.code !== 0) throw new Error(`selftest failed: inferred DFix hook exited ${inferredDfixResult.code}: ${inferredDfixResult.stderr}`);
  const inferredDfixJson = JSON.parse(inferredDfixResult.stdout);
  const inferredDfixContext = inferredDfixJson.hookSpecificOutput?.additionalContext || '';
  if (!inferredDfixContext.includes('DFix ultralight pipeline active')) throw new Error('selftest failed: inferred DFix did not use ultralight route');
  if (inferredDfixContext.includes('SKS skill-first pipeline active') || inferredDfixContext.includes('Active Team mission') || inferredDfixContext.includes('Mission:')) throw new Error('selftest failed: inferred DFix leaked general pipeline or active Team context');
  const answerPayload = JSON.stringify({ cwd: hookTeamTmp, prompt: '이 파이프라인은 왜 이렇게 동작해?' });
  const answerResult = await runProcess(process.execPath, [hookBin, 'hook', 'user-prompt-submit'], { cwd: hookTeamTmp, input: answerPayload, env: { SKS_DISABLE_UPDATE_CHECK: '1' }, timeoutMs: 15000, maxOutputBytes: 128 * 1024 });
  if (answerResult.code !== 0) throw new Error(`selftest failed: answer-only hook exited ${answerResult.code}: ${answerResult.stderr}`);
  const answerJson = JSON.parse(answerResult.stdout);
  const answerContext = answerJson.hookSpecificOutput?.additionalContext || '';
  if (!answerContext.includes('SKS answer-only pipeline active')) throw new Error('selftest failed: question prompt did not use Answer route');
  if (answerContext.includes('MANDATORY ambiguity-removal gate activated') || answerContext.includes('SKS skill-first pipeline active') || answerContext.includes('Active Team mission') || answerContext.includes('Mission:')) throw new Error('selftest failed: Answer route leaked execution pipeline or active Team context');
  if (!answerJson.systemMessage?.includes('answer-only')) throw new Error('selftest failed: Answer route missing system message');
  const wikiPayload = JSON.stringify({ cwd: hookTeamTmp, prompt: '$Wiki 갱신' });
  const wikiResult = await runProcess(process.execPath, [hookBin, 'hook', 'user-prompt-submit'], { cwd: hookTeamTmp, input: wikiPayload, env: { SKS_DISABLE_UPDATE_CHECK: '1' }, timeoutMs: 15000, maxOutputBytes: 128 * 1024 });
  if (wikiResult.code !== 0) throw new Error(`selftest failed: Wiki hook exited ${wikiResult.code}: ${wikiResult.stderr}`);
  const wikiJson = JSON.parse(wikiResult.stdout);
  const wikiContext = wikiJson.hookSpecificOutput?.additionalContext || '';
  if (!wikiContext.includes('SKS wiki pipeline active') || !wikiContext.includes('sks wiki refresh')) throw new Error('selftest failed: $Wiki hook did not inject wiki route');
  if (wikiContext.includes('MANDATORY ambiguity-removal gate activated') || wikiContext.includes('Mission:')) throw new Error('selftest failed: Wiki route created ambiguity mission state');
  if (!wikiJson.systemMessage?.includes('wiki refresh')) throw new Error('selftest failed: Wiki route missing system message');
  const codexConfigText = await safeReadText(path.join(tmp, '.codex', 'config.toml'));
  if (!codexConfigText.includes('multi_agent = true')) throw new Error('selftest failed: multi_agent not enabled');
  if (!hasContext7ConfigText(codexConfigText)) throw new Error('selftest failed: Context7 MCP not configured');
  if (!codexConfigText.includes('[profiles.sks-task-medium]') || !codexConfigText.includes('[profiles.sks-logic-high]') || !codexConfigText.includes('[profiles.sks-research-xhigh]')) throw new Error('selftest failed: reasoning profiles not configured');
  if (!codexConfigText.includes('[agents.analysis_scout]')) throw new Error('selftest failed: analysis_scout agent not configured');
  if (!codexConfigText.includes('[agents.team_consensus]')) throw new Error('selftest failed: team_consensus agent not configured');
  const autoReviewHome = path.join(tmp, 'auto-review-home');
  const autoReviewEnv = { HOME: autoReviewHome };
  const autoReviewEnabled = await enableAutoReview({ env: autoReviewEnv, high: true });
  if (!autoReviewEnabled.enabled || autoReviewEnabled.profile_name !== 'sks-auto-review-high' || !autoReviewEnabled.high_profile) throw new Error('selftest failed: auto-review high profile was not enabled');
  const autoReviewConfig = await safeReadText(path.join(autoReviewHome, '.codex', 'config.toml'));
  if (!autoReviewConfig.includes('approvals_reviewer = "auto_review"') || !autoReviewConfig.includes('[profiles.sks-auto-review-high]')) throw new Error('selftest failed: auto-review config not written');
  const autoReviewDisabled = await disableAutoReview({ env: autoReviewEnv });
  if (autoReviewDisabled.enabled || autoReviewDisabled.approvals_reviewer !== 'user') throw new Error('selftest failed: auto-review disable did not restore user reviewer');
  const analysisAgentExists = await exists(path.join(tmp, '.codex', 'agents', 'analysis-scout.toml'));
  if (!analysisAgentExists) throw new Error('selftest failed: analysis scout agent not installed');
  const teamAgentExists = await exists(path.join(tmp, '.codex', 'agents', 'team-consensus.toml'));
  if (!teamAgentExists) throw new Error('selftest failed: team consensus agent not installed');
  const teamSkillExists = await exists(path.join(tmp, '.agents', 'skills', 'team', 'SKILL.md'));
  if (!teamSkillExists) throw new Error('selftest failed: $Team skill not installed');
  const honestSkillExists = await exists(path.join(tmp, '.agents', 'skills', 'honest-mode', 'SKILL.md'));
  if (!honestSkillExists) throw new Error('selftest failed: honest-mode skill not installed');
  const autoResearchSkillExists = await exists(path.join(tmp, '.agents', 'skills', 'autoresearch-loop', 'SKILL.md'));
  if (!autoResearchSkillExists) throw new Error('selftest failed: autoresearch-loop skill not installed');
  const requiredSkillsStatus = await checkRequiredSkills(tmp);
  if (!requiredSkillsStatus.ok) throw new Error(`selftest failed: required skills missing: ${requiredSkillsStatus.missing.join(', ')}`);
  const c7Status = await checkContext7(tmp);
  if (!c7Status.ok || !c7Status.project.ok) throw new Error('selftest failed: Context7 check failed for project config');
  if (hasContext7ConfigText('[mcp_servers.other]\ncommand = "npx"\n')) throw new Error('selftest failed: missing Context7 config passed structural check');
  const mockContext7Path = path.join(tmp, 'mock-context7.mjs');
  await writeTextAtomic(mockContext7Path, `process.stdin.setEncoding('utf8');\nlet buf='';\nfunction send(id,result){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');}\nprocess.stdin.on('data',(chunk)=>{buf+=chunk;for(;;){const i=buf.indexOf('\\n');if(i<0)break;const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line)continue;const msg=JSON.parse(line);if(!msg.id)continue;if(msg.method==='initialize')send(msg.id,{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'Mock Context7',version:'0.0.0'}});else if(msg.method==='tools/list')send(msg.id,{tools:[{name:'resolve-library-id'},{name:'query-docs'}]});else if(msg.method==='tools/call'&&msg.params.name==='resolve-library-id')send(msg.id,{content:[{type:'text',text:'Context7-compatible library ID: /mock/lib'}]});else if(msg.method==='tools/call'&&msg.params.name==='query-docs')send(msg.id,{content:[{type:'text',text:'mock docs for '+msg.params.arguments.libraryId}]});else send(msg.id,{content:[{type:'text',text:'unknown'}],isError:true});}});\n`);
  const mockContext7Docs = await context7Docs('Mock Lib', { command: process.execPath, args: [mockContext7Path], query: 'hooks', timeoutMs: 5000 });
  if (!mockContext7Docs.ok || mockContext7Docs.docs_tool !== 'query-docs' || mockContext7Docs.library_id !== '/mock/lib') throw new Error('selftest failed: local Context7 MCP client did not resolve/query docs');
  const passedTeamGate = { passed: true, analysis_artifact: true, triwiki_refreshed: true, triwiki_validated: true, consensus_artifact: true, implementation_team_fresh: true, review_artifact: true, integration_evidence: true };
  const incompleteTeamGateTmp = tmpdir();
  await initProject(incompleteTeamGateTmp, {});
  const { id: incompleteGateId, dir: incompleteGateDir } = await createMission(incompleteTeamGateTmp, { mode: 'team', prompt: 'incomplete team gate test' });
  await writeJsonAtomic(path.join(incompleteGateDir, 'team-gate.json'), { passed: true, analysis_artifact: true, triwiki_refreshed: true });
  await setCurrent(incompleteTeamGateTmp, { mission_id: incompleteGateId, mode: 'TEAM', route: 'Team', route_command: '$Team', phase: 'TEAM_REVIEW', context7_required: false, subagents_required: false, stop_gate: 'team-gate.json' });
  const incompleteGateState = await readJson(stateFile(incompleteTeamGateTmp), {});
  const incompleteGateStop = await evaluateStop(incompleteTeamGateTmp, incompleteGateState, { last_assistant_message: 'SKS Honest Mode verification evidence gap' }, { noQuestion: false });
  if (incompleteGateStop?.decision !== 'block' || !String(incompleteGateStop.reason || '').includes('triwiki_validated')) throw new Error('selftest failed: incomplete Team gate was not blocked');
  const routeGateTmp = tmpdir();
  await initProject(routeGateTmp, {});
  const { id: gateId, dir: gateDir } = await createMission(routeGateTmp, { mode: 'team', prompt: 'Context7 gate test' });
  await writeJsonAtomic(path.join(gateDir, 'team-gate.json'), passedTeamGate);
  await setCurrent(routeGateTmp, { mission_id: gateId, mode: 'TEAM', route: 'Team', route_command: '$Team', phase: 'TEAM_REVIEW', context7_required: true, stop_gate: 'team-gate.json' });
  const gateState = await readJson(stateFile(routeGateTmp), {});
  const missingC7Stop = await evaluateStop(routeGateTmp, gateState, { last_assistant_message: 'SKS Honest Mode verification evidence gap' }, { noQuestion: false });
  if (missingC7Stop?.decision !== 'block' || !String(missingC7Stop.reason || '').includes('Context7')) throw new Error('selftest failed: Stop hook did not block missing Context7 evidence');
  await recordContext7Evidence(routeGateTmp, gateState, { tool_name: 'resolve-library-id', library: 'react' });
  const resolveOnlyStop = await evaluateStop(routeGateTmp, gateState, { last_assistant_message: 'SKS Honest Mode verification evidence gap' }, { noQuestion: false });
  if (resolveOnlyStop?.decision !== 'block') throw new Error('selftest failed: resolve-only Context7 evidence unblocked route');
  await recordContext7Evidence(routeGateTmp, gateState, { tool_name: 'query-docs', library_id: '/facebook/react' });
  const c7Unblocked = await evaluateStop(routeGateTmp, gateState, { last_assistant_message: 'SKS Honest Mode verification evidence gap' }, { noQuestion: false });
  if (c7Unblocked?.decision === 'block') throw new Error('selftest failed: full Context7 evidence did not unblock route gate');
  const subagentGateTmp = tmpdir();
  await initProject(subagentGateTmp, {});
  const { id: subagentGateId, dir: subagentGateDir } = await createMission(subagentGateTmp, { mode: 'team', prompt: 'subagent evidence gate test' });
  await writeJsonAtomic(path.join(subagentGateDir, 'team-gate.json'), passedTeamGate);
  await setCurrent(subagentGateTmp, { mission_id: subagentGateId, mode: 'TEAM', route: 'Team', route_command: '$Team', phase: 'TEAM_REVIEW', context7_required: false, subagents_required: true, stop_gate: 'team-gate.json' });
  const subagentGateState = await readJson(stateFile(subagentGateTmp), {});
  const missingSubagentStop = await evaluateStop(subagentGateTmp, subagentGateState, { last_assistant_message: 'SKS Honest Mode verification evidence gap' }, { noQuestion: false });
  if (missingSubagentStop?.decision !== 'block' || !String(missingSubagentStop.reason || '').includes('subagent')) throw new Error('selftest failed: Stop hook did not block missing subagent evidence');
  await recordSubagentEvidence(subagentGateTmp, subagentGateState, { tool_name: 'spawn_agent', agent_type: 'worker' });
  const subagentUnblocked = await evaluateStop(subagentGateTmp, subagentGateState, { last_assistant_message: 'SKS Honest Mode verification evidence gap' }, { noQuestion: false });
  if (subagentUnblocked?.decision === 'block') throw new Error('selftest failed: subagent evidence did not unblock route gate');
  const { id: teamId, dir: teamDir } = await createMission(tmp, { mode: 'team', prompt: '병렬 구현 팀 테스트' });
  const teamPlan = buildTeamPlan(teamId, '병렬 구현 팀 테스트');
  await writeJsonAtomic(path.join(teamDir, 'team-plan.json'), teamPlan);
  if (teamPlan.agent_session_count !== 3) throw new Error('selftest failed: team default sessions not 3');
  if (teamPlan.role_counts.executor !== 3 || teamPlan.role_counts.user !== 1 || teamPlan.role_counts.reviewer !== 1) throw new Error('selftest failed: team default role counts invalid');
  if (teamPlan.phases[0]?.id !== 'parallel_analysis_scouting' || teamPlan.phases[1]?.id !== 'triwiki_refresh') throw new Error('selftest failed: team plan is not scout-first');
  if (teamPlan.roster.debate_team.length !== 3 || !teamPlan.roster.debate_team.some((agent) => agent.id === 'debate_user_1') || !teamPlan.roster.development_team.some((agent) => agent.id === 'executor_3')) throw new Error('selftest failed: team roster missing default agents');
  if (teamPlan.roster.analysis_team.length !== teamPlan.role_counts.executor || !teamPlan.roster.analysis_team.some((agent) => agent.id === 'analysis_scout_3')) throw new Error('selftest failed: team analysis scout roster missing default agents');
  if (!teamPlan.required_artifacts.includes('team-analysis.md')) throw new Error('selftest failed: team plan missing team-analysis artifact');
  if (teamPlan.context_tracking?.ssot !== 'triwiki' || !teamPlan.required_artifacts.includes('.sneakoscope/wiki/context-pack.json')) throw new Error('selftest failed: team plan missing TriWiki context tracking');
  if (!teamPlan.context_tracking?.stage_policy?.includes('before_each_route_stage_read_relevant_context_pack')) throw new Error('selftest failed: team plan missing per-stage TriWiki policy');
  if (!teamPlan.phases.some((phase) => String(phase.goal || '').includes('refreshes/validates TriWiki before implementation handoff'))) throw new Error('selftest failed: team plan missing mid-pipeline TriWiki refresh');
  const teamWorkflow = teamWorkflowMarkdown(teamPlan);
  if (!teamWorkflow.includes('SSOT: triwiki') || !teamWorkflow.includes('Analysis Scouts') || !teamWorkflow.includes('sks wiki validate')) throw new Error('selftest failed: team workflow missing scout-first TriWiki context tracking');
  if (!teamWorkflow.includes('before every stage') || !teamWorkflow.includes('after findings/artifact changes')) throw new Error('selftest failed: team workflow missing per-stage TriWiki policy');
  const customTeamPlan = buildTeamPlan(teamId, '병렬 구현 팀 테스트', { agentSessions: 5 });
  if (customTeamPlan.agent_session_count !== 5) throw new Error('selftest failed: custom team sessions not honored');
  if (parseTeamCreateArgs(['--agents', '4', '작업']).agentSessions !== 4) throw new Error('selftest failed: team --agents parsing');
  const maxAgentParsed = parseTeamCreateArgs(['--max-agents', '작업']);
  if (maxAgentParsed.agentSessions !== 6 || maxAgentParsed.roleCounts.executor !== 6) throw new Error('selftest failed: team --max-agents parsing');
  const maxTextParsed = parseTeamSpecText('가용가능한 최대 agents로 분석하고 구현');
  if (maxTextParsed.agentSessions !== 6 || maxTextParsed.roleCounts.executor !== 6) throw new Error('selftest failed: team max-agent text parsing');
  const roleParsed = parseTeamCreateArgs(['executor:5', 'reviewer:2', 'user:1', '작업']);
  if (roleParsed.roleCounts.executor !== 5 || roleParsed.roleCounts.reviewer !== 2 || roleParsed.agentSessions !== 5 || roleParsed.prompt !== '작업') throw new Error('selftest failed: team role-count parsing');
  const roleTeamPlan = buildTeamPlan(teamId, '역할 팀 테스트', { roleCounts: roleParsed.roleCounts });
  if (roleTeamPlan.roster.debate_team.length !== 5) throw new Error('selftest failed: executor role count not reflected in debate team size');
  if (roleTeamPlan.roster.analysis_team.length !== 5) throw new Error('selftest failed: executor role count not reflected in analysis scout team');
  if (roleTeamPlan.roster.development_team.filter((agent) => agent.role === 'executor').length !== 5) throw new Error('selftest failed: executor role count not reflected in development team');
  if (!roleTeamPlan.roster.debate_team.some((agent) => /inconvenience/.test(agent.persona))) throw new Error('selftest failed: user friction persona missing from debate team');
  if (routeReasoning(routePrompt('$Research frontier idea'), '$Research frontier idea').effort !== 'xhigh') throw new Error('selftest failed: research reasoning not xhigh');
  if (routeReasoning(routePrompt('$DB migration'), '$DB migration').effort !== 'high') throw new Error('selftest failed: logical reasoning not high');
  if (routeReasoning(routePrompt('$DFix button label'), '$DFix button label').effort !== 'medium') throw new Error('selftest failed: simple reasoning not medium');
  if (routePrompt('이 파이프라인은 왜 이렇게 동작해?')?.id !== 'Answer') throw new Error('selftest failed: question prompt did not route to Answer');
  if (routePrompt('React useEffect 최신 문서 기준으로 설명해줘')?.id !== 'Answer') throw new Error('selftest failed: docs question did not route to Answer');
  if (routePrompt('$DF button label')) throw new Error('selftest failed: deprecated $DF route still resolved');
  if (routeRequiresSubagents(routePrompt('이 파이프라인은 왜 이렇게 동작해?'), '이 파이프라인은 왜 이렇게 동작해?')) throw new Error('selftest failed: Answer route requires subagents');
  if (!routeRequiresSubagents(routePrompt('$Team implement feature'), '$Team implement feature')) throw new Error('selftest failed: Team route does not require subagents');
  if (!routeRequiresSubagents(routePrompt('$Ralph implement feature'), '$Ralph implement feature')) throw new Error('selftest failed: Ralph implementation route does not require subagents');
  if (routeRequiresSubagents(routePrompt('$Help commands'), '$Help commands')) throw new Error('selftest failed: Help route incorrectly requires subagents');
  if (!teamPlan.phases.some((phase) => phase.id === 'parallel_implementation')) throw new Error('selftest failed: team plan missing implementation phase');
  await initTeamLive(teamId, teamDir, '병렬 구현 팀 테스트', { roleCounts: roleParsed.roleCounts });
  await appendTeamEvent(teamDir, { agent: 'analysis_scout_1', phase: 'parallel_analysis_scouting', message: 'selftest mapped repo slice' });
  await appendTeamEvent(teamDir, { agent: 'team_consensus', phase: 'planning_debate', message: 'selftest mapped options' });
  const teamDashboard = await readTeamDashboard(teamDir);
  if (teamDashboard?.agent_session_count !== 5 || teamDashboard?.role_counts?.executor !== 5) throw new Error('selftest failed: team dashboard session/role budget missing');
  if (teamDashboard?.context_tracking?.ssot !== 'triwiki') throw new Error('selftest failed: team dashboard missing TriWiki context tracking');
  if (!teamDashboard?.phases?.includes('parallel_analysis_scouting')) throw new Error('selftest failed: team dashboard missing analysis scout phase');
  if (!teamDashboard?.latest_messages?.some((entry) => entry.agent === 'analysis_scout_1')) throw new Error('selftest failed: team live dashboard missing analysis scout event');
  if (!teamDashboard?.latest_messages?.some((entry) => entry.agent === 'team_consensus')) throw new Error('selftest failed: team live dashboard missing agent event');
  const teamLive = await readTeamLive(teamDir);
  if (!teamLive.includes('Analysis scouts') || !teamLive.includes('selftest mapped repo slice')) throw new Error('selftest failed: team live transcript missing analysis scout section/event');
  if (!teamLive.includes('selftest mapped options')) throw new Error('selftest failed: team live transcript missing event');
  if (!teamLive.includes('Context tracking SSOT: TriWiki')) throw new Error('selftest failed: team live transcript missing TriWiki context tracking');
  if (!(await readTeamTranscriptTail(teamDir, 1)).join('\n').includes('selftest mapped options')) throw new Error('selftest failed: team transcript tail missing event');
  await writeTextAtomic(path.join(teamDir, 'team-analysis.md'), '- claim: analysis scout mapped route registry | source: src/core/routes.mjs | risk: high | confidence: supported\n');
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
  if (!evalReport.candidate.wiki?.valid) throw new Error('selftest failed: wiki coordinate index invalid in eval');
  const coord = rgbaToWikiCoord({ r: 12, g: 34, b: 56, a: 255 });
  if (coord.schema !== 'sks.wiki-coordinate.v1' || coord.xyzw.length !== 4) throw new Error('selftest failed: RGBA wiki coordinate conversion');
  await writeTextAtomic(path.join(tmp, '.sneakoscope', 'memory', 'q2_facts', 'selftest.md'), '- claim: Selftest memory claim must be selected before lower-weight mission notes. | id: selftest-memory-priority | source: src/cli/main.mjs | risk: high | status: supported | evidence_count: 3 | required_weight: 1.0 | trust_score: 0.9\n');
  const wikiPack = contextCapsule({
    mission: { id: 'selftest-wiki', coord: { rgba: { r: 48, g: 132, b: 212, a: 240 } } },
    role: 'verifier',
    claims: await projectWikiClaims(tmp),
    q4: { mode: 'selftest' },
    q3: ['sks', 'llm-wiki', 'wiki-coordinate'],
    budget: { maxWikiAnchors: 48, includeTrustSummary: true }
  });
  const wikiValidation = validateWikiCoordinateIndex(wikiPack.wiki);
  if (!wikiValidation.ok) throw new Error('selftest failed: wiki coordinate pack invalid');
  if (!wikiPack.trust_summary || !Number.isFinite(Number(wikiPack.trust_summary.needs_evidence))) throw new Error('selftest failed: wiki trust summary missing');
  if (!(wikiPack.wiki.anchors || wikiPack.wiki.a || []).some((anchor) => Array.isArray(anchor) ? Number.isFinite(Number(anchor[9])) : Number.isFinite(Number(anchor.trust_score)))) throw new Error('selftest failed: wiki anchor trust score missing');
  if (!(wikiPack.wiki.anchors || wikiPack.wiki.a || []).some((anchor) => (Array.isArray(anchor) ? anchor[0] : anchor.id) === 'wiki-trig')) throw new Error('selftest failed: wiki trig anchor missing');
  if (!(wikiPack.wiki.anchors || wikiPack.wiki.a || []).some((anchor) => String(Array.isArray(anchor) ? anchor[0] : anchor.id).startsWith('team-analysis-'))) throw new Error('selftest failed: team analysis claim missing from TriWiki pack');
  if (wikiPack.claims?.[0]?.id !== 'selftest-memory-priority') throw new Error('selftest failed: memory required_weight did not take priority in TriWiki pack');
  const dryRunPack = await writeWikiContextPack(tmp, ['--max-anchors', '4'], { dryRun: true });
  if (await exists(dryRunPack.file)) throw new Error('selftest failed: wiki refresh dry-run wrote context pack');
  await ensureDir(path.dirname(dryRunPack.file));
  await writeJsonAtomic(path.join(path.dirname(dryRunPack.file), 'low-trust-artifact.json'), { trust_summary: { avg: 0.1 }, wiki: { anchors: [] } });
  const wikiPruneDryRun = await pruneWikiArtifacts(tmp, { dryRun: true });
  if (wikiPruneDryRun.candidates < 1 || !wikiPruneDryRun.actions.some((action) => action.reason === 'low_wiki_trust')) throw new Error('selftest failed: wiki prune did not flag low-trust artifact');
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
  if (!validateWikiCoordinateIndex(validation.wiki_coordinates).ok) throw new Error('selftest failed: gx wiki coordinate validation rejected');
  const drift = await driftCartridge(gxDir);
  if (drift.status !== 'low') throw new Error('selftest failed: gx drift is high');
  const snapshot = await snapshotCartridge(gxDir);
  if (!snapshot.files.svg || !snapshot.files.html) throw new Error('selftest failed: gx snapshot incomplete');
  if (!validateWikiCoordinateIndex(snapshot.wiki_coordinates).ok) throw new Error('selftest failed: gx snapshot wiki coordinates invalid');
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

async function wiki(sub, args = []) {
  if (!sub || sub === 'help' || sub === '--help') {
    console.log('Usage: sks wiki coords --rgba R,G,B,A | sks wiki pack [--json] [--role worker|verifier] [--max-anchors N] | sks wiki refresh [--json] [--role worker|verifier] [--max-anchors N] [--prune] [--dry-run] | sks wiki prune [--json] [--dry-run] | sks wiki validate [context-pack.json] [--json]');
    return;
  }
  if (sub === 'coords') {
    const raw = readFlagValue(args, '--rgba', positionalArgs(args)[0] || '');
    const parts = String(raw).split(/[,\s]+/).filter(Boolean).map((x) => Number.parseInt(x, 10));
    if (parts.length < 3) throw new Error('Usage: sks wiki coords --rgba R,G,B,A');
    const coord = rgbaToWikiCoord({ r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 255 });
    console.log(JSON.stringify({ rgba: coord.rgba, rgba_key: rgbaKey(coord.rgba), coord }, null, 2));
    return;
  }
  if (sub === 'pack') {
    const root = await projectRoot();
    const { pack, file } = await writeWikiContextPack(root, args);
    if (flag(args, '--json')) return console.log(JSON.stringify({ ...pack, path: file }, null, 2));
    printWikiPackSummary(root, file, pack);
    return;
  }
  if (sub === 'refresh') {
    const root = await projectRoot();
    const dryRun = flag(args, '--dry-run');
    const { pack, file } = await writeWikiContextPack(root, args, { dryRun });
    const validation = wikiValidationResult(pack);
    const exitCode = validation.result.ok ? 0 : 2;
    const pruneRequested = flag(args, '--prune');
    const pruneResult = pruneRequested
      ? await pruneWikiArtifacts(root, { dryRun })
      : null;
    if (flag(args, '--json')) {
      process.exitCode = exitCode;
      return console.log(JSON.stringify({
        path: file,
        dryRun,
        written: !dryRun,
        claims: pack.claims.length,
        anchors: wikiAnchorCount(pack.wiki),
        trust_summary: pack.trust_summary,
        validation,
        ...(pruneResult ? { prune: { dryRun: pruneResult.dryRun, scanned: pruneResult.scanned, candidates: pruneResult.candidates, actions: pruneResult.actions } } : {})
      }, null, 2));
    }
    console.log('Sneakoscope LLM Wiki Refresh');
    if (dryRun) console.log('Dry run: context pack was built and validated in memory; no wiki file was written.');
    printWikiPackSummary(root, file, pack);
    console.log(`Validation: ${validation.result.ok ? 'ok' : 'failed'} (${validation.result.checked} anchors, ${validation.trustAnchors} trust anchors)`);
    if (pruneResult) {
      console.log(`${pruneResult.dryRun ? 'Prune dry run' : 'Prune'}: ${pruneResult.candidates} wiki artifact(s), ${pruneResult.scanned} scanned`);
      for (const a of pruneResult.actions.slice(0, 20)) console.log(`- ${a.reason} ${path.relative(root, a.path)} ${a.bytes ? formatBytes(a.bytes) : ''}`.trim());
    } else {
      console.log('Prune: skipped (pass --prune to prune stale/low-trust wiki artifacts)');
    }
    process.exitCode = exitCode;
    return;
  }
  if (sub === 'prune') {
    const root = await projectRoot();
    const pruneResult = await pruneWikiArtifacts(root, { dryRun: flag(args, '--dry-run') });
    if (flag(args, '--json')) {
      return console.log(JSON.stringify({
        dryRun: pruneResult.dryRun,
        scanned: pruneResult.scanned,
        candidates: pruneResult.candidates,
        actions: pruneResult.actions
      }, null, 2));
    }
    console.log('Sneakoscope LLM Wiki Prune');
    console.log(`${pruneResult.dryRun ? 'Dry run' : 'Pruned'}: ${pruneResult.candidates} wiki artifact(s), ${pruneResult.scanned} scanned`);
    for (const a of pruneResult.actions.slice(0, 20)) console.log(`- ${a.reason} ${path.relative(root, a.path)} ${a.bytes ? formatBytes(a.bytes) : ''}`.trim());
    if (pruneResult.actions.length > 20) console.log(`... ${pruneResult.actions.length - 20} more action(s) omitted`);
    return;
  }
  if (sub === 'validate') {
    const root = await projectRoot();
    const target = positionalArgs(args)[0] || path.join(root, '.sneakoscope', 'wiki', 'context-pack.json');
    const pack = await readJson(path.resolve(target));
    const { result, trustAnchors } = wikiValidationResult(pack);
    if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Wiki coordinate index: ${result.ok ? 'ok' : 'failed'}`);
    console.log(`Anchors checked: ${result.checked}`);
    console.log(`Trust anchors: ${trustAnchors}/${result.checked}`);
    for (const issue of result.issues) console.log(`- ${issue.severity}: ${issue.id}${issue.anchor ? ` ${issue.anchor}` : ''}`);
    process.exitCode = result.ok ? 0 : 2;
    return;
  }
  console.error('Usage: sks wiki coords|pack|refresh|prune|validate');
  process.exitCode = 1;
}

async function writeWikiContextPack(root, args = [], opts = {}) {
  const role = readFlagValue(args, '--role', 'worker');
  const maxAnchors = Number(readFlagValue(args, '--max-anchors', role.includes('verifier') ? 48 : 32));
  const pack = contextCapsule({
    mission: { id: 'project-wiki', coord: { rgba: { r: 48, g: 132, b: 212, a: 240 } } },
    role,
    contractHash: null,
    claims: await projectWikiClaims(root),
    q4: { mode: 'project-continuity', package: PACKAGE_VERSION, hydrate: 'anchor-first' },
    q3: ['sks', 'llm-wiki', 'wiki-coordinate', 'gx', 'skills'],
    budget: { maxWikiAnchors: maxAnchors, includeTrustSummary: true }
  });
  const file = path.join(root, '.sneakoscope', 'wiki', 'context-pack.json');
  if (!opts.dryRun) {
    await ensureDir(path.dirname(file));
    await writeJsonAtomic(file, pack);
  }
  return { pack, file, role, maxAnchors };
}

function wikiAnchorCount(wiki = {}) {
  return (wiki.anchors || wiki.a || []).length;
}

function wikiValidationResult(pack = {}) {
  const wikiIndex = pack.wiki || pack;
  const result = validateWikiCoordinateIndex(wikiIndex);
  return { result, trustAnchors: countTrustAnchors(wikiIndex) };
}

function printWikiPackSummary(root, file, pack) {
  console.log('Sneakoscope LLM Wiki Context Pack');
  console.log(`Path:     ${path.relative(root, file)}`);
  console.log(`Claims:   ${pack.claims.length} hydrated text claims`);
  console.log(`Anchors:  ${wikiAnchorCount(pack.wiki)} coordinate anchors (${pack.wiki.overflow_count ?? pack.wiki.o ?? 0} overflow)`);
  console.log(`Schema:   ${pack.wiki.schema}`);
  console.log(`Trust:    avg=${pack.trust_summary.avg} needs_evidence=${pack.trust_summary.needs_evidence}`);
  console.log('Guidance: follow high-trust claims; hydrate source/evidence before relying on lower-trust claims.');
  console.log(`Validate: sks wiki validate ${path.relative(root, file)}`);
}

function countTrustAnchors(wiki = {}) {
  const rows = Array.isArray(wiki.a)
    ? wiki.a
    : (Array.isArray(wiki.anchors) ? wiki.anchors.map((anchor) => [anchor.id, null, null, null, null, null, null, null, null, anchor.trust_score, anchor.trust_band]) : []);
  return rows.filter((row) => row?.[9] != null && row?.[10]).length;
}

async function projectWikiClaims(root) {
  const claims = [
    ['wiki-hooks', '.codex/hooks.json routes UserPromptSubmit, tool, permission, and Stop events through SKS guards.', '.codex/hooks.json', 'code', 'high'],
    ['wiki-config', '.codex/config.toml enables Codex App profiles, multi-agent support, and Team agent limits.', '.codex/config.toml', 'code', 'high'],
    ['wiki-skills', '.agents/skills provides official repo-local routes for dfix, team, ralph, research, autoresearch, db, gx, wiki, and evaluation workflows.', '.agents/skills', 'code', 'medium'],
    ['wiki-agents', '.codex/agents defines Team analysis scout, planning, implementation, DB safety, and QA reviewer roles.', '.codex/agents', 'code', 'medium'],
    ['wiki-policy', '.sneakoscope/policy.json stores update-check, honest-mode, retention, database, performance, and prompt-pipeline policy.', '.sneakoscope/policy.json', 'contract', 'high'],
    ['wiki-memory', '.sneakoscope/memory stores Q0 raw, Q1 evidence, Q2 facts, Q3 tags, and Q4 control bits for hydratable context.', '.sneakoscope/memory', 'wiki', 'high'],
    ['wiki-gx', 'GX cartridges keep vgraph.json and beta.json as deterministic visual context sources with render, validation, drift, and snapshot outputs.', '.sneakoscope/gx/cartridges', 'vgraph', 'medium'],
    ['wiki-db', 'Database safety blocks destructive SQL, risky Supabase commands, unsafe MCP writes, and production data mutation.', '.sneakoscope/db-safety.json', 'code', 'critical'],
    ['wiki-hproof', 'H-Proof blocks completion when unsupported critical claims, DB safety issues, missing tests, or high visual/wiki drift remain.', '.sneakoscope/hproof', 'test', 'critical'],
    ['wiki-eval', 'sks eval run measures token savings, evidence-weighted accuracy proxy, required recall, unsupported critical filtering, and build runtime.', 'src/core/evaluation.mjs', 'test', 'medium'],
    ['wiki-trig', 'TriWiki maps RGBA channels to domain angle, layer radius, phase, and concentration using deterministic trigonometric coordinates.', 'src/core/wiki-coordinate.mjs', 'code', 'high']
  ];
  const out = [];
  for (const [id, text, file, authority, risk] of claims) {
    out.push({
      id,
      text,
      authority,
      risk,
      status: await exists(path.join(root, file)) ? 'supported' : 'unknown',
      freshness: 'fresh',
      source: file,
      file,
      evidence_count: await exists(path.join(root, file)) ? 1 : 0
    });
  }
  out.push(...(await memoryWikiClaims(root)));
  out.push(...(await teamAnalysisWikiClaims(root)));
  return out;
}

async function memoryWikiClaims(root) {
  const base = path.join(root, '.sneakoscope', 'memory');
  const files = await listMemoryClaimFiles(base);
  const claims = [];
  for (const file of files.slice(0, 80)) {
    const relFile = path.relative(root, file);
    let text = '';
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (!text.trim()) continue;
    const rows = parseMemoryClaimRows(text, relFile).slice(0, 24);
    let index = 0;
    for (const row of rows) {
      const source = row.source || relFile;
      const sourceExists = source && (await exists(path.join(root, source)));
      index += 1;
      claims.push({
        id: row.id || `memory-${slugifyClaimId(relFile)}-${index}`,
        text: row.text,
        authority: row.authority || 'wiki',
        risk: row.risk || 'high',
        status: row.status || (sourceExists || source === relFile ? 'supported' : 'unknown'),
        freshness: row.freshness || 'fresh',
        source,
        file: source,
        evidence_count: row.evidence_count ?? (sourceExists ? 2 : 1),
        required_weight: row.required_weight ?? 0.85,
        trust_score: row.trust_score
      });
    }
  }
  return claims;
}

async function listMemoryClaimFiles(base) {
  const out = [];
  async function walk(dir, depth = 0) {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p, depth + 1);
      else if (/\.(md|txt|json)$/i.test(entry.name)) out.push(p);
    }
  }
  await walk(base);
  return out;
}

function parseMemoryClaimRows(text, relFile) {
  if (/\.json$/i.test(relFile)) {
    try {
      const parsed = JSON.parse(text);
      const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.claims) ? parsed.claims : []);
      return rows.map((row) => normalizeMemoryClaimRow(row, relFile)).filter(Boolean);
    } catch {
      return [];
    }
  }
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => normalizeMemoryClaimRow(line.replace(/^[-*]\s*/, ''), relFile))
    .filter(Boolean);
}

function normalizeMemoryClaimRow(row, relFile) {
  if (!row) return null;
  if (typeof row === 'object') {
    const text = String(row.text || row.claim || '').trim();
    if (!text) return null;
    return {
      id: row.id ? String(row.id) : null,
      text: text.slice(0, 320),
      source: row.source || row.file || relFile,
      authority: row.authority,
      risk: row.risk,
      status: row.status || row.confidence,
      freshness: row.freshness,
      evidence_count: Number.isFinite(Number(row.evidence_count)) ? Number(row.evidence_count) : undefined,
      required_weight: Number.isFinite(Number(row.required_weight)) ? Number(row.required_weight) : undefined,
      trust_score: Number.isFinite(Number(row.trust_score)) ? Number(row.trust_score) : undefined
    };
  }
  const clean = String(row || '').trim();
  if (!/\bclaim\s*:/i.test(clean)) return null;
  const source = extractClaimField(clean, 'source') || extractClaimField(clean, 'file') || extractClaimField(clean, 'path') || relFile;
  const status = extractClaimField(clean, 'status') || extractClaimField(clean, 'confidence');
  return {
    id: extractClaimField(clean, 'id'),
    text: clean.slice(0, 320),
    source,
    authority: extractClaimField(clean, 'authority') || 'wiki',
    risk: extractClaimField(clean, 'risk') || 'high',
    status,
    freshness: extractClaimField(clean, 'freshness') || 'fresh',
    evidence_count: parseOptionalNumber(extractClaimField(clean, 'evidence_count')),
    required_weight: parseOptionalNumber(extractClaimField(clean, 'required_weight')),
    trust_score: parseOptionalNumber(extractClaimField(clean, 'trust_score'))
  };
}

function extractClaimField(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(new RegExp(`\\b${escaped}\\s*[:=]\\s*\\\`?([^\\\`|,;]+)`, 'i'));
  return match ? match[1].trim().replace(/[.;)]$/, '') : null;
}

function parseOptionalNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function slugifyClaimId(value) {
  return String(value || 'claim').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'claim';
}

async function teamAnalysisWikiClaims(root) {
  const base = path.join(root, '.sneakoscope', 'missions');
  let entries = [];
  try {
    entries = await fsp.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const claims = [];
  for (const entry of entries.filter((item) => item.isDirectory() && item.name.startsWith('M-')).map((item) => item.name).sort().reverse().slice(0, 10)) {
    const file = path.join(base, entry, 'team-analysis.md');
    let text = '';
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).slice(0, 24);
    let index = 0;
    for (const line of lines) {
      const clean = line.replace(/^[-*]\s*/, '').slice(0, 260);
      if (!clean) continue;
      const source = extractTeamAnalysisSource(clean) || path.relative(root, file);
      const risk = extractTeamAnalysisRisk(clean);
      const sourceExists = source && (await exists(path.join(root, source)));
      index += 1;
      claims.push({
        id: `team-analysis-${entry}-${index}`,
        text: clean,
        authority: 'wiki',
        risk,
        status: sourceExists || source === path.relative(root, file) ? 'supported' : 'unknown',
        freshness: 'fresh',
        source,
        file: source,
        evidence_count: 1,
        required_weight: 0.5
      });
    }
  }
  return claims;
}

function extractTeamAnalysisSource(text) {
  const match = String(text || '').match(/\b(?:source|file|path)\s*[:=]\s*`?([^`|,\s]+)/i);
  return match ? match[1].replace(/[.;)]$/, '') : null;
}

function extractTeamAnalysisRisk(text) {
  const match = String(text || '').match(/\b(critical|high|medium|low)\b/i);
  return match ? match[1].toLowerCase() : 'medium';
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
  if (report.candidate.wiki) console.log(`Wiki:      ${report.candidate.wiki.anchors} anchors, valid=${report.candidate.wiki.valid}`);
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
  const valueFlags = new Set(['--format', '--iterations', '--out', '--baseline', '--candidate', '--install-scope', '--max-cycles', '--depth', '--scope', '--transport', '--query', '--topic', '--tokens', '--timeout-ms', '--sql', '--command', '--project-ref', '--agent', '--phase', '--message', '--role', '--max-anchors']);
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
  const teamSubcommands = new Set(['log', 'tail', 'watch', 'status', 'event']);
  if (teamSubcommands.has(args[0])) return teamCommand(args[0], args.slice(1));
  const opts = parseTeamCreateArgs(args);
  const { prompt, agentSessions, roleCounts, roster } = opts;
  if (!prompt) {
    console.error('Usage: sks team "task" [executor:5 reviewer:2 user:1] [--agents N] [--json]');
    console.error('       sks team log|tail|watch|status [mission-id|latest]');
    console.error('       sks team event [mission-id|latest] --agent <name> --phase <phase> --message "..."');
    process.exitCode = 1;
    return;
  }
  const root = await projectRoot();
  const { id, dir } = await createMission(root, { mode: 'team', prompt });
  const schema = buildQuestionSchema(prompt);
  await writeQuestions(dir, schema);
  const plan = buildTeamPlan(id, prompt, { agentSessions, roleCounts, roster });
  await writeJsonAtomic(path.join(dir, 'team-plan.json'), plan);
  await writeTextAtomic(path.join(dir, 'team-workflow.md'), teamWorkflowMarkdown(plan));
  const liveFiles = await initTeamLive(id, dir, prompt, { agentSessions, roleCounts, roster });
  await writeJsonAtomic(path.join(dir, 'team-gate.json'), { passed: false, analysis_artifact: false, triwiki_refreshed: false, triwiki_validated: false, consensus_artifact: false, implementation_team_fresh: false, review_artifact: false, integration_evidence: false, context7_evidence: false });
  const result = {
    mission_id: id,
    mission_dir: dir,
    plan: path.join(dir, 'team-plan.json'),
    workflow: path.join(dir, 'team-workflow.md'),
    live: liveFiles.live,
    transcript: liveFiles.transcript,
    dashboard: liveFiles.dashboard,
    context_pack: path.join(root, '.sneakoscope', 'wiki', 'context-pack.json'),
    agent_sessions: agentSessions,
    bundle_size: roster.bundle_size,
    role_counts: roleCounts,
    questions: path.join(dir, 'questions.md'),
    codex_agents: ['analysis_scout', 'team_consensus', 'implementation_worker', 'db_safety_reviewer', 'qa_reviewer']
  };
  if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  console.log(`Team mission created: ${id}`);
  console.log(`Plan: ${path.relative(root, result.plan)}`);
  console.log(`Agent sessions: ${agentSessions}`);
  console.log(`Role counts: ${formatRoleCounts(roleCounts)}`);
  console.log(`Workflow: ${path.relative(root, result.workflow)}`);
  console.log(`Live: ${path.relative(root, result.live)}`);
  console.log(`Watch: sks team watch ${id}`);
  console.log('Use $Team in Codex App to run the scout-first flow: parallel analysis scouts, TriWiki refresh, debate/consensus, then a fresh implementation team with disjoint ownership.');
}

function parseTeamCreateArgs(args) {
  const spec = parseTeamSpecArgs(args);
  return { prompt: spec.cleanArgs.join(' ').trim(), agentSessions: spec.agentSessions, roleCounts: spec.roleCounts, roster: spec.roster };
}

function buildTeamPlan(id, prompt, opts = {}) {
  const spec = normalizeTeamSpec(opts);
  const { agentSessions, roleCounts, roster } = spec;
  return {
    schema_version: 1,
    mission_id: id,
    mode: 'team',
    prompt,
    agent_session_count: agentSessions,
    default_agent_session_count: 3,
    role_counts: roleCounts,
    session_policy: `Use at most ${agentSessions} subagent sessions at a time; parent orchestrator is not counted.`,
    bundle_size: roster.bundle_size,
    roster,
    team_model: {
      phases: ['parallel_analysis_scouts', 'triwiki_stage_refresh', 'debate_team', 'triwiki_stage_refresh', 'development_team', 'triwiki_stage_refresh', 'review'],
      analysis_team: `Read-only parallel scouting with exactly ${roster.bundle_size} analysis_scout_N agents. Each scout owns one investigation slice, records source paths/evidence, and returns TriWiki-ready findings before debate or implementation starts.`,
      debate_team: `Read-only role debate with exactly ${roster.bundle_size} participants composed from user, planner, reviewer, and executor voices.`,
      development_team: `Fresh parallel development bundle with exactly ${roster.bundle_size} executor_N developers implementing disjoint slices; validation_team reviews afterward.`
    },
    persona_axioms: [
      'Final users are intentionally low-context, impatient, self-interested, stubborn, and hostile to inconvenience.',
      'Executors are capable developers and must receive disjoint write ownership.',
      'Reviewers are strict, skeptical, and block unsupported correctness, DB safety, test, or evidence claims.',
      'Analysis scouts run before debate, then the debate team closes before a fresh development team starts parallel implementation.'
    ],
    reasoning: { effort: 'high', profile: 'sks-logic-high', temporary: true, restore_after_completion: true },
    codex_config_required: {
      features: { multi_agent: true, codex_hooks: true },
      agents: { max_threads: 6, max_depth: 1 },
      custom_agents_dir: '.codex/agents'
    },
    context_tracking: triwikiContextTracking(),
    phases: [
      {
        id: 'parallel_analysis_scouting',
        goal: 'Read relevant TriWiki context first, then read-only analysis scouts split repo, docs, tests, API, DB risk, UX friction, and implementation-surface investigation in parallel before debate.',
        agents: roster.analysis_team.map((agent) => agent.id),
        max_parallel_subagents: agentSessions,
        write_policy: 'read-only',
        output: 'team-analysis.md'
      },
      {
        id: 'triwiki_refresh',
        goal: 'Parent orchestrator refreshes and validates TriWiki from scout findings before assigning debate work.',
        agents: ['parent_orchestrator'],
        commands: ['sks wiki refresh', 'sks wiki validate .sneakoscope/wiki/context-pack.json'],
        output: '.sneakoscope/wiki/context-pack.json'
      },
      {
        id: 'planning_debate',
        goal: 'Debate team reads the current TriWiki pack, maps user inconvenience, code risk, constraints, DB safety, tests, and viable approaches, and hydrates low-trust claims from source immediately.',
        agents: roster.debate_team.map((agent) => agent.id),
        max_parallel_subagents: agentSessions,
        write_policy: 'read-only'
      },
      {
        id: 'consensus',
        goal: 'Parent orchestrator synthesizes one agreed objective, rejected alternatives, acceptance criteria, and parallel implementation slices, then refreshes/validates TriWiki before implementation handoff.',
        agents: ['parent_orchestrator'],
        output: 'agreed-objective.md'
      },
      {
        id: 'close_planning_agents',
        goal: 'Close or stop the debate team after findings and consensus are captured so implementation starts with a fresh development bundle.',
        agents: ['parent_orchestrator']
      },
      {
        id: 'parallel_implementation',
        goal: 'Fresh executor developers read relevant TriWiki plus current source, take disjoint write sets, implement in parallel without reverting each other, and trigger refresh after implementation changes or blockers.',
        agents: roster.development_team.map((agent) => agent.id),
        max_parallel_subagents: agentSessions,
        write_policy: 'workspace-write with explicit ownership'
      },
      {
        id: 'review_and_integrate',
        goal: 'Strict reviewers read/validate current TriWiki context, check correctness, DB safety, tests, and evidence; user personas validate practical inconvenience; parent integrates final result and refreshes after review findings.',
        agents: roster.validation_team.map((agent) => agent.id).concat(['parent_orchestrator'])
      }
    ],
    invariants: [
      'The parent thread remains the orchestrator and owns final integration.',
      'Every useful subagent message, result, handoff, review finding, and integration decision is mirrored to team-live.md and team-transcript.jsonl.',
      'Analysis scouts, debate team, and development team are separate bundles; scouts finish before debate and debate closes before implementation workers start.',
      'Analysis scouts are read-only and maximize the available session budget for independent investigation before any code edit.',
      'The parent and agents use relevant TriWiki before every stage, hydrate low-trust claims from source during the stage, and refresh/validate TriWiki after scouting, debate, consensus, implementation, and review changes.',
      'executor:N creates exactly N debate participants and then a separate N-person executor development team.',
      'Final user personas should not be overly smart or cooperative; they represent stubborn, inconvenience-averse real users.',
      'Planning agents do not edit files.',
      'Implementation workers receive disjoint ownership scopes.',
      'Workers are told they are not alone in the codebase and must not revert others edits.',
      'Context tracking uses TriWiki as the SSOT throughout the whole pipeline; team handoffs and final claims must preserve id, hash, source path, and RGBA/trig coordinate anchors.',
      'SKS hooks, DB safety rules, Ralph no-question rules, and H-Proof gates remain active.',
      'Destructive database operations remain forbidden.'
    ],
    live_visibility: {
      markdown: 'team-live.md',
      transcript: 'team-transcript.jsonl',
      dashboard: 'team-dashboard.json',
      commands: [
        'sks team status <mission-id>',
        'sks team log <mission-id>',
        'sks team tail <mission-id>',
        'sks team watch <mission-id>',
        'sks team event <mission-id> --agent <name> --phase <phase> --message "..."'
      ]
    },
    required_artifacts: ['team-analysis.md', 'team-consensus.md', 'team-review.md', 'team-gate.json', 'team-live.md', 'team-transcript.jsonl', 'team-dashboard.json', '.sneakoscope/wiki/context-pack.json', 'context7-evidence.jsonl'],
    prompt_command: '$Team'
  };
}

function teamWorkflowMarkdown(plan) {
  const ctx = plan.context_tracking || triwikiContextTracking();
  return `# SKS Team Mission

Mission: ${plan.mission_id}

Prompt:
${plan.prompt}

## Codex App Prompt

\`\`\`text
$Team ${plan.prompt}

Use high reasoning for the Team route only, then return to the default/user-selected profile after completion. Use at most ${plan.agent_session_count || 3} subagent sessions at a time; the parent orchestrator is not counted.

Before each stage, read the relevant TriWiki context pack and hydrate low-trust claims from source. First run exactly ${plan.roster.bundle_size} read-only analysis_scout_N agents in parallel. Split repo, docs, tests, API, DB risk, UX friction, and implementation-surface investigation into independent slices, then capture source-backed findings in team-analysis.md. Refresh and validate TriWiki before debate. Then run the debate team with exactly ${plan.roster.bundle_size} participants using the refreshed pack. Use the concrete roster below: final-user voices are stubborn and inconvenience-averse, executor voices are capable developers, reviewers are strict, and planners force consensus. Synthesize one agreed objective with acceptance criteria and disjoint implementation slices, then refresh and validate TriWiki again. Close the debate team. Then form a fresh development team with exactly ${plan.roster.bundle_size} executor_N developers implementing slices in parallel with non-overlapping ownership. Refresh TriWiki after implementation changes or blockers. Review with the validation team, validate TriWiki again, integrate results in the parent thread, run verification, and report evidence.
\`\`\`

## Session Budget

- Default: 3 subagent sessions.
- This mission: ${plan.agent_session_count || 3} subagent sessions.
- Bundle size: ${plan.roster.bundle_size}
- Role counts: ${formatRoleCounts(plan.role_counts)}
- The parent orchestrator is not counted.
- Use the full available session budget for analysis when independent slices exist; use fewer agents only when the work cannot be split cleanly.

## Context Tracking

- SSOT: ${ctx.ssot}
- Pack: ${ctx.default_pack}
- Refresh: \`${ctx.pack_command}\`
- Validate: \`${ctx.validate_command}\`
- Rule: use relevant TriWiki before every stage, hydrate low-trust claims during the stage, refresh after findings/artifact changes, validate before handoffs/final claims, and keep id, hash, source path, and RGBA/trig coordinate anchors hydratable.

## Analysis Scouts

${plan.roster.analysis_team.map((agent) => `- ${agent.id}: ${agent.persona}`).join('\n')}

Scout rules:
- Read-only only.
- Each scout owns one independent investigation slice.
- Return source paths, risks, claims, and suggested implementation slices in TriWiki-ready form.
- Parent updates team-analysis.md, runs \`${ctx.refresh_command || ctx.pack_command}\` or \`${ctx.pack_command}\`, then runs \`${ctx.validate_command}\` before debate/development.

## Debate Team

${plan.roster.debate_team.map((agent) => `- ${agent.id}: ${agent.persona}`).join('\n')}

## Development Team

${plan.roster.development_team.map((agent) => `- ${agent.id}: ${agent.persona}`).join('\n')}

## Validation Team

${plan.roster.validation_team.map((agent) => `- ${agent.id}: ${agent.persona}`).join('\n')}

## Live Visibility

- Keep team-live.md readable for the user inside Codex App.
- Mirror every useful subagent status, debate result, handoff, review finding, and integration decision to team-transcript.jsonl.
- Use \`sks team event ${plan.mission_id} --agent <name> --phase <phase> --message "..."\` when recording a live event from the parent thread.
- The user can inspect the flow with \`sks team log ${plan.mission_id}\`, \`sks team tail ${plan.mission_id}\`, or \`sks team watch ${plan.mission_id}\`.

## Phases

${plan.phases.map((phase, idx) => `${idx + 1}. ${phase.id}: ${phase.goal}`).join('\n')}

## Invariants

${plan.invariants.map((x) => `- ${x}`).join('\n')}
`;
}

async function teamCommand(sub, args) {
  const root = await projectRoot();
  const missionArg = args[0] && !String(args[0]).startsWith('--') ? args[0] : 'latest';
  const id = await resolveMissionId(root, missionArg);
  if (!id) {
    console.error(`Usage: sks team ${sub} [mission-id|latest]`);
    process.exitCode = 1;
    return;
  }
  const { dir } = await loadMission(root, id);
  if (sub === 'event') {
    const message = readFlagValue(args, '--message', '');
    if (!message) {
      console.error('Usage: sks team event [mission-id|latest] --agent <name> --phase <phase> --message "..."');
      process.exitCode = 1;
      return;
    }
    const record = await appendTeamEvent(dir, {
      agent: readFlagValue(args, '--agent', 'parent_orchestrator'),
      phase: readFlagValue(args, '--phase', 'general'),
      type: readFlagValue(args, '--type', 'status'),
      artifact: readFlagValue(args, '--artifact', ''),
      message
    });
    if (flag(args, '--json')) return console.log(JSON.stringify(record, null, 2));
    console.log(`${record.ts} [${record.phase}] ${record.agent}: ${record.message}`);
    return;
  }
  if (sub === 'status') {
    const dashboard = await readTeamDashboard(dir);
    if (flag(args, '--json')) return console.log(JSON.stringify(dashboard || {}, null, 2));
    if (!dashboard) {
      console.error(`Team dashboard missing for ${id}.`);
      process.exitCode = 2;
      return;
    }
    console.log(`Team mission: ${id}`);
    console.log(`Updated: ${dashboard.updated_at || 'unknown'}`);
    console.log(`Agent sessions: ${dashboard.agent_session_count || 3}`);
    if (dashboard.role_counts) console.log(`Role counts: ${formatRoleCounts(dashboard.role_counts)}`);
    for (const entry of dashboard.latest_messages || []) console.log(`${entry.ts} [${entry.phase}] ${entry.agent}: ${entry.message}`);
    return;
  }
  if (sub === 'log') return console.log(await readTeamLive(dir));
  if (sub === 'tail' || sub === 'watch') {
    const lines = readFlagValue(args, '--lines', '20');
    const printTail = async () => {
      for (const line of await readTeamTranscriptTail(dir, Number(lines))) console.log(line);
    };
    await printTail();
    if (sub === 'watch' && flag(args, '--follow')) {
      let last = (await readTeamTranscriptTail(dir, Number(lines))).join('\n');
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const next = (await readTeamTranscriptTail(dir, Number(lines))).join('\n');
        if (next !== last) {
          console.log(next);
          last = next;
        }
      }
    }
    return;
  }
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
