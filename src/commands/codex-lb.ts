import path from 'node:path';
import { readText } from '../core/fsx.js';
import type { CodexLbDesktopCapabilityReport } from '../core/codex-lb/capability-types.js';
import type { CodexLbDesktopControllerOptions } from '../core/codex-lb/desktop-controller.js';
import {
  executeBridgeCommand,
  runBridgeCommand,
  type BridgeCommandIo,
  type BridgeCommandRunOptions
} from './bridge.js';

const REMOVAL_VERSION = '8.2.0';

interface CodexLbCompatibilityOptions extends BridgeCommandRunOptions {}

const DEFAULT_IO: BridgeCommandIo = {
  readStdin: async () => {
    let data = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) data += chunk;
    return data;
  },
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  }
};

export function usage(): string {
  return [
    'Usage: sks codex-lb <legacy-action> [options]',
    '',
    '`sks codex-lb` is a deprecated 8.1.3 compatibility facade.',
    'Use `sks bridge --help` for Desktop Bridge runtime, provider, catalog, route, and verification commands.',
    `The facade is scheduled for removal in ${REMOVAL_VERSION}.`
  ].join('\n');
}

export async function run(_command: unknown, args: string[] = []): Promise<Record<string, unknown>> {
  return runCodexLbCompatibilityCommand(args);
}

export async function runCodexLbCompatibilityCommand(
  args: string[] = [],
  options: CodexLbCompatibilityOptions = {}
): Promise<Record<string, unknown>> {
  const action = args[0] || 'status';
  const rest = args.slice(1);
  const mapping = compatibilityMapping(action, rest);
  const metadata = compatibilityMetadata(action, mapping.replacement);
  if (mapping.steps) return runCompatibilitySteps(mapping.steps, metadata, options, rest.includes('--json'));
  return runBridgeCommand(mapping.args, { ...options, metadata });
}

function compatibilityMapping(
  action: string,
  args: string[]
): { args: string[]; replacement: string; steps?: string[][] } {
  const json = args.includes('--json') ? ['--json'] : [];
  const strict = [
    ...(args.includes('--strict') ? ['--strict'] : []),
    ...(args.includes('--require-ready') ? ['--require-ready'] : [])
  ];
  if (action === 'status' || action === 'doctor' || action === 'metrics') {
    return { args: ['status', ...json], replacement: 'sks bridge status' };
  }
  if (
    action === 'check'
    || action === 'connect-test'
    || action === 'health'
    || action === 'verify-chain'
    || action === 'chain'
    || action === 'fast-check'
    || action === 'fast'
    || action === 'verify-fast'
  ) {
    return {
      args: ['verify', '--level', action.includes('fast') ? 'deep' : 'transport', ...strict, ...json],
      replacement: `sks bridge verify --level ${action.includes('fast') ? 'deep' : 'transport'}`
    };
  }
  if (action === 'repair' || action === 'resync' || action === 'login') {
    return { args: ['repair', ...json], replacement: 'sks bridge repair' };
  }
  if (action === 'capabilities') {
    const level = option(args, '--level') || 'shallow';
    return {
      args: ['verify', '--level', level, ...strict, ...json],
      replacement: `sks bridge verify --level ${level}`
    };
  }
  if (action === 'setup' || action === 'reconfigure') {
    const host = option(args, '--host') || option(args, '--base-url') || option(args, '--domain');
    return {
      args: [
        'provider', 'configure', 'codex-lb',
        ...(host ? ['--host', host] : []),
        ...(args.includes('--api-key-stdin') ? ['--api-key-stdin'] : []),
        ...json
      ],
      replacement: 'sks bridge provider configure codex-lb --host <host> --api-key-stdin'
    };
  }
  if (action === 'set-key' || action === 'update-key' || action === 'rotate-key') {
    const host = option(args, '--host') || option(args, '--base-url') || option(args, '--domain');
    return {
      args: [
        'provider', 'configure', 'codex-lb',
        ...(host ? ['--host', host] : []),
        ...(args.includes('--api-key-stdin') ? ['--api-key-stdin'] : []),
        ...json
      ],
      replacement: 'sks bridge provider configure codex-lb --host <host> --api-key-stdin'
    };
  }
  if (
    action === 'use-desktop-full'
    || action === 'use-codex-lb'
    || action === 'use-lb'
    || action === 'use-cli'
  ) {
    return {
      args: [],
      replacement: 'sks bridge provider enable codex-lb && sks bridge route set-default codex-lb',
      steps: [
        ['ensure'],
        ['provider', 'enable', 'codex-lb'],
        ['route', 'set-default', 'codex-lb']
      ]
    };
  }
  if (
    action === 'disable'
    || action === 'release'
    || action === 'unselect'
    || action === 'use-oauth'
    || action === 'use-chatgpt'
    || action === 'use-chatgpt-oauth-only'
  ) {
    return {
      args: ['unmanage', ...(args.includes('--confirm') ? ['--confirm'] : []), ...json],
      replacement: 'sks bridge unmanage --confirm'
    };
  }
  if (action === 'rollback') {
    const receiptId = args.find((entry) => !entry.startsWith('--')) || '';
    return {
      args: ['rollback', ...(receiptId ? [receiptId] : []), ...(args.includes('--confirm') ? ['--confirm'] : []), ...json],
      replacement: 'sks bridge rollback <receipt-id> --confirm'
    };
  }
  if (action === 'migrate-legacy-desktop') {
    return { args: ['ensure', ...json], replacement: 'sks bridge ensure' };
  }
  return {
    args: ['__unsupported_legacy_action__', ...json],
    replacement: 'sks bridge --help'
  };
}

async function runCompatibilitySteps(
  steps: string[][],
  metadata: Readonly<Record<string, unknown>>,
  options: CodexLbCompatibilityOptions,
  json: boolean
): Promise<Record<string, unknown>> {
  const io = options.io || DEFAULT_IO;
  const results: Record<string, unknown>[] = [];
  for (const step of steps) {
    const result = await executeBridgeCommand(step, options);
    results.push(result.output);
    if (result.exit_code !== 0) break;
  }
  const last = results.at(-1) || {
    schema: 'sks.bridge-command-error.v1',
    ok: false,
    execution_ok: false,
    blockers: ['codex_lb_compatibility_sequence_empty']
  };
  const ok = results.length === steps.length && results.every((result) => result.ok !== false);
  const output = {
    ...last,
    ok,
    execution_ok: ok,
    managed_runtime: 'desktop-bridge',
    compatibility_steps: results.map((result, index) => ({
      step: steps[index]?.filter((entry) => entry !== '--json').join(' ') || '',
      ok: result.ok !== false
    })),
    ...metadata
  };
  if (json) io.stdout(`${JSON.stringify(output, null, 2)}\n`);
  else if (ok) io.stdout('codex-lb compatibility facade: completed\n');
  else io.stderr('codex-lb compatibility facade: failed\n');
  if (!ok) io.setExitCode(1);
  return output;
}

function compatibilityMetadata(action: string, replacement: string): Readonly<Record<string, unknown>> {
  return {
    deprecated_command: action,
    replacement_command: replacement,
    managed_runtime: 'desktop-bridge',
    deprecation_removal_version: REMOVAL_VERSION
  };
}

function option(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !String(args[index + 1]).startsWith('--')
    ? String(args[index + 1])
    : null;
}

/** @deprecated 8.1.2 test compatibility; not used by the active command path. */
export function codexLbRestartPostcondition(restart: any = {}, required = false) {
  const performed = restart?.status === 'restarted';
  return { required: Boolean(required), performed, satisfied: !required || performed };
}

/** @deprecated 8.1.2 test compatibility; not used by the active command path. */
export function buildCodexLbDoctorResult(
  status: Record<string, unknown>,
  metrics: Record<string, unknown>,
  deep = false
) {
  const diagnosticOk = status.ok === true;
  return {
    schema: 'sks.codex-lb-doctor.v2',
    ok: diagnosticOk && metrics.ok === true,
    diagnostic_ok: diagnosticOk,
    full_capability_verified: status.full_capability_verified === true,
    deep,
    status,
    metrics
  };
}

/** @deprecated 8.1.2 test compatibility; not used by the active command path. */
export function codexLbSetupCapabilityDiagnosticOk(
  capabilities: CodexLbDesktopCapabilityReport | null
): boolean {
  return capabilities === null
    || (capabilities.overall !== 'blocked' && capabilities.overall !== 'unsupported');
}

/** @deprecated 8.1.2 test compatibility; not used by the active command path. */
export function isCodexLbFastChainVerified(chain: any = {}) {
  return chain.ok === true && chain.skipped !== true;
}

/** @deprecated 8.1.2 test compatibility; not used by the active command path. */
export async function resolveCodexLbFastCheckModel(status: any = {}, env: NodeJS.ProcessEnv = process.env) {
  return resolveCodexLbModel(status, env, { requirePriority: true, blockerPrefix: 'codex_lb_fast_check' });
}

/** @deprecated 8.1.2 test compatibility; not used by the active command path. */
export async function resolveCodexLbHealthModel(status: any = {}, env: NodeJS.ProcessEnv = process.env) {
  return resolveCodexLbModel(status, env, { requirePriority: false, blockerPrefix: 'codex_lb_health' });
}

async function resolveCodexLbModel(status: any = {}, env: NodeJS.ProcessEnv = process.env, opts: any = {}) {
  const explicit = String(env.SKS_CODEX_MODEL || env.CODEX_MODEL || '').trim();
  if (explicit) return { model: explicit, source: env.SKS_CODEX_MODEL ? 'SKS_CODEX_MODEL' : 'CODEX_MODEL', blockers: [] };
  const configPath = String(status.config_path || '').trim();
  const config = configPath ? await readText(configPath, '').catch(() => '') : '';
  const configured = topLevelTomlString(config, 'model');
  if (configured) return { model: configured, source: 'global_config', blockers: [] };
  const home = String(env.HOME || '').trim();
  const configuredCatalogPath = topLevelTomlString(config, 'model_catalog_json');
  const defaultCatalogPath = configPath
    ? path.join(path.dirname(configPath), 'models_cache.json')
    : home ? path.join(home, '.codex', 'models_cache.json') : '';
  const requestedCatalogPath = configuredCatalogPath || defaultCatalogPath;
  if (!requestedCatalogPath) return { model: null, source: null, blockers: [`${opts.blockerPrefix}_model_unselected`] };
  const expandedCatalogPath = requestedCatalogPath.startsWith('~/') && home
    ? path.join(home, requestedCatalogPath.slice(2)) : requestedCatalogPath;
  const catalogPath = path.isAbsolute(expandedCatalogPath)
    ? expandedCatalogPath : path.resolve(path.dirname(configPath), expandedCatalogPath);
  try {
    const payload = JSON.parse(await readText(catalogPath, ''));
    const model = selectCatalogModel(payload, opts.requirePriority === true);
    return model
      ? { model, source: configuredCatalogPath ? 'model_catalog_json' : 'codex_models_cache', blockers: [] }
      : { model: null, source: configuredCatalogPath ? 'model_catalog_json' : 'codex_models_cache', blockers: [`${opts.blockerPrefix}_${opts.requirePriority === true ? 'priority_' : ''}model_unavailable`] };
  } catch {
    return { model: null, source: configuredCatalogPath ? 'model_catalog_json' : 'codex_models_cache', blockers: [`${opts.blockerPrefix}_catalog_invalid`] };
  }
}

function topLevelTomlString(text: string, key: string) {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (topLevel.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*=\\s*"([^"]+)"`))?.[1] || '').trim();
}

function selectCatalogModel(payload: any = {}, requirePriority = false) {
  const models = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : [];
  return models
    .filter((row: any) => row && typeof row === 'object' && row.supported_in_api === true && typeof row.slug === 'string' && row.slug.trim()
      && (!requirePriority || [...(Array.isArray(row.service_tiers) ? row.service_tiers : []), ...(Array.isArray(row.additional_speed_tiers) ? row.additional_speed_tiers : [])]
        .some((tier: any) => normalizeTier(typeof tier === 'string' ? tier : tier?.id) === 'priority')))
    .sort((left: any, right: any) => Number(left.priority ?? Number.MAX_SAFE_INTEGER) - Number(right.priority ?? Number.MAX_SAFE_INTEGER)
      || String(left.slug).localeCompare(String(right.slug)))[0]?.slug || null;
}

/** @deprecated 8.1.2 test compatibility; not used by the active command path. */
export async function fastEvidenceFromChain(chain: any = {}, requestLogPath: any = null) {
  const chainEvidence = chain.service_tier_evidence || {};
  const logRows = requestLogPath ? await readRequestLogRows(String(requestLogPath)) : [];
  const logEvidence = serviceTierEvidenceFromRows(logRows);
  const requested = logEvidence.requested_service_tier || chainEvidence.requested_service_tier || chain.requested_service_tier || null;
  const actual = logEvidence.actual_service_tier || chainEvidence.actual_service_tier || null;
  const effective = logEvidence.effective_service_tier || chainEvidence.effective_service_tier || null;
  return {
    requested_service_tier: requested,
    actual_service_tier: actual,
    effective_service_tier: effective,
    fast_requested: requested === 'priority' || chain.requested_service_tier === 'priority' || chainEvidence.fast_requested === true,
    fast_actual: actual === 'priority' || effective === 'priority' || logEvidence.fast_actual === true || chainEvidence.fast_actual === true,
    chain_evidence: chainEvidence,
    request_log_path: requestLogPath || null,
    request_log_rows: logRows.length
  };
}

async function readRequestLogRows(file: string) {
  const text = await readText(path.isAbsolute(file) ? file : path.resolve(process.cwd(), file), '').catch(() => '');
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.rows)) return parsed.rows;
    if (Array.isArray(parsed?.requests)) return parsed.requests;
    return [parsed];
  } catch {}
  const rows: any[] = [];
  for (const line of text.split(/\r?\n/)) {
    try { if (line.trim()) rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

/** @deprecated 8.1.2 test compatibility; not used by the active command path. */
export function serviceTierEvidenceFromRows(rows: any[] = []) {
  let requested: string | null = null;
  let actual: string | null = null;
  let effective: string | null = null;
  for (const row of rows) {
    requested ||= normalizeTier(row?.requestedServiceTier || row?.requested_service_tier || row?.request?.service_tier || row?.body?.service_tier);
    actual ||= normalizeTier(row?.actualServiceTier || row?.actual_service_tier || row?.response?.actualServiceTier || row?.response?.actual_service_tier);
    effective ||= responseServiceTier(row);
  }
  return {
    requested_service_tier: requested,
    actual_service_tier: actual,
    effective_service_tier: effective,
    fast_actual: actual === 'priority' || effective === 'priority'
  };
}

function responseServiceTier(row: any) {
  const nested = normalizeTier(row?.response?.serviceTier || row?.response?.service_tier || row?.event?.response?.serviceTier || row?.event?.response?.service_tier);
  if (nested) return nested;
  const kind = String(row?.direction || row?.phase || row?.kind || row?.type || '').trim().toLowerCase();
  const responseBody = row?.object === 'response' || /^resp[_-]/i.test(String(row?.id || '')) || Array.isArray(row?.output);
  return responseBody || kind === 'response' || kind === 'inbound' || kind.startsWith('response.')
    ? normalizeTier(row?.serviceTier || row?.service_tier) : null;
}

function normalizeTier(value: unknown) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'fast') return 'priority';
  return text === 'priority' || text === 'default' || text === 'flex' ? text : null;
}

/** @deprecated 8.1.2 test compatibility; not used by the active command path. */
export function controllerOptions(args: any[] = []): CodexLbDesktopControllerOptions {
  const value = (name: string) => option(args.map(String), name);
  const gatewayChoice = args.includes('--compat-bearer')
    ? 'authorization-bearer-compat'
    : value('--gateway-auth') || value('--gateway-auth-transport');
  const gatewayAuthTransport = gatewayChoice === 'bearer-compat'
    || gatewayChoice === 'authorization-bearer'
    || gatewayChoice === 'authorization-bearer-compat'
    ? 'authorization-bearer-compat' as const
    : gatewayChoice === 'custom-header' || gatewayChoice === 'x-codex-lb-api-key'
      ? 'x-codex-lb-api-key' as const
      : undefined;
  const home = value('--home');
  const configPath = value('--config') || value('--config-path');
  const authPath = value('--auth') || value('--auth-path');
  const envPath = value('--env-file') || value('--env-path');
  const metadataPath = value('--metadata') || value('--metadata-path');
  const receiptDir = value('--receipt-dir');
  const routingTruthReceiptPath = value('--routing-truth-receipt');
  return {
    ...(gatewayAuthTransport ? { gatewayAuthTransport } : {}),
    restartApp: args.includes('--restart-app') || args.includes('--restart'),
    networkProbes: !args.includes('--no-network'),
    ...(home ? { home } : {}),
    ...(configPath ? { configPath } : {}),
    ...(authPath ? { authPath } : {}),
    ...(envPath ? { envPath } : {}),
    ...(metadataPath ? { metadataPath } : {}),
    ...(receiptDir ? { receiptDir } : {}),
    ...(routingTruthReceiptPath ? { routingTruthReceiptPath } : {})
  };
}

/** @deprecated 8.1.2 text adapter; active commands emit bridge v3 truth. */
export function formatCodexLbDesktopStatusText(
  status: Record<string, unknown>,
  options: { home?: string } = {}
): string {
  const blockers = Array.isArray(status.blockers) ? status.blockers.map(String) : [];
  const resolution = status.secret_resolution && typeof status.secret_resolution === 'object'
    ? status.secret_resolution as Record<string, unknown>
    : {};
  const sourcePath = typeof resolution.path === 'string'
    ? displayHomePath(resolution.path, options.home || process.env.HOME || '')
    : '';
  const source = `${String(resolution.source || 'missing')}${sourcePath ? ` (${sourcePath})` : ''}`;
  return [
    'SKS Desktop Bridge (legacy codex-lb status adapter)',
    `Runtime: ${String(status.runtime || 'desktop-bridge')}`,
    `State: ${String(status.state || status.overall || 'unknown')}`,
    `Key source: ${source} · keychain: not used · prompt risk: ${String(resolution.prompt_risk || 'none')}`,
    `Full feature verification: ${status.full_feature_verified === true ? 'verified' : 'not verified'}`,
    ...(blockers.length ? ['Blockers:', ...blockers.map((blocker) => `- ${blocker}`)] : [])
  ].join('\n') + '\n';
}

function displayHomePath(file: string, home: string): string {
  const resolved = path.resolve(file);
  const resolvedHome = home ? path.resolve(home) : '';
  return resolvedHome && (resolved === resolvedHome || resolved.startsWith(`${resolvedHome}${path.sep}`))
    ? `~${resolved.slice(resolvedHome.length)}`
    : resolved;
}
