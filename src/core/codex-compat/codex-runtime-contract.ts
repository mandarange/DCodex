import fs from 'node:fs';
import path from 'node:path';
import { packageRoot } from '../fsx.js';

export const CODEX_RUNTIME_CONTRACT_SCHEMA = 'sks.codex-runtime-contract.v2' as const;

export type CodexFeaturePolicy = 'delegate' | 'probe' | 'wrap' | 'disable';

export interface CodexRuntimeContract {
  readonly schema: typeof CODEX_RUNTIME_CONTRACT_SCHEMA;
  readonly targetTag: string;
  readonly requiredCliVersion: string;
  readonly preferredCliVersion: string;
  readonly sdkVersion: string;
  readonly minimumSupportedVersion: string;
  readonly narutoCapabilityFloorVersion: string;
  readonly protocolMode: 'exec-sdk' | 'app-server-v2';
  readonly dependencySource: 'package.json#dependencies.@openai/codex-sdk';
  readonly featurePolicies: Record<string, CodexFeaturePolicy>;
  readonly requiredRealProbes: readonly string[];
  readonly supportedPlatforms: readonly string[];
}

const sdkVersion = codexSdkDependencyVersion();

export const CURRENT_CODEX_RUNTIME_CONTRACT: CodexRuntimeContract = {
  schema: CODEX_RUNTIME_CONTRACT_SCHEMA,
  targetTag: `rust-v${sdkVersion}`,
  requiredCliVersion: sdkVersion,
  preferredCliVersion: sdkVersion,
  sdkVersion,
  minimumSupportedVersion: sdkVersion,
  narutoCapabilityFloorVersion: sdkVersion,
  protocolMode: 'app-server-v2',
  dependencySource: 'package.json#dependencies.@openai/codex-sdk',
  featurePolicies: {
    multiAgentMode: 'delegate',
    multiAgentV2: 'delegate',
    agentsMaxConcurrentThreads: 'delegate',
    indexedWebSearch: 'probe',
    currentTimeRead: 'wrap',
    threadListSearchRead: 'probe',
    pluginCatalogRefresh: 'probe',
    terminalSubagentErrorPropagation: 'probe',
    execMcpTransientRecovery: 'probe',
    remoteNativeEnvironment: 'probe',
    rolloutTokenBudget: 'probe',
    mcpStartupToolTimeouts: 'wrap',
    gpt56TerraLunaSolRouting: 'delegate',
    mcpPaginatedDiscovery: 'wrap',
    portableAgentPlugins: 'delegate',
    automaticApprovalReview: 'delegate'
  },
  requiredRealProbes: [
    'runtime_identity',
    'protocol_schema_generation',
    'multi_agent_mode_schema',
    'indexed_web_search_schema',
    'current_time_read_schema',
    'thread_list_search_schema',
    'terminal_error_schema',
    'rollout_budget_schema'
  ],
  supportedPlatforms: [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-arm64',
    'win32-x64'
  ]
};

export const NARUTO_REQUIRED_CODEX_VERSION = CURRENT_CODEX_RUNTIME_CONTRACT.narutoCapabilityFloorVersion;

export function codexSdkDependencyVersion(root = packageRoot()): string {
  const packagePath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const value = String(pkg.dependencies?.['@openai/codex-sdk'] || '').trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`@openai/codex-sdk must be an exact semver in ${packagePath}`);
  }
  return value;
}
