#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureDistFresh, root } from './lib/ensure-dist-fresh.js';
const freshness = ensureDistFresh({ rebuild: true });
if (!freshness.ok) fail('dist_not_fresh', { freshness });
const mod = await import(pathToFileURL(path.join(root, 'dist', 'core', 'zellij', 'zellij-launcher.js')).href);
const report = await mod.launchMadZellijUi(['--workspace', 'sks-mad-check'], {
  root,
  missionId: 'M-zellij-launch-check',
  ledgerRoot: path.join(root, '.sneakoscope', 'missions', 'M-zellij-launch-check', 'agents'),
  dryRun: true,
  codexArgs: ['--profile', 'sks-mad-high', '--sandbox', 'danger-full-access', '--ask-for-approval', 'never', '-c', 'service_tier=fast', '-c', 'model_provider="codex-lb"'],
  launchEnv: { SKS_MAD_SKS_TARGET_ROOT: root, SKS_PROTECTED_CORE_POLICY: path.join(root, '.sneakoscope', 'missions', 'M-zellij-launch-check', 'mad-sks-protected-core-policy.json') }
});
const paneProofExists = await fs.access(path.join(root, '.sneakoscope', 'missions', 'M-zellij-launch-check', 'zellij-pane-proof.json')).then(() => true).catch(() => false);
const layoutText = await fs.readFile(report.layout_path, 'utf8');
const installHelpers = await fs.readFile(path.join(root, 'src', 'cli', 'install-helpers.ts'), 'utf8');
const madCommand = await fs.readFile(path.join(root, 'src', 'core', 'commands', 'mad-sks-command.ts'), 'utf8');
const installSafetyOk = !installHelpers.includes("--from-postinstall', '--install-scope', 'global', '--force', '--yes")
  && installHelpers.includes('SKS_POSTINSTALL_AUTO_INSTALL_CLI_TOOLS')
  && installHelpers.includes('postinstallExternalMutationsAllowed(process.env)')
  && installHelpers.includes('Optional Homebrew/npm-global tool repair remains off unless SKS_POSTINSTALL_AUTO_INSTALL_CLI_TOOLS=1')
  && installHelpers.includes('Codex CLI missing. Install @openai/codex');
const consoleDetailOk = madCommand.includes("['stderr_tail'")
  && madCommand.includes("['stdout_tail'")
  && madCommand.includes('report: ${launch.report_path}');
const autoAttachOk = madCommand.includes('shouldAutoAttachZellij(args)')
  && madCommand.includes('attachZellijSessionInteractive(launch.session_name')
  && madCommand.includes("list.includes('--no-attach')")
  && madCommand.includes("list.includes('--json')")
  && madCommand.includes('process.env.ZELLIJ')
  && madCommand.includes("list.includes('--attach')")
  && madCommand.includes('process.stdout.isTTY && process.stdin.isTTY');
const officialWorkflowOk = madCommand.includes('stripMadLaunchOnlyArgs(args)')
  && madCommand.includes('function madLaunchValueFlags()')
  && madCommand.includes('[SKS_ZELLIJ_HOST_MISSION_ENV]: madLaunch.mission_id')
  && madCommand.includes('slotCount: 0')
  && madCommand.includes("initial_panes: 'orchestrator-monitor-viewports'")
  && madCommand.includes('worker_panes_created: 0')
  && madCommand.includes("ui_architecture: 'monitor_plus_viewports'")
  && madCommand.includes('findUnsupportedMadArgumentErrors(rawArgsForHelp)');
const instantBootstrapOk = madCommand.includes("status: 'deferred_background'")
  && madCommand.includes('SKS_MAD_STRICT_UI_SNAPSHOT')
  && madCommand.includes('refreshMadNativeLaunchArtifacts')
  && madCommand.includes('background-verification-do-not-count-until-refreshed');
const codexPaneChecks = {
  main_pane_kind: report.main_pane_kind === 'codex_interactive',
  report_enabled: report.codex_pane?.enabled === true,
  report_no_alt_screen_arg: report.codex_pane.args.includes('--no-alt-screen'),
  report_profile_arg: report.codex_pane.args.includes('--profile') && report.codex_pane.args.includes('sks-mad-high'),
  report_sandbox_arg: report.codex_pane.args.includes('--sandbox') && report.codex_pane.args.includes('danger-full-access'),
  report_approval_arg: report.codex_pane.args.includes('--ask-for-approval') && report.codex_pane.args.includes('never'),
  report_service_tier_arg: report.codex_pane.args.includes('service_tier=fast'),
  report_provider_arg: report.codex_pane.args.some((arg) => /model_provider=.*codex-lb/.test(arg)),
  report_target_env: report.codex_pane.launch_env_keys.includes('SKS_MAD_SKS_TARGET_ROOT'),
  report_policy_env: report.codex_pane.launch_env_keys.includes('SKS_PROTECTED_CORE_POLICY'),
  layout_orchestrator_pane: /pane\s+name="orchestrator"[\s\S]*?command="sh"/.test(layoutText),
  layout_codex_exec: /exec\s+'?codex'?/.test(layoutText),
  layout_no_alt_screen_arg: layoutText.includes('--no-alt-screen'),
  layout_profile_arg: layoutText.includes('--profile') && layoutText.includes('sks-mad-high'),
  layout_sandbox_arg: layoutText.includes('--sandbox') && layoutText.includes('danger-full-access'),
  layout_approval_arg: layoutText.includes('--ask-for-approval') && layoutText.includes('never'),
  layout_service_tier_arg: layoutText.includes('service_tier=fast'),
  layout_provider_arg: /model_provider=.*codex-lb/.test(layoutText),
  layout_not_status_shell: !layoutText.includes('sks status --json || true; exec')
};
const codexPaneOk = Object.values(codexPaneChecks).every(Boolean);
const clipboardCliOk = report.launch_command.includes('--copy-command')
  && report.launch_command.includes('pbcopy')
  && report.launch_command.includes('--copy-on-select')
  && report.launch_command.includes('true')
  && report.launch_command.includes('--mouse-mode')
  && report.launch_command[report.launch_command.indexOf('--mouse-mode') + 1] === 'true'
  && report.clipboard_mouse_mode === true
  && !report.launch_command.includes('--copy-clipboard');
const ok = report.kind === 'mad'
  && report.layout_artifact
  && report.layout_path
  && report.pane_proof_path
  && paneProofExists
  && Array.isArray(report.launch_command)
  && report.launch_command.join(' ').includes('attach --create-background')
  && report.launch_command.includes('--default-layout')
  && !report.launch_command.includes('--layout')
  && !JSON.stringify(report).includes('tmux attach')
  && installSafetyOk
  && consoleDetailOk
  && autoAttachOk
  && officialWorkflowOk
  && instantBootstrapOk
  && clipboardCliOk
  && codexPaneOk;
const gate = { schema: 'sks.mad-sks-zellij-launch-check.v1', ok, install_safety_ok: installSafetyOk, console_detail_ok: consoleDetailOk, auto_attach_ok: autoAttachOk, official_workflow_ok: officialWorkflowOk, instant_bootstrap_ok: instantBootstrapOk, clipboard_cli_ok: clipboardCliOk, codex_pane_ok: codexPaneOk, codex_pane_checks: codexPaneChecks, report };
await writeMadZellijLaunchGate(gate);
emit(gate);
async function writeMadZellijLaunchGate(gate) {
  await fs.mkdir(path.join(root, '.sneakoscope', 'reports'), { recursive: true });
  await fs.writeFile(path.join(root, '.sneakoscope', 'reports', 'mad-sks-zellij-launch.json'), `${JSON.stringify(gate, null, 2)}\n`);
}
function emit(report) { console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1; }
function fail(blocker, detail) { emit({ schema: 'sks.mad-sks-zellij-launch-check.v1', ok: false, blockers: [blocker], detail }); process.exit(1); }
