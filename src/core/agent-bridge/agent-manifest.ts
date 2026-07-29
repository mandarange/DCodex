import {
  COMMAND_MANIFEST_BY_NAME,
  COMMAND_MANIFEST_LITE,
  commandInputSchema,
  commandManifestNames,
  type CommandManifestLiteEntry,
  type CommandNameLite
} from '../../cli/command-manifest-lite.js';
import { nowIso, PACKAGE_VERSION, sha256 } from '../fsx.js';
import { NARUTO_ACTIONS, type CommandRisk } from '../safety/command-contract/types.js';

export type LatencyClass = 'fast' | 'normal' | 'long';

export interface AgentManifestEntry {
  name: string;
  description: string;
  read_only: boolean;
  requires_explicit_opt_in: boolean;
  json_output_supported: boolean;
  latency_class: LatencyClass;
  example_invocation: string;
  maturity: CommandManifestLiteEntry['maturity'];
  contract_schema: 'sks.command-contract.v3';
  risk: CommandRisk;
  remote_allowed: boolean;
  input_schema: Record<string, unknown>;
  required_capabilities: string[];
}

export interface AgentBridgeCompatibility {
  bridge_contract: 'sks.agent-bridge.v1';
  manifest_schema: 'sks.agent-manifest.v2';
  proof_schema: 'sks.naruto-subagent-workflow.v1';
  host_capability_schema: 'sks.host-capabilities.v1';
  package_version: string;
}

export interface HostCapabilityDescriptor {
  id: string;
  provider: 'host_mcp';
  mcp_server: 'acas-tools';
  tool_names: string[];
  side_effect:
    | 'none'
    | 'read'
    | 'external_read'
    | 'workspace_write'
    | 'workspace_read_write'
    | 'network_read_workspace_write'
    | 'network_read_workspace_read_write';
  required_for: string[];
  required: false;
  executable?: false;
}

export interface HostCapabilitiesManifest {
  schema: 'sks.host-capabilities.v1';
  capabilities: HostCapabilityDescriptor[];
  capability_digest: string;
}

export interface AgentManifest {
  schema: 'sks.agent-manifest.v2';
  generated_at: string;
  compatibility?: AgentBridgeCompatibility;
  host_capabilities?: HostCapabilitiesManifest;
  tools: AgentManifestEntry[];
}

export interface CurrentAgentManifest extends AgentManifest {
  compatibility: AgentBridgeCompatibility;
  host_capabilities: HostCapabilitiesManifest;
}

export interface AgentManifestValidation {
  ok: boolean;
  issues: string[];
  expected_names: string[];
  observed_names: string[];
  missing_names: string[];
  unexpected_names: string[];
  duplicate_names: string[];
}

export const HOST_CAPABILITY_DESCRIPTORS: readonly HostCapabilityDescriptor[] = [
  {
    id: 'host.workspace.files.v1',
    provider: 'host_mcp',
    mcp_server: 'acas-tools',
    tool_names: ['read_file', 'write_file', 'edit_file', 'find_workspace_files', 'list_workspace', 'download_url_to_workspace'],
    side_effect: 'network_read_workspace_read_write',
    required_for: ['workspace_file_read', 'workspace_file_write'],
    required: false
  },
  {
    id: 'host.web.capture.v1',
    provider: 'host_mcp',
    mcp_server: 'acas-tools',
    tool_names: ['capture_url_screenshot'],
    side_effect: 'network_read_workspace_write',
    required_for: ['web_capture'],
    required: false
  },
  {
    id: 'host.document.render.v1',
    provider: 'host_mcp',
    mcp_server: 'acas-tools',
    tool_names: ['html_to_pdf', 'html_to_screenshot'],
    side_effect: 'workspace_write',
    required_for: ['document_render'],
    required: false
  },
  {
    id: 'host.datasource.schema.v1',
    provider: 'host_mcp',
    mcp_server: 'acas-tools',
    tool_names: ['datasource_schema_context'],
    side_effect: 'read',
    required_for: ['datasource_schema', 'datasource_query'],
    required: false
  },
  {
    id: 'host.datasource.query.readonly.v1',
    provider: 'host_mcp',
    mcp_server: 'acas-tools',
    tool_names: ['datasource_query_readonly'],
    side_effect: 'external_read',
    required_for: ['datasource_query'],
    required: false
  },
  {
    id: 'host.spreadsheet.workbook.v1',
    provider: 'host_mcp',
    mcp_server: 'acas-tools',
    tool_names: ['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update'],
    side_effect: 'workspace_read_write',
    required_for: ['spreadsheet_create', 'spreadsheet_edit'],
    required: false
  },
  {
    id: 'host.artifact.receipt.v1',
    provider: 'host_mcp',
    mcp_server: 'acas-tools',
    tool_names: [
      'write_file',
      'edit_file',
      'download_url_to_workspace',
      'capture_url_screenshot',
      'html_to_pdf',
      'html_to_screenshot',
      'spreadsheet_create',
      'spreadsheet_update'
    ],
    side_effect: 'none',
    required_for: ['artifact_delivery'],
    required: false,
    executable: false
  }
];

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function hostCapabilityDigest(capabilities: readonly HostCapabilityDescriptor[]): string {
  const canonical = capabilities
    .map((capability) => ({
      id: String(capability?.id || ''),
      mcp_server: String(capability?.mcp_server || ''),
      tool_names: Array.isArray(capability?.tool_names) ? capability.tool_names.map(String).sort(compareCodePoint) : [],
      side_effect: String(capability?.side_effect || ''),
      required_for: Array.isArray(capability?.required_for) ? capability.required_for.map(String).sort(compareCodePoint) : []
    }))
    .sort((left, right) => compareCodePoint(left.id, right.id));
  return `sha256:${sha256(JSON.stringify(canonical))}`;
}

export function agentManifestDigest(manifest: AgentManifest): string {
  return `sha256:${sha256(JSON.stringify(manifest))}`;
}

function bridgeCompatibility(packageVersion = PACKAGE_VERSION): AgentBridgeCompatibility {
  return {
    bridge_contract: 'sks.agent-bridge.v1',
    manifest_schema: 'sks.agent-manifest.v2',
    proof_schema: 'sks.naruto-subagent-workflow.v1',
    host_capability_schema: 'sks.host-capabilities.v1',
    package_version: packageVersion
  };
}

function hostCapabilitiesManifest(): HostCapabilitiesManifest {
  const capabilities = HOST_CAPABILITY_DESCRIPTORS.map((capability) => ({
    ...capability,
    tool_names: [...capability.tool_names],
    required_for: [...capability.required_for]
  }));
  return {
    schema: 'sks.host-capabilities.v1',
    capabilities,
    capability_digest: hostCapabilityDigest(capabilities)
  };
}

function exampleInvocation(name: string, jsonSupported: boolean): string {
  if (name === 'naruto') return 'sks naruto help --json';
  return jsonSupported ? `sks ${name} --json` : `sks ${name}`;
}

function buildEntry(name: CommandNameLite, command: CommandManifestLiteEntry): AgentManifestEntry {
  const remoteAllowed = command.risk === 'R3' ? false : command.remoteAllowed;
  return {
    name,
    description: command.summary,
    read_only: command.risk === 'R0',
    requires_explicit_opt_in: command.risk === 'R2' || command.risk === 'R3',
    json_output_supported: command.supportsJson,
    latency_class: command.latency,
    example_invocation: exampleInvocation(name, command.supportsJson),
    maturity: command.maturity,
    contract_schema: 'sks.command-contract.v3',
    risk: command.risk,
    remote_allowed: remoteAllowed,
    input_schema: commandInputSchema(command.inputProfile),
    required_capabilities: [...command.requiredCapabilities]
  };
}

export function buildAgentManifest(): CurrentAgentManifest {
  const tools = [...COMMAND_MANIFEST_LITE]
    .sort((left, right) => compareCodePoint(left.name, right.name))
    .map((command) => buildEntry(command.name, command));
  return {
    schema: 'sks.agent-manifest.v2',
    generated_at: nowIso(),
    compatibility: bridgeCompatibility(),
    host_capabilities: hostCapabilitiesManifest(),
    tools
  };
}

export function validateAgentManifest(manifest: unknown): AgentManifestValidation {
  const candidate = manifest as Partial<AgentManifest> | null;
  const expectedNames = commandManifestNames();
  const tools = Array.isArray(candidate?.tools) ? candidate.tools : [];
  const observedNames = tools.map((tool: any) => String(tool?.name || '')).filter(Boolean);
  const observedSet = new Set(observedNames);
  const duplicateNames = [...new Set(observedNames.filter((name, index) => observedNames.indexOf(name) !== index))].sort();
  const missingNames = expectedNames.filter((name) => !observedSet.has(name));
  const unexpectedNames = [...observedSet].filter((name) => !Object.hasOwn(COMMAND_MANIFEST_BY_NAME, name)).sort();
  const sortedNames = [...observedNames].sort();
  const issues: string[] = [];

  if (candidate?.schema !== 'sks.agent-manifest.v2') issues.push('schema');
  if (!candidate?.compatibility || typeof candidate.compatibility !== 'object' || Array.isArray(candidate.compatibility)) {
    issues.push('compatibility');
  } else {
    const compatibility = candidate.compatibility as Partial<AgentBridgeCompatibility>;
    if (compatibility?.bridge_contract !== 'sks.agent-bridge.v1') issues.push('compatibility:bridge_contract');
    if (compatibility?.manifest_schema !== 'sks.agent-manifest.v2') issues.push('compatibility:manifest_schema');
    if (compatibility?.proof_schema !== 'sks.naruto-subagent-workflow.v1') issues.push('compatibility:proof_schema');
    if (compatibility?.host_capability_schema !== 'sks.host-capabilities.v1') issues.push('compatibility:host_capability_schema');
    // Package version is diagnostic metadata only. Its presence is validated,
    // but its value never gates bridge or host-capability compatibility.
    if (typeof compatibility?.package_version !== 'string' || !compatibility.package_version) issues.push('compatibility:package_version');
  }

  if (!candidate?.host_capabilities || typeof candidate.host_capabilities !== 'object' || Array.isArray(candidate.host_capabilities)) {
    issues.push('host_capabilities');
  } else {
    const hostCapabilities = candidate.host_capabilities as Partial<HostCapabilitiesManifest>;
    const capabilities = Array.isArray(hostCapabilities?.capabilities) ? hostCapabilities.capabilities : [];
    if (hostCapabilities?.schema !== 'sks.host-capabilities.v1') issues.push('host_capabilities:schema');
    if (!Array.isArray(hostCapabilities?.capabilities)) issues.push('host_capabilities:capabilities');
    if (hostCapabilities?.capability_digest !== hostCapabilityDigest(capabilities as HostCapabilityDescriptor[])) {
      issues.push('host_capabilities:capability_digest');
    }
    const expectedCapabilities = new Map(HOST_CAPABILITY_DESCRIPTORS.map((capability) => [capability.id, capability]));
    const observedCapabilityIds = new Set<string>();
    for (const capability of capabilities as HostCapabilityDescriptor[]) {
      const id = String(capability?.id || '');
      const expected = expectedCapabilities.get(id);
      if (!id) issues.push('host_capabilities:id:<missing>');
      if (observedCapabilityIds.has(id)) issues.push(`host_capabilities:duplicate:${id || '<missing>'}`);
      observedCapabilityIds.add(id);
      if (capability?.provider !== 'host_mcp') issues.push(`host_capabilities:provider:${id || '<missing>'}`);
      if (capability?.mcp_server !== 'acas-tools') issues.push(`host_capabilities:mcp_server:${id || '<missing>'}`);
      if (capability?.required !== false) issues.push(`host_capabilities:required:${id || '<missing>'}`);
      if (!Array.isArray(capability?.tool_names) || capability.tool_names.length === 0 || capability.tool_names.some((name) => typeof name !== 'string' || !name)) {
        issues.push(`host_capabilities:tool_names:${id || '<missing>'}`);
      }
      if (![
        'none',
        'read',
        'external_read',
        'workspace_write',
        'workspace_read_write',
        'network_read_workspace_write',
        'network_read_workspace_read_write'
      ].includes(String(capability?.side_effect || ''))) {
        issues.push(`host_capabilities:side_effect:${id || '<missing>'}`);
      }
      if (capability?.executable !== undefined && capability.executable !== false) {
        issues.push(`host_capabilities:executable:${id || '<missing>'}`);
      }
      if (!Array.isArray(capability?.required_for) || capability.required_for.length === 0 || capability.required_for.some((name) => typeof name !== 'string' || !name)) {
        issues.push(`host_capabilities:required_for:${id || '<missing>'}`);
      }
      if (!expected) continue;
      if (JSON.stringify([...capability.tool_names].sort(compareCodePoint)) !== JSON.stringify([...expected.tool_names].sort(compareCodePoint))) issues.push(`host_capabilities:tool_names:${id}`);
      if (capability.side_effect !== expected.side_effect) issues.push(`host_capabilities:side_effect:${id}`);
      if (capability.executable !== expected.executable) issues.push(`host_capabilities:executable:${id}`);
      if (JSON.stringify([...capability.required_for].sort(compareCodePoint)) !== JSON.stringify([...expected.required_for].sort(compareCodePoint))) issues.push(`host_capabilities:required_for:${id}`);
    }
    for (const expected of HOST_CAPABILITY_DESCRIPTORS) {
      if (!observedCapabilityIds.has(expected.id)) issues.push(`host_capabilities:missing:${expected.id}`);
    }
  }
  if (!Array.isArray(candidate?.tools)) issues.push('tools');
  if (duplicateNames.length) issues.push(...duplicateNames.map((name) => `duplicate_tool:${name}`));
  if (missingNames.length) issues.push(...missingNames.map((name) => `missing_registry_tool:${name}`));
  if (unexpectedNames.length) issues.push(...unexpectedNames.map((name) => `unexpected_tool:${name}`));
  if (JSON.stringify(observedNames) !== JSON.stringify(sortedNames)) issues.push('tool_order');

  for (const tool of tools) {
    const name = String((tool as any)?.name || '');
    if (!name || typeof (tool as any)?.description !== 'string') issues.push(`invalid_tool_shape:${name || '<missing>'}`);
    if (typeof (tool as any)?.read_only !== 'boolean') issues.push(`invalid_read_only:${name || '<missing>'}`);
    if (typeof (tool as any)?.requires_explicit_opt_in !== 'boolean') issues.push(`invalid_opt_in:${name || '<missing>'}`);
    if (typeof (tool as any)?.json_output_supported !== 'boolean') issues.push(`invalid_json_support:${name || '<missing>'}`);
    if (!['fast', 'normal', 'long'].includes(String((tool as any)?.latency_class || ''))) issues.push(`invalid_latency_class:${name || '<missing>'}`);
    if (typeof (tool as any)?.example_invocation !== 'string' || !(tool as any).example_invocation.startsWith(`sks ${name}`)) issues.push(`invalid_example:${name || '<missing>'}`);
    if ((tool as any)?.contract_schema !== 'sks.command-contract.v3') issues.push(`invalid_contract_schema:${name || '<missing>'}`);
    if (!['R0', 'R1', 'R2', 'R3'].includes(String((tool as any)?.risk || ''))) issues.push(`invalid_risk:${name || '<missing>'}`);
    if (typeof (tool as any)?.remote_allowed !== 'boolean') issues.push(`invalid_remote_allowed:${name || '<missing>'}`);
    if (!(tool as any)?.input_schema || typeof (tool as any).input_schema !== 'object') issues.push(`invalid_input_schema:${name || '<missing>'}`);
  }

  const naruto = tools.find((tool: any) => tool?.name === 'naruto') as any;
  const expectedNaruto = buildEntry('naruto', COMMAND_MANIFEST_BY_NAME.naruto);
  const narutoActions = naruto?.input_schema?.properties?.action?.enum;
  if (JSON.stringify(narutoActions) !== JSON.stringify(NARUTO_ACTIONS)) issues.push('naruto_action_contract_mismatch');
  if (naruto?.risk !== expectedNaruto?.risk || naruto?.risk !== 'R2') issues.push('contract_risk_mismatch:naruto');
  if (naruto?.latency_class !== expectedNaruto?.latency_class || naruto?.latency_class !== 'long') issues.push('contract_latency_mismatch:naruto');
  if (naruto?.json_output_supported !== expectedNaruto?.json_output_supported || naruto?.json_output_supported !== true) issues.push('contract_json_mismatch:naruto');
  if (naruto?.remote_allowed !== expectedNaruto?.remote_allowed || naruto?.remote_allowed !== false) issues.push('contract_remote_mismatch:naruto');
  if (naruto?.requires_explicit_opt_in !== true) issues.push('contract_opt_in_mismatch:naruto');
  if (JSON.stringify(naruto?.input_schema) !== JSON.stringify(expectedNaruto?.input_schema)) issues.push('contract_input_schema_mismatch:naruto');

  return {
    ok: issues.length === 0,
    issues: [...new Set(issues)],
    expected_names: expectedNames,
    observed_names: observedNames,
    missing_names: missingNames,
    unexpected_names: unexpectedNames,
    duplicate_names: duplicateNames
  };
}
