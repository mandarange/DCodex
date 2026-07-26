import path from 'node:path';
import { codexChromeExtensionStatus, CODEX_CHROME_EXTENSION_SETUP_DOCS_URL } from '../codex-app.js';
import { ensureCodexPlugins } from '../codex-plugins/codex-plugin-repair.js';
import { runDoctorCodexStartupRepair } from './doctor-codex-startup-repair.js';
import { ensureDir, nowIso, runProcess, which, writeJsonAtomic } from '../fsx.js';
import { redactString } from '../secret-redaction.js';
import { messageOf } from '../errors/message.js';

export const DOCTOR_BROWSER_USE_REPAIR_SCHEMA = 'sks.doctor-browser-use-repair.v1';

export interface DoctorBrowserUseRepairStep {
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

export async function repairBrowserUse(input: {
  root: string;
  apply?: boolean;
  reportPath?: string | null;
  codexBin?: string | null;
  timeoutMs?: number;
  detectChromeExtensionStatus?: (opts: any) => Promise<any>;
  nodeReplRepair?: (opts: any) => Promise<any>;
  pluginRepair?: typeof ensureCodexPlugins;
}): Promise<any> {
  const root = path.resolve(input.root || process.cwd());
  const apply = input.apply === true;
  const detect = input.detectChromeExtensionStatus || codexChromeExtensionStatus;
  const repairNodeReplEnv = input.nodeReplRepair || runDoctorCodexStartupRepair;
  const steps: DoctorBrowserUseRepairStep[] = [];

  const before = await detect({}).catch((err: unknown) => ({
    ok: false,
    status: 'setup_required',
    blockers: [messageOf(err)],
    plugin: { installed: false, enabled: false },
    required_flags: ['browser_use_external', 'plugins', 'apps'],
    guidance: []
  }));

  const codexBin = input.codexBin || await which('codex').catch(() => null);
  steps.push({
    id: 'codex_cli_present',
    ok: Boolean(codexBin),
    attempted: false,
    command: 'which codex',
    blocker: codexBin ? null : 'codex_binary_missing'
  });

  const requiredChromeFlags = new Set(['browser_use_external', 'plugins', 'apps']);
  const flagsNeedingEnable = [...requiredChromeFlags, 'in_app_browser', 'browser_use'];
  for (const flag of flagsNeedingEnable) {
    const detectorRequiresFlag = Array.isArray(before?.required_flags) && before.required_flags.includes(flag);
    const detectorReportsMissing = (before?.blockers || []).some((b: string) => b.includes(`${flag}_feature_missing`));
    const explicitlyEnabled = before?.features?.[flag] === true || before?.feature_flags?.[flag] === true;
    const alreadyOk = explicitlyEnabled
      || (requiredChromeFlags.has(flag) && (before?.ok === true || (detectorRequiresFlag && !detectorReportsMissing)));
    if (codexBin && apply && !alreadyOk) {
      const enable = await runProcess(codexBin, ['features', 'enable', flag], {
        timeoutMs: input.timeoutMs || 10000,
        maxOutputBytes: 32 * 1024
      }).catch((err: unknown) => ({ code: 1, stdout: '', stderr: messageOf(err) }));
      steps.push({
        id: `${flag}_feature_enable`,
        ok: enable.code === 0,
        attempted: true,
        command: `${codexBin} features enable ${flag}`,
        exit_code: enable.code,
        stdout_tail: tail(enable.stdout),
        stderr_tail: tail(enable.stderr),
        status: enable.code === 0 ? 'enabled' : 'unsupported_or_failed',
        blocker: enable.code === 0 ? null : 'codex_feature_enable_unsupported_or_failed'
      });
    } else {
      steps.push({
        id: `${flag}_feature_enable`,
        ok: alreadyOk,
        attempted: false,
        command: codexBin ? `${codexBin} features enable ${flag}` : `codex features enable ${flag}`,
        status: alreadyOk ? 'already_enabled' : apply ? 'blocked' : 'detect_only',
        blocker: alreadyOk ? null : apply ? 'codex_cli_missing' : 'doctor_fix_not_requested'
      });
    }
  }

  const repairPlugins = input.pluginRepair || ensureCodexPlugins;
  const pluginRepair: any = before?.ok === true
    ? null
    : await repairPlugins({
        pluginIds: ['browser@openai-bundled', 'chrome@openai-bundled'],
        apply,
        codexBin,
        timeoutMs: input.timeoutMs || 30_000
      }).catch((err: unknown) => ({ ok: false, changed: false, installs: [], blockers: [messageOf(err)], next_actions: [] }));
  steps.push({
    id: 'browser_chrome_plugin_repair',
    ok: before?.ok === true || pluginRepair?.ok === true,
    attempted: Boolean(pluginRepair?.installs?.length),
    command: codexBin ? `${codexBin} plugin add <browser|chrome>@openai-bundled --json` : 'codex plugin add <browser|chrome>@openai-bundled --json',
    status: before?.ok === true ? 'already_ready' : pluginRepair?.ok ? 'ready' : 'blocked',
    blocker: before?.ok === true || pluginRepair?.ok === true ? null : pluginRepair?.blockers?.[0] || 'codex_browser_plugins_not_ready'
  });

  let nodeReplStep: DoctorBrowserUseRepairStep;
  if (apply) {
    const nodeReplResult = await repairNodeReplEnv({ root, fix: true }).catch((err: unknown) => ({
      ok: false,
      blockers: [messageOf(err)]
    }));
    nodeReplStep = {
      id: 'node_repl_env_block_repair',
      ok: (nodeReplResult as any)?.ok !== false,
      attempted: true,
      command: 'runDoctorCodexStartupRepair({ fix: true })',
      blocker: (nodeReplResult as any)?.ok === false ? ((nodeReplResult as any)?.blockers?.[0] || 'node_repl_env_block_repair_incomplete') : null
    };
  } else {
    nodeReplStep = {
      id: 'node_repl_env_block_repair',
      ok: true,
      attempted: false,
      command: 'runDoctorCodexStartupRepair({ fix: true })',
      blocker: 'doctor_fix_not_requested'
    };
  }
  steps.push(nodeReplStep);

  const after = await detect({}).catch((err: unknown) => ({
    ok: false,
    status: 'setup_required',
    blockers: [messageOf(err)],
    plugin: { installed: false, enabled: false },
    required_flags: ['browser_use_external', 'plugins', 'apps'],
    guidance: []
  }));

  const extensionMissing = (after?.blockers || []).some((b: string) =>
    b.startsWith('chrome_extension_plugin_missing')
    || b.startsWith('chrome_extension_plugin_not_installed')
    || b.startsWith('chrome_extension_plugin_cache_only_unverified')
  );

  const blockers: string[] = [...(after?.blockers || [])];
  if (extensionMissing && !blockers.includes('chrome_extension_manual_install_required')) {
    blockers.push('chrome_extension_manual_install_required');
  }

  const recovered = after?.ok === true;
  const optionalFeatureSteps = steps.filter((step) => step.id === 'in_app_browser_feature_enable' || step.id === 'browser_use_feature_enable');
  const optionalFeatureEnablementBlockers = optionalFeatureSteps
    .filter((step) => step.attempted && !step.ok)
    .map((step) => `${step.id}:codex_feature_enable_unsupported_or_failed`);
  // This repair can establish configuration/plugin capability only. A live Browser or
  // Chrome action in a fresh Codex task is required before any route may claim use proof.
  const realBrowserInteractionVerified = false;
  const refreshActions = pluginRepair?.changed ? pluginRepair.next_actions || [] : [];
  const nextActions = recovered ? refreshActions : [
    ...refreshActions,
    'Open the Codex Desktop app and check its settings for the Chrome/Browser Use plugin entry (exact menu wording may vary by version; check Codex app settings generically if unsure).',
    'If a Chrome extension install/enable action is offered from within Codex App settings, follow it there rather than the Chrome Web Store directly, since Codex App is the source of truth for what "ready" means for this feature.',
    `If no in-app action is available, consult the setup docs: ${CODEX_CHROME_EXTENSION_SETUP_DOCS_URL}`,
    'After installing/enabling the extension, tell SKS it is installed and rerun this repair to re-detect.',
    'Verify with: codex features list | rg "browser_use_external|plugins|apps"'
  ];

  let report: any = {
    schema: DOCTOR_BROWSER_USE_REPAIR_SCHEMA,
    generated_at: nowIso(),
    ok: recovered,
    ok_scope: 'configuration',
    attempted: before?.ok !== true,
    apply,
    recovered,
    capability_ready: recovered,
    configuration_ready: recovered,
    configuration_recovered: before?.ok !== true && recovered,
    route_ready: realBrowserInteractionVerified,
    real_browser_interaction_verified: realBrowserInteractionVerified,
    evidence_level: recovered ? 'configuration' : 'none',
    before,
    after,
    steps,
    plugin_repair: pluginRepair,
    current_task_tool_manifest_verified: false,
    requires_new_task: pluginRepair?.requires_new_task === true,
    optional_feature_enablement_blockers: optionalFeatureEnablementBlockers,
    completion_blockers: realBrowserInteractionVerified ? [] : ['codex_browser_real_interaction_unverified'],
    completion_actions: realBrowserInteractionVerified ? [] : [
      'Start a fresh Codex task so repaired Browser/Chrome tools are attached to the new task manifest.',
      'Perform and retain one real Browser or Chrome interaction before claiming browser-route completion.'
    ],
    blockers: [...new Set(blockers)],
    next_actions: nextActions,
    manual_actions: nextActions,
    docs_url: CODEX_CHROME_EXTENSION_SETUP_DOCS_URL
  };

  if (input.reportPath !== null) {
    const reportPath = input.reportPath || path.join(root, '.sneakoscope', 'reports', 'doctor-browser-use-repair.json');
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
