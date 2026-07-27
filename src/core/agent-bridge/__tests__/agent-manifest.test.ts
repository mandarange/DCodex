import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_MANIFEST_BY_NAME, commandManifestNames } from '../../../cli/command-manifest-lite.js';
import { COMMANDS } from '../../../cli/command-registry.js';
import { PACKAGE_VERSION } from '../../fsx.js';
import { commandContract } from '../../safety/command-contract/index.js';
import {
  HOST_CAPABILITY_DESCRIPTORS,
  buildAgentManifest,
  hostCapabilityDigest,
  validateAgentManifest
} from '../agent-manifest.js';

test('agent manifest is non-empty and schema-tagged', () => {
  const manifest = buildAgentManifest();
  assert.equal(manifest.schema, 'sks.agent-manifest.v1');
  assert.equal(typeof manifest.generated_at, 'string');
  assert.ok(manifest.tools.length > 0);
});

test('agent manifest declares additive contract compatibility and the ACAS host capability pack', () => {
  const manifest = buildAgentManifest();
  assert.deepEqual(
    {
      bridge_contract: manifest.compatibility.bridge_contract,
      manifest_schema: manifest.compatibility.manifest_schema,
      proof_schema: manifest.compatibility.proof_schema,
      host_capability_schema: manifest.compatibility.host_capability_schema
    },
    {
      bridge_contract: 'sks.agent-bridge.v1',
      manifest_schema: 'sks.agent-manifest.v1',
      proof_schema: 'sks.naruto-subagent-workflow.v1',
      host_capability_schema: 'sks.host-capabilities.v1'
    }
  );
  assert.equal(manifest.compatibility.package_version, PACKAGE_VERSION);
  assert.equal(manifest.host_capabilities.schema, 'sks.host-capabilities.v1');
  assert.equal(manifest.host_capabilities.capabilities.length, 7);
  assert.deepEqual(manifest.host_capabilities.capabilities, HOST_CAPABILITY_DESCRIPTORS);
  assert.equal(
    manifest.host_capabilities.capability_digest,
    hostCapabilityDigest(manifest.host_capabilities.capabilities)
  );
  assert.match(manifest.host_capabilities.capability_digest, /^sha256:[a-f0-9]{64}$/);
});

test('host capability digest is canonical and ignores non-contract metadata and package version', () => {
  const manifest: any = buildAgentManifest();
  const originalDigest = manifest.host_capabilities.capability_digest;
  manifest.compatibility.package_version = '999.0.0-observation-only';
  manifest.generated_at = '2099-01-01T00:00:00.000Z';
  manifest.host_capabilities.capabilities = [...manifest.host_capabilities.capabilities]
    .reverse()
    .map((capability: any) => ({
      description: 'not part of the digest contract',
      ...capability,
      tool_names: [...capability.tool_names].reverse(),
      required_for: [...capability.required_for].reverse()
    }));
  assert.equal(hostCapabilityDigest(manifest.host_capabilities.capabilities), originalDigest);
  assert.equal(validateAgentManifest({
    ...manifest,
    host_capabilities: {
      ...manifest.host_capabilities,
      capabilities: manifest.host_capabilities.capabilities,
      capability_digest: hostCapabilityDigest(manifest.host_capabilities.capabilities)
    }
  }).ok, true);
});

test('manifest validation permits a well-formed additive v1 host capability', () => {
  const manifest: any = buildAgentManifest();
  manifest.host_capabilities.capabilities.push({
    id: 'host.future.additive.v1',
    provider: 'host_mcp',
    mcp_server: 'acas-tools',
    tool_names: ['future_read_tool'],
    side_effect: 'read',
    required_for: ['future_read_task'],
    required: false
  });
  manifest.host_capabilities.capability_digest = hostCapabilityDigest(manifest.host_capabilities.capabilities);
  const validation = validateAgentManifest(manifest);
  assert.equal(validation.ok, true, validation.issues.join(', '));
});

test('manifest validation rejects incomplete v1 manifests missing compatibility and host_capabilities', () => {
  const current = buildAgentManifest();
  const priorV1 = {
    schema: current.schema,
    generated_at: current.generated_at,
    tools: current.tools
  };
  const validation = validateAgentManifest(priorV1);
  assert.equal(validation.ok, false, validation.issues.join(', '));
  assert.ok(validation.issues.includes('compatibility'));
  assert.ok(validation.issues.includes('host_capabilities'));
});

test('manifest validation rejects missing compatibility block', () => {
  const manifest: any = buildAgentManifest();
  delete manifest.compatibility;
  const validation = validateAgentManifest(manifest);
  assert.equal(validation.ok, false, validation.issues.join(', '));
  assert.ok(validation.issues.includes('compatibility'));
});

test('manifest validation rejects missing host_capabilities block', () => {
  const manifest: any = buildAgentManifest();
  delete manifest.host_capabilities;
  const validation = validateAgentManifest(manifest);
  assert.equal(validation.ok, false, validation.issues.join(', '));
  assert.ok(validation.issues.includes('host_capabilities'));
});

test('manifest validation rejects stale host capability digest', () => {
  const manifest: any = buildAgentManifest();
  manifest.host_capabilities.capability_digest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  const validation = validateAgentManifest(manifest);
  assert.equal(validation.ok, false, validation.issues.join(', '));
  assert.ok(validation.issues.includes('host_capabilities:capability_digest'));
});

test('manifest validation rejects duplicate host capability ids', () => {
  const manifest: any = buildAgentManifest();
  const duplicate = manifest.host_capabilities.capabilities.find((capability: any) => capability.id === 'host.web.capture.v1');
  manifest.host_capabilities.capabilities.push({ ...duplicate });
  manifest.host_capabilities.capability_digest = hostCapabilityDigest(manifest.host_capabilities.capabilities);
  const validation = validateAgentManifest(manifest);
  assert.equal(validation.ok, false, validation.issues.join(', '));
  assert.ok(validation.issues.includes('host_capabilities:duplicate:host.web.capture.v1'));
});

test('host capability descriptors expose the project MCP Office/Data tool names without executing them', () => {
  const capabilities = buildAgentManifest().host_capabilities.capabilities;
  const names = new Set(capabilities.flatMap((capability) => capability.tool_names));
  for (const expected of [
    'datasource_schema_context',
    'datasource_query_readonly',
    'spreadsheet_create',
    'spreadsheet_inspect',
    'spreadsheet_update'
  ]) {
    assert.ok(names.has(expected), `host capability pack missing project MCP tool ${expected}`);
  }
  assert.equal(
    capabilities.find((capability) => capability.id === 'host.spreadsheet.workbook.v1')?.side_effect,
    'workspace_read_write'
  );
});

test('agent manifest includes well-known confirmed-existing commands', () => {
  const manifest = buildAgentManifest();
  const names = manifest.tools.map((tool) => tool.name);
  for (const expected of ['status', 'doctor']) {
    assert.ok(expected in COMMANDS, `fixture assumption invalid: ${expected} missing from COMMANDS`);
    assert.ok(names.includes(expected), `manifest missing expected command ${expected}`);
  }
});

test('every registry-marked read-only command appears in the manifest as read_only true', () => {
  const manifest = buildAgentManifest();
  const byName = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  const readOnlyNames = Object.entries(COMMANDS)
    .filter(([, command]) => (command as { readonly?: boolean }).readonly === true)
    .map(([name]) => name);

  assert.ok(readOnlyNames.length > 0, 'fixture assumption invalid: no read-only commands found in registry');
  for (const name of readOnlyNames) {
    const tool = byName.get(name);
    assert.ok(tool, `manifest missing registry read-only command ${name}`);
    assert.equal(tool?.read_only, true, `expected ${name} to be read_only in manifest`);
  }
});

test('an explicitly R3 command requires explicit opt-in without name regex inference', () => {
  const manifest = buildAgentManifest();
  const destructiveCandidate = manifest.tools.find((tool) => tool.name.includes('uninstall'));
  assert.ok(destructiveCandidate, 'fixture assumption invalid: no uninstall-family command found in registry');
  assert.equal(destructiveCandidate?.requires_explicit_opt_in, true);
});

test('manifest never fabricates a command name absent from the registry', () => {
  const manifest = buildAgentManifest();
  assert.equal(manifest.tools.some((tool) => tool.name === 'ui'), false);
  for (const tool of manifest.tools) {
    assert.ok(tool.name in COMMANDS, `manifest contains a name not in COMMANDS: ${tool.name}`);
  }
  assert.equal(manifest.tools.length, Object.keys(COMMANDS).length);
});

test('every manifest entry has a well-formed shape', () => {
  const manifest = buildAgentManifest();
  for (const tool of manifest.tools) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.description, 'string');
    assert.equal(typeof tool.read_only, 'boolean');
    assert.equal(typeof tool.requires_explicit_opt_in, 'boolean');
    assert.equal(typeof tool.json_output_supported, 'boolean');
    assert.ok(['fast', 'normal', 'long'].includes(tool.latency_class));
    assert.ok(tool.example_invocation.startsWith(`sks ${tool.name}`));
    assert.equal(tool.contract_schema, 'sks.command-contract.v2');
    assert.ok(['R0', 'R1', 'R2', 'R3'].includes(tool.risk));
    assert.equal(typeof tool.remote_allowed, 'boolean');
    assert.equal(typeof tool.telegram_allowed, 'boolean');
    assert.equal(tool.input_schema.type, 'object');
    assert.equal(tool.input_schema.additionalProperties, false);
  }
});

test('generated manifest exactly matches the command registry in sorted order', () => {
  const manifest = buildAgentManifest();
  const validation = validateAgentManifest(manifest);
  assert.equal(validation.ok, true, validation.issues.join(', '));
  assert.deepEqual(validation.observed_names, Object.keys(COMMANDS).sort());
  assert.deepEqual(validation.missing_names, []);
  assert.deepEqual(validation.unexpected_names, []);
  assert.deepEqual(validation.duplicate_names, []);
});

test('lightweight command metadata stays contract-compatible with the runtime registry', () => {
  const manifest = buildAgentManifest();
  const byName = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(commandManifestNames(), Object.keys(COMMANDS).sort());
  for (const name of commandManifestNames()) {
    const lite = COMMAND_MANIFEST_BY_NAME[name];
    const runtime = COMMANDS[name];
    const contract = commandContract(name);
    const tool = byName.get(name);
    assert.ok(contract, `missing runtime contract for ${name}`);
    assert.ok(tool, `missing agent manifest tool for ${name}`);
    assert.equal(runtime.summary, lite.summary, `summary drift for ${name}`);
    assert.equal(runtime.maturity, lite.maturity, `maturity drift for ${name}`);
    assert.equal(runtime.risk, lite.risk, `risk drift for ${name}`);
    assert.equal(runtime.latency, lite.latency, `latency drift for ${name}`);
    assert.equal(runtime.supportsJson, lite.supportsJson, `JSON support drift for ${name}`);
    assert.equal(runtime.remoteAllowed, lite.remoteAllowed, `Remote policy drift for ${name}`);
    assert.equal(runtime.telegramAllowed, lite.telegramAllowed, `Telegram policy drift for ${name}`);
    assert.equal(runtime.inputProfile, lite.inputProfile, `input profile drift for ${name}`);
    assert.deepEqual(runtime.requiredCapabilities, lite.requiredCapabilities, `capability drift for ${name}`);
    assert.equal(tool?.description, contract?.description, `manifest description drift for ${name}`);
    assert.equal(tool?.risk, contract?.risk, `manifest risk drift for ${name}`);
    assert.equal(tool?.latency_class, contract?.latency, `manifest latency drift for ${name}`);
    assert.equal(tool?.json_output_supported, contract?.supports_json, `manifest JSON drift for ${name}`);
    assert.equal(tool?.remote_allowed, contract?.remote_allowed, `manifest Remote drift for ${name}`);
    assert.equal(tool?.telegram_allowed, contract?.telegram_allowed, `manifest Telegram drift for ${name}`);
    assert.deepEqual(tool?.input_schema, contract?.input_schema, `manifest input schema drift for ${name}`);
    assert.deepEqual(tool?.required_capabilities, contract?.required_capabilities, `manifest capability drift for ${name}`);
  }
});

test('Naruto manifest metadata and actions match the parser help contract', () => {
  const manifest = buildAgentManifest();
  const naruto = manifest.tools.find((tool) => tool.name === 'naruto');
  assert.ok(naruto);
  assert.equal(naruto.risk, 'R2');
  assert.equal(naruto.latency_class, 'long');
  assert.equal(naruto.json_output_supported, true);
  assert.equal(naruto.remote_allowed, false);
  assert.equal(naruto.telegram_allowed, false);
  assert.equal(naruto.requires_explicit_opt_in, true);
  assert.equal(naruto.example_invocation, 'sks naruto help --json');
  assert.deepEqual((naruto.input_schema as any).properties.action.enum, ['run', 'status', 'subagents', 'proof', 'parent-summary', 'help']);
});

test('manifest validation rejects Naruto risk, opt-in, and action drift', () => {
  const manifest: any = buildAgentManifest();
  const naruto = manifest.tools.find((tool: any) => tool.name === 'naruto');
  naruto.risk = 'R1';
  naruto.requires_explicit_opt_in = false;
  naruto.input_schema = {
    ...naruto.input_schema,
    properties: {
      ...naruto.input_schema.properties,
      action: { ...naruto.input_schema.properties.action, enum: ['run', 'status'] }
    }
  };
  const validation = validateAgentManifest(manifest);
  assert.equal(validation.ok, false);
  assert.ok(validation.issues.includes('contract_risk_mismatch:naruto'));
  assert.ok(validation.issues.includes('contract_opt_in_mismatch:naruto'));
  assert.ok(validation.issues.includes('naruto_action_contract_mismatch'));
});

test('manifest validation rejects stale removed commands, missing canonical commands, and duplicates', () => {
  const manifest: any = buildAgentManifest();
  const withoutSuperSearch = manifest.tools.filter((tool: any) => tool.name !== 'super-search');
  manifest.tools = [
    { ...withoutSuperSearch[1] },
    { ...withoutSuperSearch[0] },
    ...withoutSuperSearch.slice(2),
    { ...withoutSuperSearch[0] },
    { ...withoutSuperSearch[0], name: 'db', example_invocation: 'sks db --json' }
  ];

  const validation = validateAgentManifest(manifest);
  assert.equal(validation.ok, false);
  assert.ok(validation.issues.includes('missing_registry_tool:super-search'));
  assert.ok(validation.issues.includes('unexpected_tool:db'));
  assert.ok(validation.issues.some((issue) => issue.startsWith('duplicate_tool:')));
  assert.ok(validation.issues.includes('tool_order'));
});
