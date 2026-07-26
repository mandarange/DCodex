import path from 'node:path';
import { CODEX_APP_DOCS_URL } from '../codex-app.js';
import { ensureCodexPlugins } from '../codex-plugins/codex-plugin-repair.js';
import { computerUseStatusReport } from '../computer-use-status.js';
import { ensureDir, nowIso, runProcess, which, writeJsonAtomic } from '../fsx.js';
import { redactString } from '../secret-redaction.js';
import { messageOf } from '../errors/message.js';

export const DOCTOR_COMPUTER_USE_REPAIR_SCHEMA = 'sks.doctor-computer-use-repair.v1';

export interface DoctorComputerUseRepairStep {
  id: string;
  ok: boolean;
  attempted: boolean;
  command?: string | null;
  status?: string | null;
  exit_code?: number | null;
  blocker?: string | null;
  stdout_tail?: string | null;
  stderr_tail?: string | null;
}

export async function repairComputerUse(input: {
  root: string;
  apply?: boolean;
  codexBin?: string | null;
  reportPath?: string | null;
  timeoutMs?: number;
  probe?: (opts: any) => Promise<any>;
  pluginRepair?: typeof ensureCodexPlugins;
}): Promise<any> {
  const root = path.resolve(input.root || process.cwd());
  const apply = input.apply === true;
  const probe = input.probe || computerUseStatusReport;
  const steps: DoctorComputerUseRepairStep[] = [];
  const before = await probe({ root, codexBin: input.codexBin || undefined, forceMacos: true })
    .catch((err: unknown) => ({ ok: false, status: 'unknown', blockers: [messageOf(err)] }));

  let codexBin = input.codexBin || await which('codex').catch(() => null);
  let versionStep: DoctorComputerUseRepairStep;
  if (codexBin) {
    const version = await runProcess(codexBin, ['--version'], { timeoutMs: input.timeoutMs || 5000, maxOutputBytes: 16 * 1024 })
      .catch((err: unknown) => ({ code: 1, stdout: '', stderr: messageOf(err) }));
    versionStep = {
      id: 'codex_cli_version',
      ok: version.code === 0,
      attempted: true,
      command: `${codexBin} --version`,
      exit_code: version.code,
      stdout_tail: tail(version.stdout),
      stderr_tail: tail(version.stderr),
      blocker: version.code === 0 ? null : 'codex_cli_version_failed'
    };
  } else {
    versionStep = {
      id: 'codex_cli_version',
      ok: false,
      attempted: false,
      command: 'codex --version',
      blocker: 'codex_binary_missing'
    };
  }
  steps.push(versionStep);

  const beforeReady = before?.status === 'available';
  const needsFeatureFlag = before?.status === 'codex_app_capability_missing' || before?.status === 'unknown';

  if (codexBin && !beforeReady && needsFeatureFlag && apply) {
    const enable = await runProcess(codexBin, ['features', 'enable', 'computer_use'], {
      timeoutMs: input.timeoutMs || 10000,
      maxOutputBytes: 32 * 1024
    }).catch((err: unknown) => ({ code: 1, stdout: '', stderr: messageOf(err) }));
    steps.push({
      id: 'computer_use_feature_enable',
      ok: enable.code === 0,
      attempted: true,
      command: `${codexBin} features enable computer_use`,
      exit_code: enable.code,
      stdout_tail: tail(enable.stdout),
      stderr_tail: tail(enable.stderr),
      blocker: enable.code === 0 ? null : 'codex_feature_enable_unsupported_or_failed'
    });
  } else {
    steps.push({
      id: 'computer_use_feature_enable',
      ok: beforeReady,
      attempted: false,
      command: codexBin ? `${codexBin} features enable computer_use` : 'codex features enable computer_use',
      blocker: beforeReady
        ? null
        : !apply
          ? 'doctor_fix_not_requested'
          : !codexBin
            ? 'codex_cli_missing'
            : 'computer_use_capability_missing_not_feature_flag_shaped'
    });
  }

  const repairPlugins = input.pluginRepair || ensureCodexPlugins;
  const pluginRepair: any = beforeReady
    ? null
    : await repairPlugins({
        pluginIds: ['computer-use@openai-bundled'],
        apply,
        codexBin,
        timeoutMs: input.timeoutMs || 30_000
      }).catch((err: unknown) => ({ ok: false, changed: false, installs: [], blockers: [messageOf(err)], next_actions: [] }));
  const pluginInstallStep: DoctorComputerUseRepairStep = {
    id: 'computer_use_plugin_repair',
    ok: beforeReady || pluginRepair?.ok === true,
    attempted: Boolean(pluginRepair?.installs?.length),
    command: codexBin ? `${codexBin} plugin add computer-use@openai-bundled --json` : 'codex plugin add computer-use@openai-bundled --json',
    status: beforeReady ? 'already_ready' : pluginRepair?.ok ? 'ready' : 'blocked',
    blocker: beforeReady || pluginRepair?.ok === true ? null : pluginRepair?.blockers?.[0] || 'computer_use_plugin_not_ready'
  };
  steps.push(pluginInstallStep);

  const after = await probe({ root, codexBin: codexBin || undefined, forceMacos: true })
    .catch((err: unknown) => ({ ok: false, status: 'unknown', blockers: [messageOf(err)] }));
  steps.push({
    id: 'computer_use_status_redetect',
    ok: after?.status === 'available',
    attempted: true,
    command: 'codex features list',
    blocker: after?.status === 'available' ? null : String(after?.status || 'unknown')
  });

  const recovered = after?.status === 'available';
  const blockers = recovered ? [] : [
    ...new Set([
      String(after?.status || 'computer_use_unavailable'),
      ...(pluginInstallStep.blocker && !recovered ? [pluginInstallStep.blocker] : [])
    ].filter(Boolean).map(String))
  ];
  const refreshActions = pluginRepair?.changed ? pluginRepair.next_actions || [] : [];
  const nextActions = recovered ? refreshActions : [
    ...refreshActions,
    'Install/update Codex CLI if missing: npm i -g @openai/codex@latest',
    'Open Codex App settings and enable Computer Use, or run: codex features enable computer_use',
    after?.status === 'codex_app_missing'
      ? 'Open the ChatGPT/Codex desktop app after plugin installation, enable the Computer Use server and skill toggles, and grant Screen Recording/Accessibility when prompted.'
      : 'Verify with: codex features list',
    `Docs: ${CODEX_APP_DOCS_URL}`
  ];
  let report: any = {
    schema: DOCTOR_COMPUTER_USE_REPAIR_SCHEMA,
    generated_at: nowIso(),
    ok: recovered,
    attempted: !beforeReady,
    apply,
    recovered,
    before,
    after,
    steps,
    plugin_repair: pluginRepair,
    current_task_tool_manifest_verified: false,
    requires_new_task: pluginRepair?.requires_new_task === true,
    blockers,
    next_actions: nextActions,
    docs_url: CODEX_APP_DOCS_URL
  };
  if (input.reportPath !== null) {
    const reportPath = input.reportPath || path.join(root, '.sneakoscope', 'reports', 'doctor-computer-use-repair.json');
    try {
      await ensureDir(path.dirname(reportPath));
      await writeJsonAtomic(reportPath, report);
      report = { ...report, report_path: reportPath };
    } catch (err: unknown) {
      report = { ...report, report_write_failed: true, report_write_error: messageOf(err) };
    }
  }
  return report;
}

function tail(value: unknown, max = 2000) {
  const text = redactString(String(value || ''));
  return text.length > max ? text.slice(-max) : text;
}
