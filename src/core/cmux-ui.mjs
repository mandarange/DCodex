import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { exists, packageRoot, projectRoot, runProcess, sha256, which } from './fsx.mjs';
import { getCodexInfo } from './codex-adapter.mjs';
import { codexAppIntegrationStatus, formatCodexAppStatus } from './codex-app.mjs';

export const SKS_CMUX_LOGO = [
  '   _____ __ __ _____',
  '  / ___// //_// ___/',
  '  \\__ \\/ ,<   \\__ \\   ㅅㅋㅅ',
  ' ___/ / /| | ___/ /',
  '/____/_/ |_|/____/',
  'Sneakoscope Codex cmux'
].join('\n');

export const CMUX_BREW_COMMAND = 'brew tap manaflow-ai/cmux && brew install --cask cmux';
export const CMUX_BREW_UPGRADE_COMMAND = 'brew tap manaflow-ai/cmux && brew upgrade --cask cmux';

export function sanitizeCmuxWorkspaceName(input) {
  const base = String(input || 'sks').trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return (base || 'sks').slice(0, 80);
}

export function defaultCmuxWorkspaceName(root) {
  const base = sanitizeCmuxWorkspaceName(path.basename(root || process.cwd()) || 'project');
  const hash = sha256(path.resolve(root || process.cwd())).slice(0, 8);
  return sanitizeCmuxWorkspaceName(`sks-${base}-${hash}`);
}

export function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function platformCmuxInstallHint() {
  if (process.platform !== 'darwin') return 'cmux is a native macOS app; install it on macOS 14+ from https://cmux.com or https://github.com/manaflow-ai/cmux.';
  return [
    CMUX_BREW_COMMAND,
    'then run:',
    'sks cmux check'
  ].join(' ');
}

export async function findCmuxBinary() {
  const env = process.env.SKS_CMUX_BIN || process.env.CMUX_BIN;
  if (env && await exists(env)) return env;
  const onPath = await which('cmux').catch(() => null);
  if (onPath) return onPath;
  for (const candidate of cmuxBinaryCandidates()) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

export function cmuxBinaryCandidates() {
  if (process.platform !== 'darwin') return [];
  const envApps = String(process.env.SKS_CMUX_APP_PATHS || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const appBundles = [
    ...envApps,
    '/Applications/cmux.app',
    '/Applications/Cmux.app',
    '/Applications/CMUX.app',
    path.join(process.env.HOME || '', 'Applications', 'cmux.app'),
    '/opt/homebrew/Caskroom/cmux/latest/cmux.app'
  ].filter(Boolean);
  const candidates = [];
  for (const app of appBundles) {
    candidates.push(
      path.join(app, 'Contents', 'Resources', 'bin', 'cmux'),
      path.join(app, 'Contents', 'MacOS', 'cmux')
    );
  }
  candidates.push('/opt/homebrew/bin/cmux', '/usr/local/bin/cmux');
  return Array.from(new Set(candidates));
}

export async function cmuxAvailable() {
  const bin = await findCmuxBinary();
  if (!bin) return { ok: false, bin: null, version: null, error: 'cmux CLI not found' };
  const probe = await runProcess(bin, ['version'], { timeoutMs: 5000, maxOutputBytes: 16 * 1024 }).catch((err) => ({ code: 1, stderr: err.message, stdout: '' }));
  const text = `${probe.stdout || ''}${probe.stderr || ''}`.trim();
  return { ok: probe.code === 0, bin, version: text || 'cmux CLI', error: probe.code === 0 ? null : text || 'cmux CLI probe failed' };
}

export async function ensureCmuxInstalled(opts = {}) {
  const before = await cmuxAvailable().catch((err) => ({ ok: false, error: err.message || 'cmux probe failed' }));
  if (before.ok) return { target: 'cmux', status: 'present', cmux: before, command: null };
  if (opts.autoInstall === false || process.env.SKS_NO_CMUX_AUTO_INSTALL === '1') {
    return { target: 'cmux', status: 'missing', cmux: before, command: CMUX_BREW_COMMAND, error: before.error || 'cmux CLI not found' };
  }
  if (process.platform !== 'darwin') {
    return { target: 'cmux', status: 'manual_required', cmux: before, command: platformCmuxInstallHint(), error: before.error || 'cmux is macOS-only' };
  }
  const brew = await which('brew').catch(() => null);
  if (!brew) {
    return { target: 'cmux', status: 'homebrew_missing', cmux: before, command: CMUX_BREW_COMMAND, error: 'Homebrew is required for automatic cmux install' };
  }
  if (!opts.quiet) console.log('cmux CLI missing; installing/updating cmux with Homebrew...');
  const tap = await runProcess(brew, ['tap', 'manaflow-ai/cmux'], { timeoutMs: 180000, maxOutputBytes: 128 * 1024 }).catch((err) => ({ code: 1, stdout: '', stderr: err.message }));
  const install = tap.code === 0
    ? await installOrUpgradeCmuxCask(brew)
    : tap;
  let after = await cmuxAvailable().catch((err) => ({ ok: false, error: err.message || 'cmux probe failed after install' }));
  if (!after.ok && after.bin) after = await wakeCmuxAndReprobe(after);
  if (after.ok) return { target: 'cmux', status: 'installed', cmux: after, command: CMUX_BREW_COMMAND };
  const installText = `${install.stderr || ''}\n${install.stdout || ''}`.trim();
  const rawError = after.error || installText || 'brew install --cask cmux completed, but no working cmux CLI was found';
  return { target: 'cmux', status: 'failed', cmux: after, command: CMUX_BREW_COMMAND, code: install.code, error: rawError };
}

async function installOrUpgradeCmuxCask(brew) {
  const install = await runProcess(brew, ['install', '--cask', 'cmux'], { timeoutMs: 300000, maxOutputBytes: 256 * 1024 }).catch((err) => ({ code: 1, stdout: '', stderr: err.message }));
  if (install.code === 0) return install;
  const text = `${install.stderr || ''}\n${install.stdout || ''}`;
  if (!/already installed|to upgrade|brew upgrade/i.test(text)) return install;
  const upgrade = await runProcess(brew, ['upgrade', '--cask', 'cmux'], { timeoutMs: 300000, maxOutputBytes: 256 * 1024 }).catch((err) => ({ code: 1, stdout: '', stderr: err.message }));
  return upgrade.code === 0 ? upgrade : install;
}

export function codexLaunchCommand(root, codexBin, codexArgs = []) {
  const extraArgs = Array.isArray(codexArgs) ? codexArgs : [];
  return [
    'clear',
    `printf '%s\\n' ${shellEscape(SKS_CMUX_LOGO)}`,
    `printf '\\nProject: %s\\n' ${shellEscape(root)}`,
    'printf \'Runtime: cmux workspace for Codex CLI\\n\'',
    'printf \'Prompt:  use canonical $ commands, for example $Team or $QA-LOOP\\n\\n\'',
    'sleep 1',
    `exec ${[shellEscape(codexBin), ...extraArgs.map(shellEscape), '--cd', shellEscape(root)].join(' ')}`
  ].join('; ');
}

export function teamAgentCommand(root, missionId, agentId, phase) {
  return [
    `printf '%s\\n' ${shellEscape(`${SKS_CMUX_LOGO}\n\nTeam mission: ${missionId}\nAgent: ${agentId}\nPhase: ${phase}\n`)}`,
    `cd ${shellEscape(root)}`,
    `node ${shellEscape(path.join(packageRoot(), 'bin', 'sks.mjs'))} team watch ${shellEscape(missionId)} --follow --lines 12`
  ].join('; ');
}

export async function buildCmuxLaunchPlan(opts = {}) {
  const root = path.resolve(opts.root || await projectRoot());
  const workspace = sanitizeCmuxWorkspaceName(opts.workspace || opts.session || defaultCmuxWorkspaceName(root));
  const sksBin = opts.sksBin || path.join(packageRoot(), 'bin', 'sks.mjs');
  const codex = opts.codex || await getCodexInfo().catch(() => ({}));
  const cmux = opts.cmux || await cmuxAvailable();
  const app = opts.app || await codexAppIntegrationStatus({ codex });
  const codexArgs = Array.isArray(opts.codexArgs) ? opts.codexArgs : [];
  return {
    root,
    workspace,
    sksBin,
    codex,
    cmux,
    app,
    codexArgs,
    ready: Boolean(cmux.ok && codex.bin),
    warnings: app.ok ? [] : app.guidance || [],
    blockers: [
      ...(!cmux.ok ? [`cmux missing. Install: ${platformCmuxInstallHint()}`] : []),
      ...(!codex.bin ? ['Codex CLI missing. Install: npm i -g @openai/codex, or set SKS_CODEX_BIN.'] : [])
    ]
  };
}

export function formatCmuxBanner(status = null) {
  const lines = [
    SKS_CMUX_LOGO,
    '',
    'ㅅㅋㅅ cmux runtime',
    '',
    'Canonical prompt commands:',
    '  $DFix  $Answer  $SKS  $Team  $QA-LOOP  $Ralph  $Research  $AutoResearch  $DB  $GX  $Wiki  $Help',
    '',
    'CLI-first runtime:',
    '  sks                 open a cmux Codex CLI workspace',
    '  sks --mad           open one-shot MAD full-access auto-review workspace',
    '  sks team "task"     prepare Team mission and cmux multi-line agent view',
    '',
    'Useful terminal commands:',
    '  sks commands',
    '  sks dollar-commands',
    '  sks codex-app check',
    '  sks doctor --fix'
  ];
  if (status) lines.push('', formatCodexAppStatus(status));
  return lines.join('\n');
}

export async function launchCmuxUi(args = [], opts = {}) {
  const rootArg = readOption(args, '--root', opts.root);
  const workspaceArg = readOption(args, '--workspace', readOption(args, '--session', opts.workspace || opts.session));
  let plan = await buildCmuxLaunchPlan({ ...opts, root: rootArg, workspace: workspaceArg });
  let cmuxRepair = null;
  if (!plan.ready && plan.cmux.bin && !plan.cmux.ok && !args.includes('--json')) {
    const warmed = await wakeCmuxAndReprobe(plan.cmux);
    if (warmed.ok) plan = await buildCmuxLaunchPlan({ ...opts, root: rootArg, workspace: workspaceArg, cmux: warmed });
  }
  if (!plan.ready && !plan.cmux.ok && opts.autoInstallCmux && !args.includes('--json')) {
    cmuxRepair = await ensureCmuxInstalled({ autoInstall: true, quiet: Boolean(opts.quietAutoInstall || args.includes('--quiet')) });
    if (cmuxRepair.cmux?.ok) plan = await buildCmuxLaunchPlan({ ...opts, root: rootArg, workspace: workspaceArg, cmux: cmuxRepair.cmux });
  }
  if (args.includes('--json')) return { plan };
  if (!plan.ready && !args.includes('--status-only')) {
    printCmuxLaunchBlocked(plan, { concise: opts.conciseBlockers, cmuxRepair });
    process.exitCode = 1;
    return { plan };
  }
  const daemon = await ensureCmuxDaemonReady(plan.cmux);
  if (!daemon.ok && !args.includes('--status-only')) {
    const blocked = { ...plan, ready: false, cmux: { ...plan.cmux, ok: false, error: daemon.error || 'cmux app did not become ready' } };
    printCmuxLaunchBlocked(blocked, { concise: opts.conciseBlockers, cmuxRepair });
    process.exitCode = 1;
    return { plan: blocked };
  }
  if (!args.includes('--no-open')) await openCmuxApp().catch(() => null);
  const command = codexLaunchCommand(plan.root, plan.codex.bin, plan.codexArgs);
  const created = spawnSync(plan.cmux.bin, ['new-workspace', '--cwd', plan.root, '--command', command], { encoding: 'utf8', stdio: args.includes('--quiet') ? 'pipe' : 'inherit' });
  if (created.status !== 0) {
    process.exitCode = created.status || 1;
    if (created.stderr) process.stderr.write(created.stderr);
    return { plan };
  }
  if (args.includes('--no-open')) {
    console.log(`SKS cmux workspace requested: ${plan.workspace}`);
  }
  return { plan, created: true };
}

function printCmuxLaunchBlocked(plan, opts = {}) {
  if (opts.concise) {
    console.error('SKS cmux launch blocked.');
    if (!plan.cmux.ok) {
      const repair = opts.cmuxRepair;
      const installedButUnhealthy = Boolean(plan.cmux.bin);
      const prefix = repair?.status
        ? `cmux ${repair.status}`
        : installedButUnhealthy
          ? 'cmux app/socket unhealthy'
          : 'cmux missing';
      console.error(`- ${prefix}: ${repair?.error || plan.cmux.error || 'cmux CLI not found'}`);
      console.error(`- ${installedButUnhealthy ? 'Repair command' : 'Install command'}: ${repair?.command || (installedButUnhealthy ? 'sks deps install cmux --yes' : CMUX_BREW_COMMAND)}`);
    }
    if (!plan.codex.bin) console.error('- Codex CLI missing. Install: npm i -g @openai/codex@latest, or set SKS_CODEX_BIN.');
    return;
  }
  console.log(formatCmuxBanner(plan.app));
  console.log('\nLaunch blocked:\n');
  for (const blocker of Array.from(new Set(plan.blockers))) console.log(`- ${blocker}`);
}

export async function openCmuxApp() {
  if (process.platform !== 'darwin') return { ok: false, reason: 'not_macos' };
  const run = await runProcess('open', ['-a', 'cmux'], { timeoutMs: 5000, maxOutputBytes: 16 * 1024 }).catch((err) => ({ code: 1, stderr: err.message, stdout: '' }));
  if (run.code === 0) return { ok: true, stdout: run.stdout || '', stderr: run.stderr || '' };
  for (const app of ['/Applications/cmux.app', '/Applications/Cmux.app']) {
    if (!await exists(app)) continue;
    const byPath = await runProcess('open', [app], { timeoutMs: 5000, maxOutputBytes: 16 * 1024 }).catch((err) => ({ code: 1, stderr: err.message, stdout: '' }));
    if (byPath.code === 0) return { ok: true, stdout: byPath.stdout || '', stderr: byPath.stderr || '' };
  }
  return { ok: false, stdout: run.stdout || '', stderr: run.stderr || '' };
}

async function wakeCmuxAndReprobe(fallback = {}) {
  return ensureCmuxDaemonReady(fallback);
}

async function ensureCmuxDaemonReady(cmux = {}) {
  if (!cmux?.bin) return { ok: false, error: cmux?.error || 'cmux CLI not found' };
  const first = await cmuxSocketProbe(cmux.bin);
  if (first.ok) return { ...cmux, ok: true, error: null };
  if (process.platform !== 'darwin') return first;
  const opened = await openCmuxApp().catch(() => null);
  if (!opened?.ok) return { ok: false, error: opened?.stderr || opened?.reason || first.error || 'cmux app launch failed' };
  let last = first;
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    last = await cmuxSocketProbe(cmux.bin);
    if (last.ok) return { ...cmux, ok: true, error: null };
  }
  if (isRecoverableCmuxSocketError(last.error) && process.env.SKS_CMUX_NO_RESTART !== '1') {
    await restartCmuxApp();
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      last = await cmuxSocketProbe(cmux.bin);
      if (last.ok) return { ...cmux, ok: true, error: null };
    }
  }
  return { ok: false, error: last.error || 'cmux socket did not become ready' };
}

async function cmuxSocketProbe(bin) {
  const probe = await runProcess(bin, ['list-workspaces', '--json'], { timeoutMs: 5000, maxOutputBytes: 16 * 1024 }).catch((err) => ({ code: 1, stderr: err.message, stdout: '' }));
  const text = `${probe.stdout || ''}${probe.stderr || ''}`.trim();
  return { ok: probe.code === 0, error: probe.code === 0 ? null : text || 'cmux socket probe failed' };
}

function isRecoverableCmuxSocketError(error) {
  return /socket|broken pipe|receive timeout|connection refused/i.test(String(error || ''));
}

async function restartCmuxApp() {
  if (process.platform !== 'darwin') return { ok: false, reason: 'not_macos' };
  const quit = await runProcess('osascript', ['-e', 'tell application "cmux" to quit'], { timeoutMs: 8000, maxOutputBytes: 16 * 1024 }).catch((err) => ({ code: 1, stderr: err.message, stdout: '' }));
  if (quit.code !== 0) {
    await runProcess('pkill', ['-TERM', '-f', '/Applications/cmux.app/Contents/MacOS/cmux'], { timeoutMs: 8000, maxOutputBytes: 16 * 1024 }).catch(() => null);
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await removeStaleCmuxSocket().catch(() => null);
  return openCmuxApp();
}

async function removeStaleCmuxSocket() {
  const home = process.env.HOME;
  if (!home) return;
  const sock = path.join(home, 'Library', 'Application Support', 'cmux', 'cmux.sock');
  await fsp.rm(sock, { force: true });
}

export async function launchCmuxTeamView({ root, missionId, plan = {}, promptFile = null, json = false } = {}) {
  const launch = await buildCmuxLaunchPlan({ root, workspace: `sks-team-${missionId}` });
  const agents = [
    ...(plan.roster?.analysis_team || []),
    ...(plan.roster?.debate_team || []),
    ...(plan.roster?.development_team || []),
    ...(plan.roster?.validation_team || [])
  ];
  const uniqueAgents = [];
  const seen = new Set();
  for (const agent of agents) {
    const id = agent.id || String(agent);
    if (seen.has(id)) continue;
    seen.add(id);
    uniqueAgents.push(id);
  }
  const commands = uniqueAgents.slice(0, Math.max(1, plan.agent_session_count || 3)).map((agentId, index) => ({
    agent: agentId,
    command: teamAgentCommand(launch.root, missionId, agentId, index === 0 ? 'analysis' : 'team', promptFile)
  }));
  const result = { ready: launch.ready, cmux: launch.cmux, workspace: launch.workspace, agents: commands, blockers: launch.blockers };
  if (json || !launch.ready) return result;
  const first = commands[0]?.command || teamAgentCommand(launch.root, missionId, 'parent_orchestrator', 'team', promptFile);
  const created = spawnSync(launch.cmux.bin, ['new-workspace', '--cwd', launch.root, '--command', first], { encoding: 'utf8', stdio: 'ignore' });
  result.created = created.status === 0;
  for (const entry of commands.slice(1)) {
    spawnSync(launch.cmux.bin, ['new-split', 'right'], { encoding: 'utf8', stdio: 'ignore' });
    spawnSync(launch.cmux.bin, ['send', `${entry.command}\n`], { encoding: 'utf8', stdio: 'ignore' });
  }
  return result;
}

export async function runCmuxStatus(args = [], opts = {}) {
  const once = args.includes('--once') || !args.includes('--watch');
  do {
    const app = await codexAppIntegrationStatus();
    console.clear();
    console.log(formatCmuxBanner(app));
    if (once) return app;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } while (true);
}

function readOption(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
