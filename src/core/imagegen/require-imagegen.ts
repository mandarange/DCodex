import { detectImagegenCapability } from './imagegen-capability.js';
import { repairCodexImagegen } from '../doctor/imagegen-repair.js';

export async function requireCodexImagegen(root: string, opts: {
  autoRepair?: boolean;
  applyRepair?: boolean;
  codexBin?: string | null;
  timeoutMs?: number;
  home?: string;
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
  configText?: string;
  codexLbEnvText?: string;
} = {}) {
  const capabilityOpts: any = {
    timeoutMs: opts.timeoutMs || 5000
  };
  if (opts.codexBin !== undefined && opts.codexBin !== null) capabilityOpts.codexBin = opts.codexBin;
  if (opts.home !== undefined) capabilityOpts.home = opts.home;
  if (opts.codexHome !== undefined) capabilityOpts.codexHome = opts.codexHome;
  if (opts.env !== undefined) capabilityOpts.env = opts.env;
  if (opts.configText !== undefined) capabilityOpts.configText = opts.configText;
  if (opts.codexLbEnvText !== undefined) capabilityOpts.codexLbEnvText = opts.codexLbEnvText;
  const capability = await detectImagegenCapability(capabilityOpts).catch((err: unknown) => ({
    ok: false,
    core_ready: false,
    blockers: [err instanceof Error ? err.message : String(err)]
  }));
  const capabilityReadyBeforeRepair = imagegenPreflightReady(capability);
  const repair = opts.autoRepair === true && !capabilityReadyBeforeRepair
    ? await repairCodexImagegen({
        root,
        apply: opts.applyRepair === true,
        codexBin: opts.codexBin || null,
        timeoutMs: opts.timeoutMs || 5000
      }).catch((err: unknown) => ({
        ok: false,
        recovered: false,
        blockers: [err instanceof Error ? err.message : String(err)]
      }))
    : null;
  const finalCapability = repair
    ? (repair as any).after || capability
    : capability;
  const capabilityReady = imagegenPreflightReady(finalCapability) || (repair as any)?.capability_ready === true;
  const preflightProvider = (finalCapability as any).core_ready === true
    ? 'codex_app_builtin'
    : codexLbImagegenReady(finalCapability) ? 'codex_lb' : null;
  const currentTaskToolManifestVerified = (repair as any)?.current_task_tool_manifest_verified === true;
  const generatedOutputVerified = (finalCapability as any).real_output_verified_by_capability_check === true
    || (repair as any)?.real_generation_verified === true;
  const routeReady = capabilityReady && (currentTaskToolManifestVerified || generatedOutputVerified);
  const preflightReady = capabilityReady;
  const blockers = preflightReady ? [] : [
    ...new Set([
      ...(((finalCapability as any)?.core_blockers || []).map(String)),
      ...(((finalCapability as any)?.blockers || []).map(String)),
      ...(((repair as any)?.blockers || []).map(String)),
      'codex_imagegen_unavailable'
    ])
  ];
  const completionBlockers = routeReady ? [] : [
    ...new Set([
      ...(!capabilityReady ? blockers : []),
      ...(capabilityReady && !currentTaskToolManifestVerified
        ? ['codex_imagegen_current_task_tool_manifest_unverified']
        : []),
      ...(capabilityReady && !generatedOutputVerified
        ? ['codex_imagegen_real_output_unverified']
        : [])
    ])
  ];
  return {
    ok: preflightReady,
    preflight_ready: preflightReady,
    preflight_only: true,
    preflight_does_not_satisfy_generated_output_proof: true,
    preflight_provider: preflightProvider,
    capability_ready: capabilityReady,
    route_ready: routeReady,
    current_task_tool_manifest_verified: currentTaskToolManifestVerified,
    generated_output_verified: generatedOutputVerified,
    completion_blockers: completionBlockers,
    capability: finalCapability,
    repair,
    blocker: preflightReady ? null : {
      schema: 'sks.codex-imagegen-required-blocker.v1',
      blocker: 'codex_imagegen_unavailable',
      status: 'blocked',
      blockers,
      next_actions: (repair as any)?.manual_actions || [
        ...(capabilityReady ? [] : [
          'Install/update Codex CLI: npm i -g @openai/codex@latest',
          'Open Codex App settings and enable image_generation / $imagegen.',
          'Verify configuration with: codex features list'
        ]),
        'Start a fresh Codex/Work task so $imagegen is present in its tool manifest.',
        'Invoke $imagegen with gpt-image-2 and bind the selected raster output path to route evidence.'
      ]
    },
    blockers
  };
}

function imagegenPreflightReady(capability: any): boolean {
  return capability?.core_ready === true || codexLbImagegenReady(capability);
}

function codexLbImagegenReady(capability: any): boolean {
  return (capability?.codex_lb?.selected === true
      || capability?.codex_lb?.cli_contract === true)
    && capability?.codex_lb?.available === true
    && capability?.codex_lb?.blocker == null;
}
