import path from 'node:path';
import fsp from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { projectRoot, readJson, writeJsonAtomic, writeTextAtomic, appendJsonlBounded, nowIso, exists, ensureDir, tmpdir, packageRoot, dirSize, formatBytes, which, runProcess, PACKAGE_VERSION } from '../core/fsx.mjs';
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
import { DEFAULT_EVAL_THRESHOLDS, compareEvaluationReports, defaultEvaluationScenario, runEvaluationBenchmark } from '../core/evaluation.mjs';
import { buildResearchPrompt, evaluateResearchGate, writeMockResearchResult, writeResearchPlan } from '../core/research.mjs';
import { contextCapsule } from '../core/triwiki-attention.mjs';
import { rgbaKey, rgbaToWikiCoord, validateWikiCoordinateIndex } from '../core/wiki-coordinate.mjs';

const flag = (args, name) => args.includes(name);
const promptOf = (args) => args.filter((x) => !String(x).startsWith('--')).join(' ').trim();
const REPOSITORY_URL = 'https://github.com/mandarange/Sneakoscope-Codex.git';
const USAGE_TOPICS = 'install|setup|team|ralph|research|db|codex-app|df|dollar|eval|gx|wiki';

const DOLLAR_COMMANDS = [
  { command: '$DF', route: 'fast design/content fix', description: 'Small UI/content edits such as text color, copy, label, spacing, or translation. Avoids heavy loops.' },
  { command: '$SKS', route: 'general SKS workflow', description: 'General Sneakoscope setup, help, status, and workflow routing.' },
  { command: '$Team', route: 'multi-agent team orchestration', description: 'Debate options, agree on an objective, form a fresh implementation team, and coordinate parallel specialist work.' },
  { command: '$Ralph', route: 'Ralph mission', description: 'Mandatory clarification and no-question autonomous mission workflow.' },
  { command: '$Research', route: 'research mission', description: 'Frontier discovery, hypotheses, falsification, and testable predictions.' },
  { command: '$AutoResearch', route: 'iterative experiment loop', description: 'Program, hypothesize, test, measure, keep/discard, falsify, and report evidence.' },
  { command: '$DB', route: 'database safety', description: 'Database, Supabase, migration, SQL, or MCP safety checks.' },
  { command: '$GX', route: 'visual context', description: 'Deterministic GX visual context cartridges.' },
  { command: '$Help', route: 'command help', description: 'Explain installed SKS commands and workflows.' }
];

const COMMAND_CATALOG = [
  { name: 'help', usage: 'sks help [topic]', description: 'Show CLI help or focused help for a topic.' },
  { name: 'version', usage: 'sks version | sks --version', description: 'Print the installed Sneakoscope Codex version.' },
  { name: 'update-check', usage: 'sks update-check [--json]', description: 'Check npm for the latest Sneakoscope Codex version.' },
  { name: 'wizard', usage: 'sks wizard', description: 'Open an interactive setup UI for install scope, setup, doctor, and verification.' },
  { name: 'commands', usage: 'sks commands [--json]', description: 'List every user-facing command with a short description.' },
  { name: 'usage', usage: `sks usage [${USAGE_TOPICS}]`, description: 'Print copy-ready workflows for common tasks.' },
  { name: 'quickstart', usage: 'sks quickstart', description: 'Show the shortest safe setup and verification flow.' },
  { name: 'install-prompt', usage: 'sks install-prompt [--project] [--full]', description: 'Print a short LLM-ready prompt that installs and configures SKS automatically.' },
  { name: 'codex-app', usage: 'sks codex-app', description: 'Show Codex App setup files and example prompts.' },
  { name: 'dollar-commands', usage: 'sks dollar-commands [--json]', description: 'List Codex App $ commands such as $DF.' },
  { name: 'df', usage: 'sks df', description: 'Explain $DF fast design/content fix mode.' },
  { name: 'aliases', usage: 'sks aliases', description: 'Show command aliases and npm binary names.' },
  { name: 'setup', usage: 'sks setup [--install-scope global|project] [--local-only] [--force] [--json]', description: 'Initialize SKS state, Codex App files, hooks, skills, and rules.' },
  { name: 'fix-path', usage: 'sks fix-path [--install-scope global|project] [--json]', description: 'Refresh hook commands with the resolved SKS binary path.' },
  { name: 'doctor', usage: 'sks doctor [--fix] [--local-only] [--json] [--install-scope global|project]', description: 'Check Node, Codex CLI, install scope, hooks, skills, DB guard, and Codex App files.' },
  { name: 'init', usage: 'sks init [--force] [--local-only] [--install-scope global|project]', description: 'Initialize the local SKS control surface.' },
  { name: 'selftest', usage: 'sks selftest [--mock]', description: 'Run local smoke tests without calling a model.' },
  { name: 'ralph', usage: 'sks ralph prepare|answer|run|status ...', description: 'Run mandatory-clarification Ralph missions with a no-question execution loop.' },
  { name: 'research', usage: 'sks research prepare|run|status ...', description: 'Run frontier-style research missions with novelty and falsification gates.' },
  { name: 'db', usage: 'sks db policy|scan|mcp-config|classify|check ...', description: 'Inspect and enforce database/Supabase safety policy.' },
  { name: 'eval', usage: 'sks eval run|compare|thresholds ...', description: 'Run deterministic context-quality and performance evidence checks.' },
  { name: 'wiki', usage: 'sks wiki coords|pack|validate ...', description: 'Build and validate RGBA/trig LLM Wiki coordinate context packs.' },
  { name: 'hproof', usage: 'sks hproof check [mission-id|latest]', description: 'Evaluate the H-Proof done gate for a mission.' },
  { name: 'team', usage: 'sks team "task" [--json]', description: 'Create a Codex multi-agent Team mission with consensus and implementation phases.' },
  { name: 'gx', usage: 'sks gx init|render|validate|drift|snapshot [name]', description: 'Create and verify deterministic SVG/HTML visual context cartridges.' },
  { name: 'profile', usage: 'sks profile show|set <model>', description: 'Inspect or set the current SKS model profile metadata.' },
  { name: 'gc', usage: 'sks gc [--dry-run] [--json]', description: 'Compact oversized logs and prune stale runtime artifacts.' },
  { name: 'memory', usage: 'sks memory [--dry-run] [--json]', description: 'Alias for SKS garbage collection and retention handling.' },
  { name: 'stats', usage: 'sks stats [--json]', description: 'Show package and .sneakoscope storage size.' }
];

function installScopeFromArgs(args = [], fallback = 'global') {
  if (flag(args, '--project')) return 'project';
  if (flag(args, '--global')) return 'global';
  const i = args.indexOf('--install-scope');
  return normalizeInstallScope(i >= 0 && args[i + 1] ? args[i + 1] : fallback);
}

export async function main(args) {
  const [cmd, sub, ...rest] = args;
  const tail = sub === undefined ? [] : [sub, ...rest];
  if (!cmd) return shouldShowWizard() ? wizard([]) : help();
  if (cmd === '--help' || cmd === '-h') return help();
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') return version();
  if (cmd === 'postinstall') return postinstall();
  if (cmd === 'wizard' || cmd === 'ui') return wizard(tail);
  if (cmd === 'update-check') return updateCheck(tail);
  if (cmd === 'help') return help(tail);
  if (cmd === 'commands') return commands(tail);
  if (cmd === 'usage') return usage(tail);
  if (cmd === 'quickstart') return quickstart();
  if (cmd === 'install-prompt') return installPrompt(tail);
  if (cmd === 'codex-app') return codexAppHelp();
  if (cmd === 'dollar-commands' || cmd === 'dollars' || cmd === '$') return dollarCommands(tail);
  if (String(cmd).toLowerCase() === 'df') return dfHelp();
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
  sks install-prompt [--project] [--full]
  sks codex-app
  sks dollar-commands [--json]
  sks df
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
  sks team "task" [--json]
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
  sks wiki coords --rgba 12,34,56,255
  sks wiki pack [--json] [--role worker|verifier] [--max-anchors N]
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

Discovery:
  sks commands       Full command list with descriptions
  sks usage ralph    Workflow examples for one topic
  sks install-prompt Copy/paste prompt for an LLM installer
  sks dollar-commands Codex App $ commands, including $DF
`);
}

function version() {
  console.log(`sneakoscope ${PACKAGE_VERSION}`);
}

function shouldShowWizard() {
  return Boolean(input.isTTY && output.isTTY && process.env.SKS_NO_WIZARD !== '1' && process.env.CI !== 'true');
}

function postinstall() {
  console.log('\nSneakoscope Codex installed.');
  console.log('Run `sks` to open the interactive setup UI, or run `sks setup` for the default global setup.');
  console.log('Project-only setup: `sks wizard` -> choose project, or `npx sks setup --install-scope project`.\n');
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
  if (flag(args, '--json')) return console.log(JSON.stringify({ aliases: ['sks', 'sneakoscope'], dollar_commands: DOLLAR_COMMANDS, commands: COMMAND_CATALOG }, null, 2));
  console.log('Sneakoscope Codex Commands\n');
  console.log('Aliases: sks, sneakoscope\n');
  const width = Math.max(...COMMAND_CATALOG.map((c) => c.usage.length));
  for (const c of COMMAND_CATALOG) console.log(`${c.usage.padEnd(width)}  ${c.description}`);
}

function dollarCommands(args = []) {
  if (flag(args, '--json')) return console.log(JSON.stringify({ dollar_commands: DOLLAR_COMMANDS }, null, 2));
  console.log('Sneakoscope Codex $ Commands\n');
  console.log('Use these inside Codex App or another agent prompt. Shells treat $ as variable syntax, so these are prompt commands, not terminal commands.\n');
  const width = Math.max(...DOLLAR_COMMANDS.map((c) => c.command.length));
  for (const c of DOLLAR_COMMANDS) console.log(`${c.command.padEnd(width)}  ${c.route}: ${c.description}`);
  console.log('\nDefault pipeline: even without a $ command, SKS optimizes the prompt and infers the lightest route. Simple design/content edits infer $DF.');
}

function dfHelp() {
  console.log(`SKS DF Mode

Prompt command:
  $DF <small design/content request>

Examples:
  $DF 글자 색 파란색으로 바꿔줘
  $DF 내용을 영어로 바꿔줘
  $DF Change the CTA label to "Start"

Purpose:
  Fast design/content fixes only. DF should prompt-engineer the user's request into the smallest implementation change.

Rules:
  Do not run Ralph, Research, eval, or broad redesign.
  Inspect only what is needed, edit only what is requested, and run cheap verification when useful.
`);
}

function quickstart() {
  console.log(`Sneakoscope Codex Quickstart

Install from npm:
  npm i -g sneakoscope
  sks

Initialize this project for CLI and Codex App:
  sks setup

Verify:
  sks doctor --fix
  sks selftest --mock
  sks commands

If hooks cannot find the command:
  sks fix-path

Project-only install:
  npm i -D sneakoscope
  npx sks setup --install-scope project

Local-only install artifacts:
  sks setup --local-only
  # writes generated SKS files but excludes .sneakoscope/, .codex/, .agents/, AGENTS.md through .git/info/exclude
  # existing AGENTS.md is not modified in local-only mode

GitHub install for unreleased commits:
  npm i -g git+${REPOSITORY_URL}
`);
}

function installPrompt(args = []) {
  const projectOnly = flag(args, '--project');
  const full = flag(args, '--full');
  const install = projectOnly
    ? `npm i -D sneakoscope\nnpx sks setup --install-scope project`
    : `npm i -g sneakoscope\nsks setup`;
  if (full) return installPromptFull({ projectOnly, install });
  const command = projectOnly ? 'npx sks' : 'sks';
  const doctor = projectOnly ? 'npx sks doctor --fix --install-scope project' : 'sks doctor --fix';
  const fallback = projectOnly
    ? 'If `npx sks` is unavailable, run `npm i -D sneakoscope` again and stop with the error.'
    : 'If `sks` is unavailable after install, replace `sks` with `npx -y -p sneakoscope sks` and continue.';

  console.log(`Copy this prompt into an LLM coding assistant:

Install Sneakoscope Codex in this project.

Rules:
- Do not modify application source files.
- Ask only when a command requires user approval.
- If Node.js is below 20.11, stop and report it.
- If Codex CLI is missing, report: install @openai/codex or set SKS_CODEX_BIN.

Run exactly:
\`\`\`bash
node -v
${install}
${command} update-check
${doctor}
${command} selftest --mock
${command} commands
${command} dollar-commands
\`\`\`

${fallback}

Finish with only:
- setup passed/failed
- Codex CLI present/missing
- generated files: \`.sneakoscope/\`, \`.codex/config.toml\`, \`.codex/hooks.json\`, \`.codex/skills/\`, \`.codex/agents/\`, \`.codex/SNEAKOSCOPE.md\`, \`AGENTS.md\`
`);
}

function installPromptFull({ projectOnly, install }) {
  console.log(`Copy this prompt into an LLM coding assistant:

Install Sneakoscope Codex in the current project end to end. Do not ask follow-up questions unless a command requires user approval.

Repository:
${REPOSITORY_URL}

Requirements:
- Node.js must be >=20.11.
- Codex CLI is installed separately. If it is missing, report that \`@openai/codex\` must be installed or \`SKS_CODEX_BIN\` must be set.
- Use the published npm package for normal installs.
- Do not modify application source files unless needed for SKS setup.

Run:
\`\`\`bash
${install}
${projectOnly ? 'npx sks update-check\nnpx sks doctor --fix --install-scope project\nnpx sks selftest --mock\nnpx sks commands\nnpx sks dollar-commands' : 'sks update-check\nsks doctor --fix\nsks selftest --mock\nsks commands\nsks dollar-commands'}
\`\`\`

If npm reports ENOTEMPTY, EEXIST, or a broken old global package:
\`\`\`bash
npm uninstall -g sneakoscope
npm i -g sneakoscope
sks setup
sks doctor --fix
\`\`\`

If \`sks\` is not on PATH:
\`\`\`bash
npx -y -p sneakoscope sks setup
npx -y -p sneakoscope sks doctor --fix
npx -y -p sneakoscope sks selftest --mock
npx -y -p sneakoscope sks commands
npx -y -p sneakoscope sks dollar-commands
\`\`\`

Use the GitHub install path only when the registry package is not acceptable and an unreleased commit is required:
\`\`\`bash
npm i -g git+${REPOSITORY_URL}
\`\`\`

After setup, explain only these outputs:
- \`.sneakoscope/\` mission state and policy
- \`.codex/config.toml\` Codex App profiles
- \`.codex/hooks.json\` SKS hook integration
- \`.codex/skills/\` local Codex App skills
- \`.codex/agents/\` local Codex App multi-agent roles
- \`.codex/SNEAKOSCOPE.md\` Codex App quick reference
- \`AGENTS.md\` repository rules

Show command discovery:
\`\`\`bash
sks help
sks update-check
sks commands
sks usage team
sks usage ralph
sks quickstart
sks codex-app
sks dollar-commands
\`\`\`

Tell the user they can use these prompt commands inside Codex App:
\`\`\`text
$DF 글자 색 바꿔줘
$DF 내용을 영어로 바꿔줘
$SKS show me available workflows
$Team agree on the plan and implement with specialists
$Ralph implement this with mandatory clarification
$Research investigate this idea
$AutoResearch improve this workflow with experiments
$DB check this migration safely
\`\`\`
`);
}

function codexAppHelp() {
  console.log(`Sneakoscope Codex App Usage

Run once in the project:
  sks setup

Generated app files:
  .codex/config.toml       profiles plus multi_agent and Team agent limits
  .codex/hooks.json        hook events routed through SKS guards
  .codex/skills/           local project skills
  .codex/agents/           local Codex subagent roles for Team mode
  .codex/SNEAKOSCOPE.md    app quick reference
  AGENTS.md                repository rules

Useful prompts inside Codex App:
  $DF 글자 색 바꿔줘
  $DF 내용을 영어로 바꿔줘
  $Team agree on the plan, then implement with specialists
  $AutoResearch improve this workflow with experiments.
  Use Sneakoscope Ralph mode to prepare this task.
  Run the latest Ralph mission with the sealed decision contract.
  Use SKS DB safety before touching database or Supabase files.
  Use SKS research mode for this investigation.

Repair hook PATH issues:
  sks fix-path

Discover usage:
  sks commands
  sks usage codex-app
  sks dollar-commands
  sks df
  sks install-prompt
  sks team "task"
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
  $DF       fast design/content fix
  $SKS      general Sneakoscope route
  $Team     multi-agent team route
  $Ralph    Ralph mission route
  $Research research mission route
  $AutoResearch iterative experiment route
  $DB       database safety route
  $GX       visual context route
  $Help     command help route

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
  sks install-prompt
  sks codex-app
  sks dollar-commands

Common workflows:
  sks usage install
  sks usage team
  sks usage ralph
  sks usage research
  sks usage db
  sks usage wiki
  sks usage df
`,
    install: `Install and Setup

Global install:
  npm i -g sneakoscope
  sks setup
  sks doctor --fix
  sks selftest --mock

Repair an older broken global install:
  npm uninstall -g sneakoscope
  npm i -g sneakoscope

PATH fallback after global install:
  npx -y -p sneakoscope sks setup
  npx -y -p sneakoscope sks doctor --fix

Project-only install:
  npm i -D sneakoscope
  npx sks setup --install-scope project

Local-only install artifacts:
  sks setup --local-only
  # excludes .sneakoscope/, .codex/, .agents/, AGENTS.md through .git/info/exclude
  # existing AGENTS.md is not modified in local-only mode

GitHub install for unreleased commits:
  npm i -g git+${REPOSITORY_URL}
  sks setup

LLM-assisted install:
  sks install-prompt
`,
    team: `Team Workflow

Initialize Team support:
  sks setup

Create a Team mission:
  sks team "task"

Inside Codex App:
  $Team debate the options, agree on one objective, close the planning agents, then form a fresh implementation team with disjoint write scopes.

Expected phases:
  1. Planning/debate agents map code paths, risks, DB safety, tests, and implementation options.
  2. Parent agent synthesizes the agreed objective, constraints, acceptance criteria, and parallel work slices.
  3. Planning agents are closed.
  4. Fresh implementation workers handle disjoint slices in parallel.
  5. Review agents check correctness, DB safety, missing tests, and final evidence.

Generated Codex App support:
  .codex/config.toml enables multi_agent and [agents] limits.
  .codex/agents/*.toml defines team_consensus, implementation_worker, db_safety_reviewer, and qa_reviewer.
  .codex/skills/Team/SKILL.md explains the orchestration protocol.
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
  sks dollar-commands
  cat .codex/SNEAKOSCOPE.md

Use inside Codex App:
  $DF 글자 색 바꿔줘
  $DF 내용을 영어로 바꿔줘
  Use Sneakoscope Ralph mode to prepare this task.
  Use SKS DB safety before touching database or Supabase files.
`,
    df: `DF Fast Design/Content Fix

Use inside Codex App:
  $DF 글자 색 파란색으로 바꿔줘
  $DF 내용을 영어로 바꿔줘
  $DF Change the button label to "Start"

Behavior:
  Prompt-engineer the request into the smallest design/content edit.
  Do not start Ralph, Research, eval, or a broad redesign.
  Inspect only relevant files and run only cheap verification when useful.

CLI help:
  sks df
`,
    dollar: `Dollar Commands

Use inside Codex App or an agent prompt:
  $DF        fast design/content fix
  $SKS       general Sneakoscope route
  $Team      multi-agent team route
  $Ralph     Ralph mission route
  $Research  research mission route
  $AutoResearch iterative experiment route
  $DB        database safety route
  $GX        visual context route
  $Help      command help route

Terminal discovery:
  sks dollar-commands
  sks dollar-commands --json
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
    wiki: `LLM Wiki Context Continuity

Convert RGBA channels to deterministic wiki coordinates:
  sks wiki coords --rgba 12,34,56,255

Build a hydratable context pack:
  sks wiki pack
  sks wiki pack --json --role verifier --max-anchors 48

Validate a saved pack:
  sks wiki validate
  sks wiki validate .sneakoscope/wiki/context-pack.json

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
  const installScope = installScopeFromArgs(args);
  const localOnly = flag(args, '--local-only');
  const globalCommand = await globalSksCommand();
  const res = await initProject(root, { force: flag(args, '--force'), installScope, globalCommand, localOnly });
  const install = await installStatus(root, installScope, { globalCommand });
  const hooksPath = path.join(root, '.codex', 'hooks.json');
  const result = {
    root,
    install,
    hooks: hooksPath,
    codex_app: {
      config: path.join(root, '.codex', 'config.toml'),
      hooks: hooksPath,
      skills: path.join(root, '.codex', 'skills'),
      agents: path.join(root, '.codex', 'agents'),
      quick_reference: path.join(root, '.codex', 'SNEAKOSCOPE.md'),
      agents_rules: path.join(root, 'AGENTS.md')
    },
    created: res.created,
    local_only: localOnly,
    next: ['sks selftest --mock', 'sks doctor', 'sks commands']
  };
  if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  console.log('Sneakoscope Codex Setup\n');
  console.log(`Project:   ${root}`);
  console.log(`Install:   ${install.ok ? 'ok' : 'missing'} ${install.scope} (${install.command_prefix})`);
  console.log(`Hooks:     ${path.relative(root, hooksPath)}`);
  if (localOnly) console.log('Git:       local-only (.git/info/exclude; existing AGENTS.md not modified)');
  console.log(`Codex App: .codex/config.toml, .codex/hooks.json, .codex/skills, .codex/agents, .codex/SNEAKOSCOPE.md`);
  console.log(`Prompt:    default optimization pipeline, $DF fast design/content route`);
  console.log(`Skills:    .codex/skills`);
  console.log(`Next:      sks selftest --mock; sks commands; sks dollar-commands`);
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
  if (flag(args, '--fix')) {
    const fixScope = requestedScope || 'global';
    const existingManifest = await readJson(path.join(root, '.sneakoscope', 'manifest.json'), null);
    await initProject(root, { installScope: fixScope, globalCommand: await globalSksCommand(), localOnly: flag(args, '--local-only') || Boolean(existingManifest?.git?.local_only) });
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
  const codexApp = {
    config: { ok: await exists(path.join(root, '.codex', 'config.toml')) },
    hooks: { ok: await exists(path.join(root, '.codex', 'hooks.json')) },
    skills: { ok: await exists(path.join(root, '.codex', 'skills')) },
    agents: { ok: await exists(path.join(root, '.codex', 'agents')) },
    quick_reference: { ok: await exists(path.join(root, '.codex', 'SNEAKOSCOPE.md')) },
    agents_rules: { ok: await exists(path.join(root, 'AGENTS.md')) }
  };
  const result = {
    node: { ok: nodeOk, version: process.version }, root, codex, rust,
    install,
    sneakoscope: { ok: await exists(path.join(root, '.sneakoscope')) },
    db_guard: { ok: dbPolicyExists && dbScan.ok, policy: dbPolicyExists ? await loadDbSafetyPolicy(root) : null, scan: dbScan },
    hooks: { ok: await exists(path.join(root, '.codex', 'hooks.json')) },
    skills: { ok: await exists(path.join(root, '.codex', 'skills')) },
    codex_app: {
      ...codexApp,
      ok: codexApp.config.ok && codexApp.hooks.ok && codexApp.skills.ok && codexApp.agents.ok && codexApp.quick_reference.ok && codexApp.agents_rules.ok
    },
    package: { bytes: pkgBytes, human: formatBytes(pkgBytes) }, storage
  };
  result.ready = nodeOk && Boolean(codex.bin) && install.ok && result.sneakoscope.ok && result.db_guard.ok && result.codex_app.ok;
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
  console.log(`Codex App: ${result.codex_app.ok ? 'ok' : 'missing app files'} .codex/config.toml .codex/hooks.json .codex/skills .codex/agents .codex/SNEAKOSCOPE.md`);
  console.log(`Skills:    ${result.skills.ok ? 'ok' : 'missing .codex/skills'}`);
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
  const localOnly = flag(args, '--local-only');
  const globalCommand = await globalSksCommand();
  const res = await initProject(root, { force: flag(args, '--force'), installScope, globalCommand, localOnly });
  console.log(`Initialized Sneakoscope Codex in ${root}`);
  console.log(`Install scope: ${installScope} (${sksCommandPrefix(installScope, { globalCommand })})`);
  if (localOnly) console.log('Git mode: local-only (.git/info/exclude)');
  for (const x of res.created) console.log(`- ${x}`);
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
  const legacySkillMirrorExists = await exists(path.join(tmp, '.agents', 'skills', 'research-discovery', 'SKILL.md'));
  if (legacySkillMirrorExists) throw new Error('selftest failed: legacy .agents/skills mirror still installed');
  const codexAppSkillExists = await exists(path.join(tmp, '.codex', 'skills', 'research-discovery', 'SKILL.md'));
  if (!codexAppSkillExists) throw new Error('selftest failed: Codex App skill not installed');
  const dfSkillExists = await exists(path.join(tmp, '.codex', 'skills', 'DF', 'SKILL.md'));
  if (!dfSkillExists) throw new Error('selftest failed: $DF skill not installed');
  const promptPipelineSkillExists = await exists(path.join(tmp, '.codex', 'skills', 'prompt-pipeline', 'SKILL.md'));
  if (!promptPipelineSkillExists) throw new Error('selftest failed: prompt pipeline skill not installed');
  const codexAppQuickRefExists = await exists(path.join(tmp, '.codex', 'SNEAKOSCOPE.md'));
  if (!codexAppQuickRefExists) throw new Error('selftest failed: Codex App quick reference missing');
  const codexConfigText = await safeReadText(path.join(tmp, '.codex', 'config.toml'));
  if (!codexConfigText.includes('multi_agent = true')) throw new Error('selftest failed: multi_agent not enabled');
  if (!codexConfigText.includes('[agents.team_consensus]')) throw new Error('selftest failed: team_consensus agent not configured');
  const teamAgentExists = await exists(path.join(tmp, '.codex', 'agents', 'team-consensus.toml'));
  if (!teamAgentExists) throw new Error('selftest failed: team consensus agent not installed');
  const teamSkillExists = await exists(path.join(tmp, '.codex', 'skills', 'Team', 'SKILL.md'));
  if (!teamSkillExists) throw new Error('selftest failed: $Team skill not installed');
  const honestSkillExists = await exists(path.join(tmp, '.codex', 'skills', 'honest-mode', 'SKILL.md'));
  if (!honestSkillExists) throw new Error('selftest failed: honest-mode skill not installed');
  const autoResearchSkillExists = await exists(path.join(tmp, '.codex', 'skills', 'autoresearch-loop', 'SKILL.md'));
  if (!autoResearchSkillExists) throw new Error('selftest failed: autoresearch-loop skill not installed');
  const { id: teamId, dir: teamDir } = await createMission(tmp, { mode: 'team', prompt: '병렬 구현 팀 테스트' });
  const teamPlan = buildTeamPlan(teamId, '병렬 구현 팀 테스트');
  await writeJsonAtomic(path.join(teamDir, 'team-plan.json'), teamPlan);
  if (!teamPlan.phases.some((phase) => phase.id === 'parallel_implementation')) throw new Error('selftest failed: team plan missing implementation phase');
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
  const wikiPack = contextCapsule({
    mission: { id: 'selftest-wiki', coord: { rgba: { r: 48, g: 132, b: 212, a: 240 } } },
    role: 'verifier',
    claims: await projectWikiClaims(tmp),
    q4: { mode: 'selftest' },
    q3: ['sks', 'llm-wiki', 'wiki-coordinate'],
    budget: { maxWikiAnchors: 48 }
  });
  const wikiValidation = validateWikiCoordinateIndex(wikiPack.wiki);
  if (!wikiValidation.ok) throw new Error('selftest failed: wiki coordinate pack invalid');
  if (!(wikiPack.wiki.anchors || wikiPack.wiki.a || []).some((anchor) => (Array.isArray(anchor) ? anchor[0] : anchor.id) === 'wiki-trig')) throw new Error('selftest failed: wiki trig anchor missing');
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
    console.log('Usage: sks wiki coords --rgba R,G,B,A | sks wiki pack [--json] [--role worker|verifier] [--max-anchors N] | sks wiki validate [context-pack.json] [--json]');
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
    const role = readFlagValue(args, '--role', 'worker');
    const maxAnchors = Number(readFlagValue(args, '--max-anchors', role.includes('verifier') ? 48 : 32));
    const pack = contextCapsule({
      mission: { id: 'project-wiki', coord: { rgba: { r: 48, g: 132, b: 212, a: 240 } } },
      role,
      contractHash: null,
      claims: await projectWikiClaims(root),
      q4: { mode: 'project-continuity', package: PACKAGE_VERSION, hydrate: 'anchor-first' },
      q3: ['sks', 'llm-wiki', 'wiki-coordinate', 'gx', 'skills'],
      budget: { maxWikiAnchors: maxAnchors }
    });
    const file = path.join(root, '.sneakoscope', 'wiki', 'context-pack.json');
    await ensureDir(path.dirname(file));
    await writeJsonAtomic(file, pack);
    if (flag(args, '--json')) return console.log(JSON.stringify({ ...pack, path: file }, null, 2));
    console.log('Sneakoscope LLM Wiki Context Pack');
    console.log(`Path:     ${path.relative(root, file)}`);
    console.log(`Claims:   ${pack.claims.length} hydrated text claims`);
    console.log(`Anchors:  ${(pack.wiki.anchors || pack.wiki.a || []).length} coordinate anchors (${pack.wiki.overflow_count ?? pack.wiki.o ?? 0} overflow)`);
    console.log(`Schema:   ${pack.wiki.schema}`);
    console.log(`Validate: sks wiki validate ${path.relative(root, file)}`);
    return;
  }
  if (sub === 'validate') {
    const root = await projectRoot();
    const target = positionalArgs(args)[0] || path.join(root, '.sneakoscope', 'wiki', 'context-pack.json');
    const pack = await readJson(path.resolve(target));
    const result = validateWikiCoordinateIndex(pack.wiki || pack);
    if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Wiki coordinate index: ${result.ok ? 'ok' : 'failed'}`);
    console.log(`Anchors checked: ${result.checked}`);
    for (const issue of result.issues) console.log(`- ${issue.severity}: ${issue.id}${issue.anchor ? ` ${issue.anchor}` : ''}`);
    process.exitCode = result.ok ? 0 : 2;
    return;
  }
  console.error('Usage: sks wiki coords|pack|validate');
  process.exitCode = 1;
}

async function projectWikiClaims(root) {
  const claims = [
    ['wiki-hooks', '.codex/hooks.json routes UserPromptSubmit, tool, permission, and Stop events through SKS guards.', '.codex/hooks.json', 'code', 'high'],
    ['wiki-config', '.codex/config.toml enables Codex App profiles, multi-agent support, and Team agent limits.', '.codex/config.toml', 'code', 'high'],
    ['wiki-skills', '.codex/skills provides local routes for DF, Team, Ralph, Research, AutoResearch, DB, GX, wiki, and evaluation workflows.', '.codex/skills', 'code', 'medium'],
    ['wiki-agents', '.codex/agents defines Team planning, implementation, DB safety, and QA reviewer roles.', '.codex/agents', 'code', 'medium'],
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
  return out;
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
  if (!prompt) {
    console.error('Usage: sks team "task" [--json]');
    process.exitCode = 1;
    return;
  }
  const root = await projectRoot();
  const { id, dir } = await createMission(root, { mode: 'team', prompt });
  const schema = buildQuestionSchema(prompt);
  await writeQuestions(dir, schema);
  const plan = buildTeamPlan(id, prompt);
  await writeJsonAtomic(path.join(dir, 'team-plan.json'), plan);
  await writeTextAtomic(path.join(dir, 'team-workflow.md'), teamWorkflowMarkdown(plan));
  const result = {
    mission_id: id,
    mission_dir: dir,
    plan: path.join(dir, 'team-plan.json'),
    workflow: path.join(dir, 'team-workflow.md'),
    questions: path.join(dir, 'questions.md'),
    codex_agents: ['team_consensus', 'implementation_worker', 'db_safety_reviewer', 'qa_reviewer']
  };
  if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
  console.log(`Team mission created: ${id}`);
  console.log(`Plan: ${path.relative(root, result.plan)}`);
  console.log(`Workflow: ${path.relative(root, result.workflow)}`);
  console.log('Use $Team in Codex App to run the two-phase flow: debate/consensus, close planning agents, then spawn a fresh implementation team with disjoint ownership.');
}

function buildTeamPlan(id, prompt) {
  return {
    schema_version: 1,
    mission_id: id,
    mode: 'team',
    prompt,
    codex_config_required: {
      features: { multi_agent: true, codex_hooks: true },
      agents: { max_threads: 6, max_depth: 1 },
      custom_agents_dir: '.codex/agents'
    },
    phases: [
      {
        id: 'planning_debate',
        goal: 'Specialists independently map the code, risks, constraints, DB safety, tests, and viable approaches.',
        agents: ['team_consensus', 'db_safety_reviewer', 'qa_reviewer'],
        write_policy: 'read-only'
      },
      {
        id: 'consensus',
        goal: 'Parent orchestrator synthesizes one agreed objective, rejected alternatives, acceptance criteria, and parallel implementation slices.',
        agents: ['parent_orchestrator'],
        output: 'agreed-objective.md'
      },
      {
        id: 'close_planning_agents',
        goal: 'Close or stop planning agents after their findings are captured so implementation starts with fresh context.',
        agents: ['parent_orchestrator']
      },
      {
        id: 'parallel_implementation',
        goal: 'Fresh implementation workers take disjoint write sets and implement without reverting each other.',
        agents: ['implementation_worker'],
        write_policy: 'workspace-write with explicit ownership'
      },
      {
        id: 'review_and_integrate',
        goal: 'Reviewers check correctness, DB safety, tests, and evidence. Parent integrates final result.',
        agents: ['qa_reviewer', 'db_safety_reviewer', 'parent_orchestrator']
      }
    ],
    invariants: [
      'The parent thread remains the orchestrator and owns final integration.',
      'Planning agents do not edit files.',
      'Implementation workers receive disjoint ownership scopes.',
      'Workers are told they are not alone in the codebase and must not revert others edits.',
      'SKS hooks, DB safety rules, Ralph no-question rules, and H-Proof gates remain active.',
      'Destructive database operations remain forbidden.'
    ],
    prompt_command: '$Team'
  };
}

function teamWorkflowMarkdown(plan) {
  return `# SKS Team Mission

Mission: ${plan.mission_id}

Prompt:
${plan.prompt}

## Codex App Prompt

\`\`\`text
$Team ${plan.prompt}

First run a planning/debate team. Have team_consensus map options and constraints, db_safety_reviewer check DB/migration/RLS risk if relevant, and qa_reviewer identify correctness and test risks. Synthesize one agreed objective with acceptance criteria and disjoint implementation slices. Close the planning agents. Then form a fresh implementation team with implementation_worker agents, each with non-overlapping ownership. Review with qa_reviewer and db_safety_reviewer, integrate results in the parent thread, run verification, and report evidence.
\`\`\`

## Phases

${plan.phases.map((phase, idx) => `${idx + 1}. ${phase.id}: ${phase.goal}`).join('\n')}

## Invariants

${plan.invariants.map((x) => `- ${x}`).join('\n')}
`;
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
