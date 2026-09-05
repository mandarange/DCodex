import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, exists, nowIso, projectRoot, runProcess, writeJsonAtomic } from '../fsx.js';
import {
  agentManifestDigest,
  buildAgentManifest,
  validateAgentManifest,
  type CurrentAgentManifest
} from '../agent-bridge/agent-manifest.js';
import {
  inspectHostCapabilityRuntime,
  type HostCapabilityRuntime,
  type HostCapabilityRuntimeDependencies
} from '../agent-bridge/host-capability-runtime.js';
import { renderHostCapabilityBlockedLines } from '../agent-bridge/host-capability-policy.js';

const flag = (args: readonly string[] = [], name: string): boolean => args.includes(name);

interface NonInteractiveSmoke {
  ok: boolean;
  command: string;
  exit_code: number | null;
  note: string;
  issues: string[];
  starts_mission: false;
}

async function resolveSksEntrypoint(): Promise<string> {
  // Mirrors src/core/agent-bridge/mcp-server.ts's own bin resolution: prefer the
  // packaged dist entrypoint, fall back to the source-tree relative path in dev.
  const packedBin = fileURLToPath(new URL('../../bin/sks.js', import.meta.url));
  const sourceBin = fileURLToPath(new URL('../../../bin/sks.js', import.meta.url));
  return (await exists(packedBin)) ? packedBin : sourceBin;
}

async function runJsonSmoke(
  entrypoint: string,
  args: readonly string[],
  validate: (value: Record<string, unknown>) => string[],
  run: typeof runProcess
): Promise<NonInteractiveSmoke> {
  const result = await run(process.execPath, [entrypoint, ...args], {
    env: { SKS_AGENT_MODE: '1' },
    timeoutMs: 15_000,
    // Status is intentionally bounded but can exceed 32 KiB when several
    // session summaries are present. Truncating otherwise-valid JSON makes the
    // bridge report a false non-interactive failure.
    maxOutputBytes: 512 * 1024
  }).catch((err: unknown) => ({ code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }));
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(result.stdout);
    parsed = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    parsed = null;
  }
  const issues = parsed ? validate(parsed) : ['stdout_not_clean_json_object'];
  if (result.code !== 0) issues.push(`exit_code:${String(result.code)}`);
  return {
    ok: result.code === 0 && issues.length === 0,
    command: `SKS_AGENT_MODE=1 ${entrypoint} ${args.join(' ')}`,
    exit_code: result.code,
    note: issues.length === 0
      ? 'stdout parsed as one clean JSON object with SKS_AGENT_MODE=1 set.'
      : `non-interactive JSON contract failed: ${issues.join(', ')}`,
    issues,
    starts_mission: false
  };
}

export async function runAgentBridgeContractSmokes(
  entrypoint: string,
  manifest: CurrentAgentManifest,
  run: typeof runProcess = runProcess
): Promise<{ status: NonInteractiveSmoke; naruto_help: NonInteractiveSmoke }> {
  const naruto = manifest.tools.find((tool) => tool.name === 'naruto');
  const manifestActions = (naruto?.input_schema as any)?.properties?.action?.enum;
  const [status, narutoHelp] = await Promise.all([
    runJsonSmoke(entrypoint, ['status', '--json'], () => [], run),
    runJsonSmoke(entrypoint, ['naruto', 'help', '--json'], (value) => {
      const issues: string[] = [];
      if (value.schema !== 'sks.naruto-subagent-workflow.v1') issues.push('naruto_help_schema');
      if (value.action !== 'help') issues.push('naruto_help_action');
      if (value.workflow !== 'official_codex_subagent') issues.push('naruto_help_workflow');
      if (value.max_depth !== 1) issues.push('naruto_help_max_depth');
      if (JSON.stringify(value.commands) !== JSON.stringify(manifestActions)) issues.push('naruto_help_manifest_actions');
      return issues;
    }, run)
  ]);
  return { status, naruto_help: narutoHelp };
}

function registrationSnippets(): Record<string, unknown> {
  return {
    generic_mcp_host: { command: 'sks', args: ['mcp-server'] },
    codex_cli: 'codex mcp add sks -- sks mcp-server',
    non_interactive_cli: {
      env: { SKS_AGENT_MODE: '1' },
      example: 'SKS_AGENT_MODE=1 sks status --json',
      streaming_example: 'SKS_AGENT_MODE=1 sks qa-loop run <mission> --mock --stream --json'
    }
  };
}

export function buildAgentBridgeSetupMetadata(manifest: CurrentAgentManifest): {
  compatibility: CurrentAgentManifest['compatibility'];
  host_capabilities: CurrentAgentManifest['host_capabilities'];
  manifest_digest: string;
  capability_digest: string;
} {
  return {
    compatibility: manifest.compatibility,
    host_capabilities: manifest.host_capabilities,
    manifest_digest: agentManifestDigest(manifest),
    capability_digest: manifest.host_capabilities.capability_digest
  };
}

export async function inspectAgentBridgeHostCapabilities(
  root: string,
  dependencies?: HostCapabilityRuntimeDependencies,
  projectTrusted: boolean = false
): Promise<HostCapabilityRuntime> {
  return inspectHostCapabilityRuntime({
    root,
    request: { capability_ids: [], workflows: [] },
    projectTrusted,
    ...(dependencies ? { dependencies } : {})
  });
}

export function usage(): string {
  return [
    'Usage: sks agent-bridge setup [--trusted-project] [--json]',
    '       sks agent-bridge async --prompt "task" [--tools status,stats] [--json]',
    '',
    'setup: register read-only SKS tools with an external agent host.',
    'async: run native Astra Async tool calling through the registered Codex-LB bridge.',
    'Only selected remote-readable R0 tools are exposed; JSON reports observed async behavior.'
  ].join('\n');
}

export async function agentBridgeCommand(subcommand: string, args: readonly string[] = []): Promise<unknown> {
  const sub = subcommand || 'setup';
  if (sub === 'async') return (await import('../agent-bridge/async-command.js')).agentBridgeAsyncCommand(args);
  if (sub !== 'setup') {
    const result = { ok: false, error: `unknown_subcommand:${sub}`, supported: ['setup', 'async'] };
    if (flag(args as any, '--json')) console.log(JSON.stringify(result, null, 2));
    else for (const line of renderAgentBridgeBlockedLines([result.error])) console.error(line);
    return result;
  }

  const root = await projectRoot();
  const manifest = buildAgentManifest();
  const manifestValidation = validateAgentManifest(manifest);
  const setupMetadata = buildAgentBridgeSetupMetadata(manifest);
  const manifestPath = path.join(root, '.sneakoscope', 'agent-bridge', 'manifest.json');
  if (!manifestValidation.ok) {
    const result = {
      schema: 'sks.agent-bridge-setup.v1',
      generated_at: nowIso(),
      ok: false,
      status: 'manifest_validation_failed',
      manifest_path: manifestPath,
      ...setupMetadata,
      manifest_validation: manifestValidation
    };
    process.exitCode = 1;
    if (flag(args as any, '--json')) console.log(JSON.stringify(result, null, 2));
    else for (const line of renderAgentBridgeBlockedLines([result.status, ...manifestValidation.issues])) console.error(line);
    return result;
  }
  await ensureDir(path.dirname(manifestPath));
  await writeJsonAtomic(manifestPath, manifest);

  const entrypoint = await resolveSksEntrypoint();
  const [smokes, hostCapabilityInventory] = await Promise.all([
    runAgentBridgeContractSmokes(entrypoint, manifest),
    inspectAgentBridgeHostCapabilities(root, undefined, flag(args as any, '--trusted-project'))
  ]);

  const result = {
    schema: 'sks.agent-bridge-setup.v1',
    generated_at: nowIso(),
    ok: smokes.status.ok && smokes.naruto_help.ok,
    manifest_path: manifestPath,
    tool_count: manifest.tools.length,
    ...setupMetadata,
    manifest_validation: manifestValidation,
    registration_snippets: registrationSnippets(),
    non_interactive_smoke: smokes.status,
    naruto_help_smoke: smokes.naruto_help,
    host_capability_inventory: hostCapabilityInventory
  };
  if (!result.ok) process.exitCode = 1;

  if (flag(args as any, '--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (!result.ok) {
      for (const line of renderAgentBridgeBlockedLines(agentBridgeBlockers(result))) console.error(line);
      return result;
    }
    console.log(`Agent bridge manifest written: ${manifestPath} (${manifest.tools.length} tools)`);
    console.log('Register with a generic MCP host:');
    console.log(`  ${JSON.stringify(registrationSnippets().generic_mcp_host)}`);
    console.log('Register with Codex CLI:');
    console.log(`  ${registrationSnippets().codex_cli}`);
    console.log(`Non-interactive status smoke: ${smokes.status.ok ? 'ok' : 'FAILED'} (${smokes.status.note})`);
    console.log(`Naruto help contract smoke: ${smokes.naruto_help.ok ? 'ok' : 'FAILED'} (${smokes.naruto_help.note})`);
    console.log(`Host capability inventory: ${hostCapabilityInventory.health_status} (${hostCapabilityInventory.capabilities.filter((entry) => entry.state === 'available').length}/${hostCapabilityInventory.capabilities.length} available)`);
  }
  return result;
}

export function renderAgentBridgeBlockedLines(blockers: readonly unknown[]): string[] {
  return renderHostCapabilityBlockedLines(blockers, {
    reason: 'Agent Bridge 설정이 완료 조건을 충족하지 못했습니다.',
    action: '세부 코드를 확인해 가장 먼저 표시된 원인을 해결한 뒤 다시 실행하세요.'
  });
}

function agentBridgeBlockers(result: any): unknown[] {
  return [
    ...(!result.non_interactive_smoke?.ok ? ['agent_bridge_status_smoke_failed', ...(result.non_interactive_smoke?.issues || [])] : []),
    ...(!result.naruto_help_smoke?.ok ? ['agent_bridge_naruto_help_smoke_failed', ...(result.naruto_help_smoke?.issues || [])] : []),
    ...(result.host_capability_inventory?.blockers || [])
  ];
}
