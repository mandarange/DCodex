import { flag, readOption } from '../cli/args.js';
import { printJson } from '../cli/output.js';
import { codexAccessTokenStatus, codexAppIntegrationStatus, codexChromeExtensionStatus, codexProductDesignPluginStatus, formatCodexAppStatus, formatCodexProductDesignPluginStatus } from '../core/codex-app.js';
import { codexAppRemoteControlCommand } from '../cli/codex-app-command.js';
import { sksRoot } from '../core/fsx.js';
import { buildCodexAppHarnessMatrix } from '../core/codex-app/codex-app-harness-matrix.js';
import { syncCodexSksSkills } from '../core/codex-app/codex-skill-sync.js';
import { syncCodexAgentRoles } from '../core/codex-app/codex-agent-role-sync.js';
import { runCodexInitDeep } from '../core/codex-app/codex-init-deep.js';
import { buildCodexHookLifecycle } from '../core/codex-app/codex-hook-lifecycle.js';
import { resolveCodexAppExecutionProfile } from '../core/codex-app/codex-app-execution-profile.js';
import { repairCodexNativeManagedAssets } from '../core/codex-native/codex-native-repair-transaction.js';
import { restartCodexApp } from '../core/codex-app/codex-app-restart.js';
import {
  resetRoleModelPreference,
  roleModelPreferencesStatus,
  setRoleModelPreference
} from '../core/subagents/role-model-preferences.js';
import type { DesktopBridgeControllerV3Options } from '../core/codex-lb/desktop-controller-v3.js';
import type { DesktopBridgeStatusV3 } from '../core/codex-lb/bridge-contracts.js';

export async function run(_command: any, args: any = []) {
  const action = args[0] || 'check';
  if (action === 'restart') return printCodexAppResult(args, await restartCodexApp());
  if (action === 'remote-control' || action === 'remote') return codexAppRemoteControlCommand(args.slice(1));
  if (action === 'harness-matrix') {
    const root = await sksRoot();
    return printCodexAppResult(args, await maybeRepairThenReadOnlyHarness(args, root));
  }
  if (action === 'skill-sync') return printCodexAppResult(args, await syncCodexSksSkills({ root: await sksRoot(), apply: flag(args, '--apply') || flag(args, '--fix') }));
  if (action === 'agent-role-sync') return printCodexAppResult(args, await syncCodexAgentRoles({ root: await sksRoot(), apply: flag(args, '--apply') || flag(args, '--fix') }));
  if (action === 'init-deep') return printCodexAppResult(args, await runCodexInitDeep({ root: await sksRoot(), apply: !flag(args, '--check-only') && !flag(args, '--dry-run') }));
  if (action === 'hook-lifecycle') return printCodexAppResult(args, await buildCodexHookLifecycle({ root: await sksRoot(), apply: flag(args, '--apply') || flag(args, '--fix') }));
  if (action === 'execution-profile') return printCodexAppResult(args, await resolveCodexAppExecutionProfile({ root: await sksRoot() }));
  if (action === 'role-models') {
    return printCodexAppResult(args, await roleModelPreferencesStatus());
  }
  if (action === 'set-role-model') {
    const result = await setRoleModelPreference({
      role: readOption(args, '--role', ''),
      provider: readOption(args, '--provider', ''),
      model: readOption(args, '--model', ''),
      reasoning: readOption(args, '--reasoning', '')
    });
    return printCodexAppResult(args, result);
  }
  if (action === 'reset-role-model') {
    const result = await resetRoleModelPreference({ role: readOption(args, '--role', '') });
    return printCodexAppResult(args, result);
  }
  if (action === 'product-design' || action === 'design-product' || action === 'ensure-product-design') {
    const checkOnly = flag(args, '--check-only') || flag(args, '--no-install');
    const status = await codexProductDesignPluginStatus({
      autoInstallProductDesign: !checkOnly && (
        action === 'product-design'
        || action === 'design-product'
        || action === 'ensure-product-design'
        || flag(args, '--install')
        || flag(args, '--auto-install')
      )
    });
    if (flag(args, '--json')) {
      printJson(status);
      if (!status.ok) process.exitCode = 1;
      return;
    }
    console.log(formatCodexProductDesignPluginStatus(status));
    if (!status.ok) process.exitCode = 1;
    return;
  }
  if (action === 'chrome-extension' || action === 'chrome') {
    const status = await codexChromeExtensionStatus();
    if (flag(args, '--json')) {
      printJson(status);
      if (!status.ok) process.exitCode = 1;
      return;
    }
    console.log(`Codex Chrome Extension: ${status.ok ? 'available' : status.status}`);
    for (const line of status.guidance || []) console.log(`- ${line}`);
    if (!status.ok) process.exitCode = 1;
    return;
  }
  if (action === 'pat') {
    const status = codexAccessTokenStatus();
    if (flag(args, '--json')) return printJson(status);
    console.log('Codex App PAT status');
    console.log(`Status: ${status.status}`);
    for (const entry of status.access_token_env_vars) console.log(`${entry.name}: ${entry.present ? entry.value : 'missing'}`);
    return;
  }
  if (action === 'check' || action === 'status') {
    const status = await codexAppStatusWithCodexLbCapabilities({
      autoInstallProductDesign: flag(args, '--install-product-design') || flag(args, '--auto-install-product-design')
    });
    if (flag(args, '--json')) {
      printJson(status);
      if (!status.ok) process.exitCode = 1;
      return;
    }
    console.log(formatCodexAppStatus(status, { includeRaw: flag(args, '--verbose') }));
    if (!status.ok) process.exitCode = 1;
    return;
  }
  console.error('Usage: sks codex-app check|status|restart|harness-matrix|skill-sync|agent-role-sync|init-deep|hook-lifecycle|execution-profile|role-models|set-role-model --role <name> [--provider <id>] --model <catalog-slug> --reasoning <effort>|reset-role-model --role <name>|product-design [--check-only]|ensure-product-design|chrome-extension|pat status|remote-control [--json]');
  console.error('Provider routing moved to: sks bridge provider configure|validate|enable; sks bridge catalog sync; sks bridge route set-default.');
  process.exitCode = 1;
}

export async function codexAppStatusWithCodexLbCapabilities(opts: {
  autoInstallProductDesign?: boolean;
  codexAppStatusImpl?: (options: Record<string, unknown>) => Promise<any>;
  codexLbStatusImpl?: (options: DesktopBridgeControllerV3Options) => Promise<DesktopBridgeStatusV3>;
  codexLbStatusOptions?: DesktopBridgeControllerV3Options;
  [key: string]: unknown;
} = {}) {
  const {
    codexAppStatusImpl = codexAppIntegrationStatus,
    codexLbStatusImpl = currentDesktopBridgeStatus,
    codexLbStatusOptions,
    ...integrationOptions
  } = opts;
  let desktopBridgeStatus: DesktopBridgeStatusV3 | null = null;
  let codexLbCapabilityReport: Record<string, unknown>;
  try {
    const status = await codexLbStatusImpl(codexLbStatusOptions || {});
    desktopBridgeStatus = status;
    const statusRecord = status as unknown as Record<string, unknown>;
    const capabilities = status?.capabilities;
    const report = capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities)
      ? capabilities as unknown as Record<string, unknown>
      : null;
    const summary = report?.summary && typeof report.summary === 'object' && !Array.isArray(report.summary)
      ? report.summary as Record<string, unknown>
      : null;
    codexLbCapabilityReport = report
      ? {
          ...report,
          availability: 'reported',
          runtime: status.management && typeof status.management === 'object'
            ? (status.management as Record<string, unknown>).runtime || null
            : null,
          overall: summary
            ? summary.level_satisfied === true ? 'verified' : 'available_unverified'
            : statusRecord.overall || report.state || 'available_unverified',
          full_capability_verified: summary
            ? summary.full_feature_verified === true
            : statusRecord.full_capability_verified === true,
          deep_evidence_validation: statusRecord.deep_evidence_validation || null
        }
      : unavailableCodexLbCapabilityReport('codex_lb_capability_report_missing');
  } catch {
    codexLbCapabilityReport = unavailableCodexLbCapabilityReport('codex_lb_capability_report_unavailable');
  }
  return codexAppStatusImpl({
    ...integrationOptions,
    desktopBridgeStatus,
    codexLbCapabilityReport
  });
}

async function currentDesktopBridgeStatus(options: DesktopBridgeControllerV3Options): Promise<DesktopBridgeStatusV3> {
  const controller = await import('../core/codex-lb/desktop-controller.js');
  return controller.desktopBridgeStatusV3(options);
}

function unavailableCodexLbCapabilityReport(blocker: string): Record<string, unknown> {
  return {
    schema: 'sks.codex-lb-desktop-capability-status.v2',
    availability: 'unavailable',
    ready: false,
    state: 'available_unverified',
    full_capability_verified: false,
    blockers: [blocker]
  };
}


function printCodexAppResult(args: any[] = [], result: any) {
  if (flag(args, '--json')) {
    printJson(result);
    if (result?.ok === false) process.exitCode = 1;
    return;
  }
  console.log(`${result?.schema || 'sks.codex-app-result'}: ${result?.ok === false ? 'blocked' : 'ok'}`);
  for (const blocker of result?.blockers || []) console.log(`- blocker: ${blocker}`);
  for (const warning of result?.warnings || []) console.log(`- warning: ${warning}`);
  if (result?.ok === false) process.exitCode = 1;
}

async function maybeRepairThenReadOnlyHarness(args: any[] = [], root: string) {
  const wantsRepair = flag(args, '--fix') || flag(args, '--apply') || flag(args, '--repair-codex-native');
  if (!wantsRepair) return buildCodexAppHarnessMatrix({ root, mode: 'read-only' });
  const repair = await repairCodexNativeManagedAssets({ root, requestedBy: 'manual', yes: flag(args, '--yes') });
  const matrix = await buildCodexAppHarnessMatrix({ root, mode: 'read-only' });
  return {
    schema: 'sks.codex-app-harness-read-repair-split.v1',
    ok: repair.ok && matrix?.ok !== false,
    repair,
    matrix,
    blockers: [...(repair.blockers || []), ...(matrix?.blockers || [])],
    warnings: [...(repair.warnings || []), 'harness_probe_after_explicit_repair_transaction']
  };
}
