import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { exists, packageRoot, projectRoot, runProcess, sha256 } from './fsx.mjs';
import { getCodexInfo } from './codex-adapter.mjs';
import { codexAppIntegrationStatus, formatCodexAppStatus } from './codex-app.mjs';

export const SKS_TMUX_LOGO = [
  '+----------------------+',
  '|        ㅅㅋㅅ         |',
  '|  Sneakoscope Codex   |',
  '+----------------------+'
].join('\n');

export function sanitizeTmuxSessionName(input) {
  const base = String(input || 'sks').trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return (base || 'sks').slice(0, 80);
}

export function defaultTmuxSessionName(root) {
  const base = sanitizeTmuxSessionName(path.basename(root || process.cwd()) || 'project');
  const hash = sha256(path.resolve(root || process.cwd())).slice(0, 8);
  return sanitizeTmuxSessionName(`sks-${base}-${hash}`);
}

export function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function platformTmuxInstallHint() {
  if (process.platform === 'darwin') return 'brew install tmux';
  if (process.platform === 'win32') return 'Install WSL2 and run: sudo apt install tmux; native Windows may use psmux.';
  return 'Ubuntu/Debian: sudo apt install tmux; Fedora: sudo dnf install tmux; Arch: sudo pacman -S tmux';
}

export async function tmuxAvailable() {
  const out = await runProcess('tmux', ['-V'], { timeoutMs: 5000, maxOutputBytes: 16 * 1024 }).catch(() => null);
  return { ok: Boolean(out && out.code === 0), version: out ? `${out.stdout}${out.stderr}`.trim() : null };
}

export async function tmuxHasSession(sessionName) {
  const out = await runProcess('tmux', ['has-session', '-t', sessionName], { timeoutMs: 5000, maxOutputBytes: 16 * 1024 }).catch((err) => ({ code: 1, stderr: err.message, stdout: '' }));
  return out.code === 0;
}

export function tmuxSplashScript(root, codexBin, codexArgs = []) {
  const logo = SKS_TMUX_LOGO;
  const extraArgs = Array.isArray(codexArgs) ? codexArgs : [];
  const lines = [
    'clear',
    `printf '%s\\n' ${shellEscape(logo)}`,
    `printf '\\nProject: %s\\n' ${shellEscape(root)}`,
    'printf \'Engine:  Codex CLI through SKS guardrails\\n\'',
    'printf \'Tools:   Prefer Browser Use + Computer Use MCP plugins for QA/UI evidence\\n\'',
    'printf \'Prompt:  use canonical $ commands only, for example $QA-LOOP\\n\\n\'',
    'sleep 1',
    `exec ${[shellEscape(codexBin), ...extraArgs.map(shellEscape), '--cd', shellEscape(root)].join(' ')}`
  ];
  return lines.join('; ');
}

export function tmuxStatusScript(root, sksBin) {
  return `${shellEscape(process.execPath)} ${shellEscape(sksBin)} tmux status --watch --root ${shellEscape(root)}`;
}

export async function buildTmuxLaunchPlan(opts = {}) {
  const root = path.resolve(opts.root || await projectRoot());
  const session = sanitizeTmuxSessionName(opts.session || defaultTmuxSessionName(root));
  const sksBin = opts.sksBin || path.join(packageRoot(), 'bin', 'sks.mjs');
  const codex = opts.codex || await getCodexInfo().catch(() => ({}));
  const tmux = opts.tmux || await tmuxAvailable();
  const app = opts.app || await codexAppIntegrationStatus({ codex });
  const codexArgs = Array.isArray(opts.codexArgs) ? opts.codexArgs : [];
  return {
    root,
    session,
    sksBin,
    codex,
    tmux,
    app,
    codexArgs,
    ready: Boolean(tmux.ok && codex.bin && app.ok),
    blockers: [
      ...(!tmux.ok ? [`tmux missing. Install: ${platformTmuxInstallHint()}`] : []),
      ...(!codex.bin ? ['Codex CLI missing. Install: npm i -g @openai/codex, or set SKS_CODEX_BIN.'] : []),
      ...(!app.ok ? app.guidance : [])
    ]
  };
}

export function formatTmuxBanner(status = null) {
  const lines = [
    SKS_TMUX_LOGO,
    '',
    'Sneakoscope Codex tmux runtime',
    '',
    'Canonical prompt commands:',
    '  $DFix  $Answer  $SKS  $Team  $QA-LOOP  $Ralph  $Research  $AutoResearch  $DB  $GX  $Wiki  $Help',
    '',
    'Preferred QA/UI tools:',
    '  Browser Use -> local browser targets, localhost, file://, current browser tab',
    '  Computer Use -> desktop apps, screenshots, browser/app interaction evidence',
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

export async function launchTmuxUi(args = [], opts = {}) {
  const rootArg = readOption(args, '--root', opts.root);
  const sessionArg = readOption(args, '--session', opts.session);
  const plan = await buildTmuxLaunchPlan({ ...opts, root: rootArg, session: sessionArg });
  if (args.includes('--json')) return { plan };
  if (!plan.ready && !args.includes('--status-only')) {
    console.log(formatTmuxBanner(plan.app));
    console.log('\nLaunch blocked:\n');
    for (const blocker of Array.from(new Set(plan.blockers))) console.log(`- ${blocker}`);
    process.exitCode = 1;
    return { plan };
  }
  const existing = await tmuxHasSession(plan.session);
  if (!existing) {
    const splash = tmuxSplashScript(plan.root, plan.codex.bin, plan.codexArgs);
    const status = tmuxStatusScript(plan.root, plan.sksBin);
    const create = spawnSync('tmux', ['new-session', '-d', '-P', '-F', '#{window_id} #{pane_id}', '-s', plan.session, '-n', 'codex', '-c', plan.root, splash], { encoding: 'utf8' });
    if (create.status !== 0) {
      process.exitCode = create.status || 1;
      if (create.stderr) process.stderr.write(create.stderr);
      return { plan };
    }
    const [windowTarget, mainPaneTarget] = String(create.stdout || '').trim().split(/\s+/);
    const target = windowTarget || `${plan.session}:codex`;
    spawnSync('tmux', ['split-window', '-h', '-p', '34', '-t', target, '-c', plan.root, status], { stdio: 'ignore' });
    if (mainPaneTarget) spawnSync('tmux', ['select-pane', '-t', mainPaneTarget], { stdio: 'ignore' });
    spawnSync('tmux', ['set-option', '-t', plan.session, 'status-left', ' ㅅㅋㅅ #[bold]#S #[default]'], { stdio: 'ignore' });
    spawnSync('tmux', ['set-option', '-t', plan.session, 'status-right', ' #(date +%H:%M) '], { stdio: 'ignore' });
  }
  if (!args.includes('--no-attach')) {
    const attach = spawnSync('tmux', ['attach-session', '-t', plan.session], { stdio: 'inherit' });
    process.exitCode = attach.status || 0;
  } else {
    console.log(`SKS tmux session ready: ${plan.session}`);
    console.log(`Attach: tmux attach-session -t ${plan.session}`);
  }
  return { plan, existing };
}

export async function runTmuxStatus(args = [], opts = {}) {
  const root = path.resolve(readOption(args, '--root', opts.root || await projectRoot()));
  const once = args.includes('--once') || !args.includes('--watch');
  do {
    const app = await codexAppIntegrationStatus();
    console.clear();
    console.log(formatTmuxBanner(app));
    if (once) return app;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } while (true);
}

function readOption(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
