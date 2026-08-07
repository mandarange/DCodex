import { runProcess } from '../fsx.js';
import {
  CURRENT_CODEX_RUNTIME_CONTRACT,
  NARUTO_REQUIRED_CODEX_VERSION,
  type CodexFeaturePolicy
} from './codex-runtime-contract.js';
import { compareSemverLike, parseCodexVersionText } from './codex-version-policy.js';

export const CODEX_CAPABILITY_MATRIX_SCHEMA = 'sks.codex-capability-matrix.v1' as const;

/** Capabilities SKS already wires — probe or degrade per feature, never invent unused surfaces. */
export const SKS_CODEX_CAPABILITY_IDS = [
  'multi_agent_v2',
  'agents_max_concurrent_threads_per_session',
  'thread_list_search_read',
  'mcp_startup_tool_timeouts',
  'gpt56_terra_luna_sol_routing',
  'exec_mcp_transient_recovery',
  'rollout_token_budget'
] as const;

export type SksCodexCapabilityId = typeof SKS_CODEX_CAPABILITY_IDS[number];

export interface CodexCapabilityState {
  readonly id: SksCodexCapabilityId;
  readonly available: boolean;
  readonly policy: CodexFeaturePolicy;
  readonly evidence: readonly string[];
  readonly blockers: readonly string[];
  readonly update_cta: string | null;
}

export interface CodexCapabilityMatrix {
  readonly schema: typeof CODEX_CAPABILITY_MATRIX_SCHEMA;
  readonly preferred_cli_version: string;
  readonly minimum_supported_version: string;
  readonly detected_version: string | null;
  readonly capabilities: Record<SksCodexCapabilityId, CodexCapabilityState>;
  readonly warnings: readonly string[];
}

const UPDATE_CTA = 'Update Codex CLI to the preferred latest: `sks codex update` or Menu Bar / SKS Center → Update Codex CLI Now.';

export function preferredCodexCliVersion(): string {
  return CURRENT_CODEX_RUNTIME_CONTRACT.preferredCliVersion || CURRENT_CODEX_RUNTIME_CONTRACT.requiredCliVersion;
}

export function softMinimumCodexCliVersion(): string {
  return CURRENT_CODEX_RUNTIME_CONTRACT.minimumSupportedVersion;
}

export function narutoCodexFloorVersion(): string {
  return NARUTO_REQUIRED_CODEX_VERSION;
}

/**
 * Build a capability matrix from detected CLI version + optional help/config text.
 * Version alone never authorizes a feature; presence probes win when provided.
 */
export function buildCodexCapabilityMatrix(input: {
  version?: string | null;
  helpText?: string | null;
  configText?: string | null;
  schemaText?: string | null;
} = {}): CodexCapabilityMatrix {
  const detected = parseCodexVersionText(input.version) || null;
  const help = String(input.helpText || '');
  const config = String(input.configText || '');
  const schema = String(input.schemaText || '');
  const policies = CURRENT_CODEX_RUNTIME_CONTRACT.featurePolicies;
  const warnings: string[] = [];

  if (detected && compareSemverLike(detected, preferredCodexCliVersion()) < 0) {
    warnings.push(
      `detected Codex ${detected} is below preferred ${preferredCodexCliVersion()}; prefer latest via SKS update inducement`
    );
  }

  const multiAgentV2 = resolveMultiAgentV2({ detected, help, config, schema });
  const agentsConcurrency = resolveAgentsConcurrency({ help, config, multiAgentV2: multiAgentV2.available });
  const threadList = resolveBooleanCapability({
    id: 'thread_list_search_read',
    policy: policies.threadListSearchRead || 'probe',
    markers: [/thread\/list/, /searchTerm/, /ThreadSearchResult/],
    sources: [schema, help]
  });
  const mcpTimeouts = resolveBooleanCapability({
    id: 'mcp_startup_tool_timeouts',
    policy: policies.mcpStartupToolTimeouts || 'wrap',
    markers: [/startup_timeout_sec/, /tool_timeout_sec/],
    sources: [help, config],
    // SKS owns MCP timeout knobs regardless of help text; treat as always wrap-available.
    forceAvailable: true
  });
  const gpt56 = resolveBooleanCapability({
    id: 'gpt56_terra_luna_sol_routing',
    policy: policies.gpt56TerraLunaSolRouting || 'delegate',
    markers: [/gpt-5\.6-(?:luna|terra|sol)/],
    sources: [help, config],
    // SKS model-policy matrix is package-owned; available when CLI is present enough to run.
    forceAvailable: Boolean(detected)
  });
  const execMcp = resolveBooleanCapability({
    id: 'exec_mcp_transient_recovery',
    policy: policies.execMcpTransientRecovery || 'probe',
    markers: [/mcp.*reconnect|transient|exec_mcp/i],
    sources: [help, schema]
  });
  const rollout = resolveBooleanCapability({
    id: 'rollout_token_budget',
    policy: policies.rolloutTokenBudget || 'probe',
    markers: [/token.?budget|rollout/i],
    sources: [help, schema]
  });

  return {
    schema: CODEX_CAPABILITY_MATRIX_SCHEMA,
    preferred_cli_version: preferredCodexCliVersion(),
    minimum_supported_version: softMinimumCodexCliVersion(),
    detected_version: detected,
    capabilities: {
      multi_agent_v2: multiAgentV2,
      agents_max_concurrent_threads_per_session: agentsConcurrency,
      thread_list_search_read: threadList,
      mcp_startup_tool_timeouts: mcpTimeouts,
      gpt56_terra_luna_sol_routing: gpt56,
      exec_mcp_transient_recovery: execMcp,
      rollout_token_budget: rollout
    },
    warnings
  };
}

/** Naruto requires MA v2; older hosts fail closed with an update CTA (no legacy process runtime). */
export function assertNarutoMultiAgentV2Capability(matrix: CodexCapabilityMatrix): {
  ok: boolean;
  blockers: string[];
  guidance: string[];
} {
  const state = matrix.capabilities.multi_agent_v2;
  if (state.available) {
    return { ok: true, blockers: [], guidance: [] };
  }
  return {
    ok: false,
    blockers: [
      'naruto_requires_multi_agent_v2',
      ...(state.blockers.length ? state.blockers : ['multi_agent_v2_unavailable']),
      'update_codex_cli'
    ],
    guidance: [
      UPDATE_CTA,
      `Naruto needs Codex multi-agent V2 (preferred ${preferredCodexCliVersion()}+; capability floor ${narutoCodexFloorVersion()}+ when present).`
    ]
  };
}

export async function probeCodexHelpText(input: {
  codexBin: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<string> {
  const result = await runProcess(input.codexBin, ['--help'], {
    ...(input.env ? { env: input.env } : {}),
    timeoutMs: input.timeoutMs ?? 5_000,
    maxOutputBytes: 256 * 1024
  }).catch(() => null);
  if (!result || result.code !== 0) return '';
  return `${result.stdout || ''}${result.stderr || ''}`;
}

export async function probeNarutoCodexCapability(input: {
  codexBin: string;
  version?: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  matrix: CodexCapabilityMatrix;
  naruto: ReturnType<typeof assertNarutoMultiAgentV2Capability>;
}> {
  const helpText = await probeCodexHelpText({
    codexBin: input.codexBin,
    ...(input.env ? { env: input.env } : {})
  });
  const matrix = buildCodexCapabilityMatrix({
    ...(input.version !== undefined ? { version: input.version } : {}),
    helpText
  });
  return { matrix, naruto: assertNarutoMultiAgentV2Capability(matrix) };
}

function resolveMultiAgentV2(input: {
  detected: string | null;
  help: string;
  config: string;
  schema: string;
}): CodexCapabilityState {
  const policy = CURRENT_CODEX_RUNTIME_CONTRACT.featurePolicies.multiAgentV2
    || CURRENT_CODEX_RUNTIME_CONTRACT.featurePolicies.multiAgentMode
    || 'delegate';
  const evidence: string[] = [];
  const helpHit = /\bmulti_agent_v2\b/.test(input.help);
  const configHit = /\[features\.multi_agent_v2\]|features\.multi_agent_v2\b/.test(input.config);
  const schemaHit = /\bMultiAgentMode\b|\bmulti_agent_v2\b/.test(input.schema);
  if (helpHit) evidence.push('help_mentions_multi_agent_v2');
  if (configHit) evidence.push('config_mentions_multi_agent_v2');
  if (schemaHit) evidence.push('schema_mentions_multi_agent_v2');

  if (helpHit || configHit || schemaHit) {
    return {
      id: 'multi_agent_v2',
      available: true,
      policy,
      evidence,
      blockers: [],
      update_cta: null
    };
  }

  // Semver hint only when probes are empty: prefer floor, never silent legacy revival.
  if (input.detected && compareSemverLike(input.detected, narutoCodexFloorVersion()) >= 0) {
    return {
      id: 'multi_agent_v2',
      available: true,
      policy,
      evidence: [`version_meets_naruto_floor:${input.detected}`],
      blockers: [],
      update_cta: null
    };
  }

  return {
    id: 'multi_agent_v2',
    available: false,
    policy,
    evidence,
    blockers: input.detected
      ? [`multi_agent_v2_missing_on_codex_${input.detected}`]
      : ['multi_agent_v2_probe_empty'],
    update_cta: UPDATE_CTA
  };
}

function resolveAgentsConcurrency(input: {
  help: string;
  config: string;
  multiAgentV2: boolean;
}): CodexCapabilityState {
  const policy = CURRENT_CODEX_RUNTIME_CONTRACT.featurePolicies.agentsMaxConcurrentThreads || 'delegate';
  const hit = /max_concurrent_threads_per_session/.test(input.help)
    || /max_concurrent_threads_per_session/.test(input.config);
  const available = hit || input.multiAgentV2;
  return {
    id: 'agents_max_concurrent_threads_per_session',
    available,
    policy,
    evidence: hit
      ? ['mentions_max_concurrent_threads_per_session']
      : input.multiAgentV2
        ? ['inferred_from_multi_agent_v2']
        : [],
    blockers: available ? [] : ['agents_max_concurrent_threads_unavailable'],
    update_cta: available ? null : UPDATE_CTA
  };
}

function resolveBooleanCapability(input: {
  id: SksCodexCapabilityId;
  policy: CodexFeaturePolicy;
  markers: RegExp[];
  sources: string[];
  forceAvailable?: boolean;
}): CodexCapabilityState {
  if (input.forceAvailable) {
    return {
      id: input.id,
      available: true,
      policy: input.policy,
      evidence: ['sks_owned_surface'],
      blockers: [],
      update_cta: null
    };
  }
  const joined = input.sources.join('\n');
  const hit = input.markers.some((marker) => marker.test(joined));
  return {
    id: input.id,
    available: hit,
    policy: input.policy,
    evidence: hit ? [`marker_hit:${input.id}`] : [],
    blockers: hit ? [] : [`${input.id}_unavailable`],
    update_cta: hit || input.policy === 'disable' ? null : UPDATE_CTA
  };
}
