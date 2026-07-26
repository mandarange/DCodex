import fs from 'node:fs/promises';
import path from 'node:path';
import { nowIso, readText, writeJsonAtomic } from '../fsx.js';
import { syncCoreSkillsIntegrity } from '../codex-native/core-skill-integrity.js';
import { dedupeProjectSkills } from '../codex-native/project-skill-dedupe.js';
import { repairNativeCapabilities } from '../codex-native/native-capability-repair.js';
import { withSecretPreservationGuard } from '../config/config-migration-journal.js';
import { ensureProductDesignPluginInstalled } from '../product-design-app-server.js';
import { cleanupLegacyGlobalSksHooks } from './legacy-global-hook-cleanup.js';
import { redactSecrets } from '../secret-redaction.js';
import { messageOf } from '../errors/message.js';

export interface DoctorNativeCapabilityRepairReport {
  schema: 'sks.doctor-native-capability-repair.v1';
  generated_at: string;
  ok: boolean;
  root: string;
  fix: boolean;
  yes: boolean;
  core_skills: unknown;
  skill_dedupe: unknown;
  native_capabilities: unknown;
  product_design: unknown;
  legacy_global_hooks: unknown;
  probe_artifact_cleanup: unknown;
  secret_preservation_guard: string;
  core_blockers: string[];
  route_blockers: Record<string, string[]>;
  optional_manual_required: string[];
  optional_warnings: string[];
  blockers: string[];
  report_write_failed?: boolean;
}

export async function runDoctorNativeCapabilityRepair(input: {
  root: string;
  fix: boolean;
  yes: boolean;
  flags?: string[];
  skipNativeCapabilities?: boolean;
  home?: string;
}): Promise<DoctorNativeCapabilityRepairReport> {
  const root = path.resolve(input.root);
  const fixRequested = input.fix || (input.flags || []).includes('--fix');
  const operation = async () => {
    const coreSkills = await syncCoreSkillsIntegrity({ root, apply: input.fix });
    const skillDedupe = await dedupeProjectSkills({
      root,
      fix: input.fix,
      yes: input.yes,
      quarantineUserDuplicates: (input.flags || []).includes('--quarantine-user-duplicate-skills')
    });
    const nativeCapabilities = input.skipNativeCapabilities === true
      ? skippedNativeCapabilityDiagnostics(root)
      : await repairNativeCapabilities({
          root,
          fix: input.fix,
          yes: input.yes,
          allowManualInstructions: true
        });
    const probeArtifactCleanup = await cleanupNativeCapabilityProbeArtifacts(root, { apply: fixRequested });
    const legacyGlobalHooks = await cleanupLegacyGlobalSksHooks({
      root,
      ...(input.home ? { home: input.home } : {}),
      apply: fixRequested
    });
    const productDesignRaw: any = input.fix
      ? await ensureProductDesignPluginInstalled({
          cwd: root,
          autoInstallProductDesign: true,
          timeoutMs: 12_000
        }).catch((err: unknown) => ({ ok: false, status: 'app_server_unavailable', blockers: [messageOf(err)] }))
      : { ok: true, skipped: true, status: 'deferred_to_explicit_native_capability_repair', blockers: [] };
    const productDesignWithActions = productDesignRaw?.install_attempted === true ? {
      ...productDesignRaw,
      current_task_tool_manifest_verified: false,
      requires_new_task: true,
      restart_app_if_stale: true,
      next_actions: [
        'Start a new Codex/Work task so Product Design skills and tools are attached to a fresh task manifest.',
        'If Product Design is still missing, restart the ChatGPT/Codex desktop app and rerun the native capability doctor.'
      ]
    } : productDesignRaw;
    const productDesign = redactSecrets(productDesignWithActions);
    const blockers = [
      ...((coreSkills as { blockers?: string[] }).blockers || []),
      ...((skillDedupe as { blockers?: string[] }).blockers || []),
      ...((nativeCapabilities as { core_blockers?: string[]; blockers?: string[] }).core_blockers || (nativeCapabilities as { blockers?: string[] }).blockers || [])
    ];
    const routeBlockers = (nativeCapabilities as { route_blockers?: Record<string, string[]> }).route_blockers || {};
    const optionalManualRequired = (nativeCapabilities as { optional_manual_required?: string[] }).optional_manual_required || [];
    const optionalWarnings = [
      ...((nativeCapabilities as { warnings?: string[] }).warnings || []),
      ...optionalManualRequired.map((id) => `${id}_manual_required`),
      ...((legacyGlobalHooks as any).blockers || []).map((blocker: string) => `legacy_global_hooks:${blocker}`),
      ...((legacyGlobalHooks as any).warnings || []),
      ...((productDesign as any).ok === false ? ((productDesign as any).blockers || ['product_design_not_ready']).map((blocker: string) => `product_design:${blocker}`) : [])
    ];
    let report: DoctorNativeCapabilityRepairReport = {
      schema: 'sks.doctor-native-capability-repair.v1',
      generated_at: nowIso(),
      ok: blockers.length === 0,
      root,
      fix: input.fix,
      yes: input.yes,
      core_skills: coreSkills,
      skill_dedupe: skillDedupe,
      native_capabilities: nativeCapabilities,
      product_design: productDesign,
      legacy_global_hooks: legacyGlobalHooks,
      probe_artifact_cleanup: probeArtifactCleanup,
      secret_preservation_guard: '.sneakoscope/reports/secret-preservation-guard.json',
      core_blockers: blockers,
      route_blockers: routeBlockers,
      optional_manual_required: optionalManualRequired,
      optional_warnings: [...new Set(optionalWarnings)],
      blockers
    };
    const reportPath = path.join(root, '.sneakoscope', 'reports', 'doctor-native-capability-repair.json');
    try {
      await writeJsonAtomic(reportPath, report);
    } catch (err: unknown) {
      report = { ...report, report_write_failed: true };
      process.stderr.write(`SKS doctor warning: failed to write native capability repair report ${reportPath}: ${messageOf(err)}\n`);
    }
    return report;
  };
  if (!fixRequested) return operation();
  return withSecretPreservationGuard(root, 'doctor-native-capability-repair', operation);
}

export async function cleanupNativeCapabilityProbeArtifacts(root: string, opts: { apply?: boolean } = { apply: true }) {
  const sentinel = 'sks-native-capability-postcheck\n';
  const candidates = [
    path.join(root, '.sneakoscope', 'image-artifacts', 'postcheck-followup-sample.txt'),
    path.join(root, '.sneakoscope', 'app-screenshots', 'postcheck-screenshot-sample.txt'),
    path.join(root, '.sneakoscope', 'image-artifacts', 'postcheck-contract-image.txt'),
    path.join(root, '.sneakoscope', 'app-screenshots', 'postcheck-contract-screenshot.txt')
  ];
  const removed: string[] = [];
  const planned: string[] = [];
  const preserved: string[] = [];
  for (const file of candidates) {
    const text = await readText(file, '');
    if (!text) continue;
    if (text !== sentinel) {
      preserved.push(file);
      continue;
    }
    if (opts.apply !== false) {
      await fs.rm(file, { force: true });
      removed.push(file);
    } else {
      planned.push(file);
    }
  }
  return {
    schema: 'sks.native-capability-probe-artifact-cleanup.v1',
    ok: true,
    apply: opts.apply !== false,
    removed,
    planned,
    preserved_non_probe_files: preserved
  };
}

function skippedNativeCapabilityDiagnostics(root: string) {
  return {
    schema: 'sks.native-capability-repair-matrix.v1',
    generated_at: nowIso(),
    ok: true,
    root,
    skipped: true,
    reason: 'optional_native_capabilities_deferred_to_doctor_capabilities_or_route_gate',
    capabilities: [],
    core_blockers: [],
    route_blockers: {
      'route-computer-use': ['computer_use_os_permission_or_capability_unknown'],
      'route-chrome-web-review': ['codex_chrome_extension_readiness_not_verified']
    },
    optional_manual_required: ['computer_use', 'chrome_web_review'],
    blockers: [],
    warnings: [
      'computer_use_manual_required_before_route',
      'chrome_extension_manual_required_before_browser_route',
      'optional_native_capability_diagnostics_skipped'
    ]
  };
}
