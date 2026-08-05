#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const mod = await importDist('core/mcp/mcp-tool-policy.js');
const policy = mod.detectMcpToolPolicyFromConfig([
  {
    path: 'fixture.json',
    text: JSON.stringify({
      mcp_servers: {
        docs: {
          transport: 'streamable_http',
          env: { DOCS_TOKEN: 'x' },
          oauth: { client_id: 'fixture' }
        }
      }
    })
  },
  {
    path: 'fixture.toml',
    text: '[mcp_servers.docs_toml]\ntransport = "streamable_http"\n[mcp_servers.docs_toml.env]\nDOCS_TOKEN = "x"\n[mcp_servers.docs_toml.oauth]\nclient_id = "fixture"\n'
  }
]);
const readOnly = mod.classifyMcpToolForConcurrency({ name: 'docs_search', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } });
const destructive = mod.classifyMcpToolForConcurrency({ name: 'docs_delete', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } });
const camelCaseDestructive = mod.classifyMcpToolForConcurrency({ name: 'writeFile', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } });
const namespacedDestructive = mod.classifyMcpToolForConcurrency({ name: 'filesystem.writeFile', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } });
const compacted = mod.compactMcpToolSchema({ type: 'object', properties: { item: { $ref: '#/$defs/Item' } }, $defs: { Item: { type: 'string' } }, description: 'x'.repeat(10000) }, 512);
const compactedDefinitions = mod.compactMcpToolSchema({ type: 'object', properties: { item: { $ref: '#/definitions/Item' } }, definitions: { Item: { type: 'string' } }, description: 'x'.repeat(10000) }, 512);
const report = {
  schema: 'sks.mcp-tool-policy-check.v1',
  ok: true,
  policy,
  readOnly,
  destructive,
  camelCaseDestructive,
  namespacedDestructive,
  compacted,
  compactedDefinitions
};

assertGate(policy.per_server_environment_supported === true, 'MCP policy must detect per-server env targeting', report);
assertGate(policy.streamable_http_oauth_supported === true, 'MCP policy must detect streamable HTTP OAuth', report);
assertGate(policy.servers.some((server) => server.name === 'docs_toml' && server.environment_keys.includes('DOCS_TOKEN')), 'MCP policy must detect nested TOML per-server env tables', report);
assertGate(readOnly.concurrency === 'candidate_parallel_readonly', 'readOnlyHint safe tool should be candidate parallel readonly', report);
assertGate(destructive.concurrency === 'serial_required', 'destructive readOnlyHint tool must remain serial', report);
assertGate(camelCaseDestructive.concurrency === 'serial_required', 'camelCase destructive readOnlyHint tool must remain serial', report);
assertGate(namespacedDestructive.concurrency === 'serial_required', 'namespaced destructive readOnlyHint tool must remain serial', report);
assertGate(compacted.preserved_ref_defs === true, 'schema compaction must preserve $ref/$defs evidence', report);
assertGate(compactedDefinitions.schema.definitions?.Item?.type === 'string', 'schema compaction must preserve definitions refs without moving them to $defs', report);

const out = path.join(root, '.sneakoscope', 'reports', 'mcp-tool-policy.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
emitGate('mcp:tool-policy', { servers: policy.servers.length });
