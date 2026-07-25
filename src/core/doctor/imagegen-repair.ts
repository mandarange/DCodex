import path from 'node:path';
import { CODEX_APP_IMAGE_GENERATION_DOC_URL } from '../routes.js';
import { detectImagegenCapability } from '../imagegen/imagegen-capability.js';
import { ensureDir, nowIso, runProcess, which, writeJsonAtomic } from '../fsx.js';
import { redactString } from '../secret-redaction.js';
import { messageOf } from '../errors/message.js';

export const DOCTOR_IMAGEGEN_REPAIR_SCHEMA = 'sks.doctor-imagegen-repair.v1';

export interface DoctorImagegenRepairStep {
  id: string;
  ok: boolean;
  attempted: boolean;
  command?: string | null;
  status?: string | null;
  exit_code?: number | null;
  blocker?: string | null;
  stdout_tail?: string | null;
  stderr_tail?: string | null;
  evidence_level?: 'configuration' | 'real-output';
}

export async function repairCodexImagegen(input: {
  root: string;
  apply?: boolean;
  codexBin?: string | null;
  reportPath?: string | null;
  timeoutMs?: number;
  autoInstallCodex?: boolean;
}): Promise<any> {
  const root = path.resolve(input.root || process.cwd());
  const apply = input.apply === true;
  const steps: DoctorImagegenRepairStep[] = [];
  const before = await detectImagegenCapability({
    codexBin: input.codexBin || undefined,
    timeoutMs: input.timeoutMs || 5000
  }).catch((err: unknown) => ({ ok: false, core_ready: false, blockers: [messageOf(err)], codex_app: { available: false, blocker: messageOf(err) } }));

  let codexBin = input.codexBin || await which('codex').catch(() => null);
  let versionStep: DoctorImagegenRepairStep;
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

  if (!codexBin && apply && (input.autoInstallCodex === true || process.env.SKS_IMAGEGEN_AUTO_INSTALL_CODEX === '1')) {
    const npmBin = await which('npm').catch(() => null);
    if (npmBin) {
      const install = await runProcess(npmBin, ['i', '-g', '@openai/codex@latest'], {
        timeoutMs: 180000,
        maxOutputBytes: 128 * 1024
      }).catch((err: unknown) => ({ code: 1, stdout: '', stderr: messageOf(err) }));
      steps.push({
        id: 'codex_cli_install',
        ok: install.code === 0,
        attempted: true,
        command: `${npmBin} i -g @openai/codex@latest`,
        exit_code: install.code,
        stdout_tail: tail(install.stdout),
        stderr_tail: tail(install.stderr),
        blocker: install.code === 0 ? null : 'codex_cli_install_failed'
      });
      codexBin = await which('codex').catch(() => null);
    } else {
      steps.push({
        id: 'codex_cli_install',
        ok: false,
        attempted: false,
        command: 'npm i -g @openai/codex@latest',
        blocker: 'npm_missing'
      });
    }
  } else if (!codexBin) {
    steps.push({
      id: 'codex_cli_install',
      ok: false,
      attempted: false,
      command: 'npm i -g @openai/codex@latest',
      blocker: apply ? 'auto_install_requires_SKS_IMAGEGEN_AUTO_INSTALL_CODEX_1' : 'doctor_fix_not_requested'
    });
  }

  if (codexBin && before?.core_ready !== true && apply) {
    const enable = await runProcess(codexBin, ['features', 'enable', 'image_generation'], {
      timeoutMs: input.timeoutMs || 10000,
      maxOutputBytes: 32 * 1024
    }).catch((err: unknown) => ({ code: 1, stdout: '', stderr: messageOf(err) }));
    steps.push({
      id: 'image_generation_feature_enable',
      ok: enable.code === 0,
      attempted: true,
      command: `${codexBin} features enable image_generation`,
      exit_code: enable.code,
      stdout_tail: tail(enable.stdout),
      stderr_tail: tail(enable.stderr),
      blocker: enable.code === 0 ? null : 'codex_feature_enable_unsupported_or_failed'
    });
  } else {
    steps.push({
      id: 'image_generation_feature_enable',
      ok: before?.core_ready === true,
      attempted: false,
      command: codexBin ? `${codexBin} features enable image_generation` : 'codex features enable image_generation',
      blocker: before?.core_ready === true ? null : apply ? 'codex_cli_missing' : 'doctor_fix_not_requested'
    });
  }

  const after = await detectImagegenCapability({
    codexBin: codexBin || undefined,
    timeoutMs: input.timeoutMs || 5000
  }).catch((err: unknown) => ({ ok: false, core_ready: false, blockers: [messageOf(err)], codex_app: { available: false, blocker: messageOf(err) } }));
  steps.push({
    id: 'imagegen_capability_redetect',
    ok: after?.core_ready === true,
    attempted: true,
    command: 'codex features list',
    status: after?.core_ready === true ? 'configuration_ready_output_unverified' : 'configuration_missing',
    evidence_level: 'configuration',
    blocker: after?.core_ready === true ? null : 'codex_app_builtin_imagegen_capability_missing'
  });

  const capabilityReady = after?.core_ready === true;
  const realGenerationVerified = capabilityReady
    && (after as any)?.real_generation_available === true
    && (after as any)?.real_output_verified_by_capability_check === true;
  // No real generation round-trip primitive exists in imagegen-capability.ts today.
  // Keep configuration detection separate from route/output proof.
  const communicationTest = {
    level: realGenerationVerified ? 'real_output' as const : 'flag_level' as const,
    ok: realGenerationVerified,
    checked: realGenerationVerified
      ? 'real Codex App $imagegen generated-output evidence'
      : 'codex features list (feature-flag/plugin metadata only)',
    real_generation_round_trip_performed: realGenerationVerified,
    configuration_ready: capabilityReady,
    blocker: realGenerationVerified
      ? null
      : capabilityReady
        ? 'codex_imagegen_real_output_unverified'
        : 'codex_app_builtin_imagegen_capability_missing'
  };

  const recovered = realGenerationVerified;
  const featureEnableStep = steps.find((step) => step.id === 'image_generation_feature_enable');
  const configurationRecovered = before?.core_ready !== true && capabilityReady && featureEnableStep?.attempted === true && featureEnableStep.ok === true;
  const requiresNewTask = !recovered;
  const refreshActions = requiresNewTask ? [
    'Start a new Codex/Work task so the repaired $imagegen tool is attached to a fresh task manifest.',
    'Invoke Codex App $imagegen with gpt-image-2 and bind the selected raster output path to the route evidence.',
    'If $imagegen is missing in the new task, restart the ChatGPT/Codex desktop app and rerun `sks doctor --fix --repair-native-capabilities --yes`.'
  ] : [];
  const blockers = recovered ? [] : [
    ...new Set([
      ...((after as any)?.core_blockers || []),
      ...((after as any)?.blockers || []),
      ...(capabilityReady ? ['codex_imagegen_real_output_unverified'] : []),
      'codex_imagegen_unavailable'
    ].map(String))
  ];
  let report: any = {
    schema: DOCTOR_IMAGEGEN_REPAIR_SCHEMA,
    generated_at: nowIso(),
    ok: recovered,
    attempted: before?.core_ready !== true,
    apply,
    recovered,
    capability_ready: capabilityReady,
    configuration_ready: capabilityReady,
    configuration_recovered: configurationRecovered,
    route_ready: recovered,
    real_generation_verified: realGenerationVerified,
    evidence_level: realGenerationVerified ? 'real-output' : capabilityReady ? 'configuration' : 'none',
    before,
    after,
    steps,
    communication_test: communicationTest,
    current_task_tool_manifest_verified: false,
    requires_new_task: requiresNewTask,
    blockers,
    manual_actions: recovered ? [] : [
      ...refreshActions,
      ...(!capabilityReady ? [
        `Install/update Codex CLI if missing: npm i -g @openai/codex@latest`,
        `Open Codex App settings and enable image_generation / $imagegen.`,
        `Verify configuration with: codex features list`
      ] : []),
      `Docs: ${CODEX_APP_IMAGE_GENERATION_DOC_URL}`
    ],
    docs_url: CODEX_APP_IMAGE_GENERATION_DOC_URL
  };
  if (input.reportPath !== null) {
    const reportPath = input.reportPath || path.join(root, '.sneakoscope', 'reports', 'doctor-imagegen-repair.json');
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
