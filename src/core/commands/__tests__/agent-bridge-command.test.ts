import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentManifest } from '../../agent-bridge/agent-manifest.js';
import {
  agentBridgeCommand,
  buildAgentBridgeSetupMetadata,
  inspectAgentBridgeHostCapabilities,
  renderAgentBridgeBlockedLines,
  runAgentBridgeContractSmokes
} from '../agent-bridge-command.js';

test('agent-bridge local JSON flag keeps the unknown-subcommand contract byte-compatible', async () => {
  const previousLog = console.log;
  const output: string[] = [];
  console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));
  try {
    const result = await agentBridgeCommand('unknown', ['--json']);
    assert.equal(output.join('\n'), JSON.stringify(result, null, 2));
    assert.deepEqual(result, {
      ok: false,
      error: 'unknown_subcommand:unknown',
      supported: ['setup', 'async']
    });
  } finally {
    console.log = previousLog;
  }
});

test('agent-bridge setup metadata includes compatibility and both manifest/capability digests', () => {
  const manifest = buildAgentManifest();
  const metadata = buildAgentBridgeSetupMetadata(manifest);
  assert.equal(metadata.compatibility, manifest.compatibility);
  assert.equal(metadata.host_capabilities, manifest.host_capabilities);
  assert.equal(metadata.capability_digest, manifest.host_capabilities.capability_digest);
  assert.match(metadata.manifest_digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(metadata.capability_digest, /^sha256:[a-f0-9]{64}$/);
});

test('agent-bridge contract smokes validate status and Naruto help without starting a mission', async () => {
  const manifest = buildAgentManifest();
  const observed: string[][] = [];
  const result = await runAgentBridgeContractSmokes('/fixture/sks.js', manifest, async (_command, args) => {
    observed.push([...args]);
    const commandArgs = args.slice(1);
    const stdout = commandArgs[0] === 'status'
      ? JSON.stringify({ schema: 'sks.status.v1', ok: true })
      : JSON.stringify({
          schema: 'sks.naruto-subagent-workflow.v1',
          ok: true,
          action: 'help',
          workflow: 'official_codex_subagent',
          max_depth: 1,
          commands: ['run', 'status', 'subagents', 'proof', 'parent-summary', 'help']
        });
    return { code: 0, stdout, stderr: '', stdoutBytes: stdout.length, stderrBytes: 0, truncated: false, timedOut: false };
  });

  assert.equal(result.status.ok, true);
  assert.equal(result.naruto_help.ok, true);
  assert.equal(result.status.starts_mission, false);
  assert.equal(result.naruto_help.starts_mission, false);
  assert.deepEqual(observed, [
    ['/fixture/sks.js', 'status', '--json'],
    ['/fixture/sks.js', 'naruto', 'help', '--json']
  ]);
  assert.ok(observed.every((args) => !args.includes('run')));
});

test('agent-bridge Naruto help smoke fails on extra stdout or manifest action drift', async () => {
  const manifest = buildAgentManifest();
  const result = await runAgentBridgeContractSmokes('/fixture/sks.js', manifest, async (_command, args) => {
    const commandArgs = args.slice(1);
    const stdout = commandArgs[0] === 'status'
      ? '{}'
      : `${JSON.stringify({
          schema: 'sks.naruto-subagent-workflow.v1',
          action: 'help',
          workflow: 'official_codex_subagent',
          max_depth: 1,
          commands: ['run']
        })}\n{"extra":true}`;
    return { code: 0, stdout, stderr: '', stdoutBytes: stdout.length, stderrBytes: 0, truncated: false, timedOut: false };
  });
  assert.equal(result.status.ok, true);
  assert.equal(result.naruto_help.ok, false);
  assert.deepEqual(result.naruto_help.issues, ['stdout_not_clean_json_object']);
});

test('agent-bridge production inventory reports actual project MCP capability states without blocking optional gaps', async () => {
  const available = await inspectAgentBridgeHostCapabilities('/fixture/project', {
    inventory: async () => ({
      schema: 'sks.mcp-inventory.v2',
      ok: true,
      scope: 'project',
      source: 'config_toml_static',
      servers: [{
        schema: 'sks.mcp-server-config.v2',
        name: 'acas-tools',
        scope: 'project',
        enabled: true,
        transport: 'stdio',
        command: '/fixture/acas-tools',
        oauth: { supported: null, authenticated: null },
        startup_timeout_sec: 10,
        tool_timeout_sec: 60,
        source_path: '/fixture/project/.codex/config.toml',
        managed_by: 'user',
        legacy_inline_secret_present: false,
        legacy_env_keys: []
      }],
      server_count: 1,
      enabled_count: 1,
      failed_count: 0,
      blockers: [],
      warnings: []
    }),
    health: async () => ({
      schema: 'sks.mcp-health.v1',
      server: 'acas-tools',
      scope: 'project',
      status: 'healthy',
      protocol_version: '2024-11-05',
      tool_count: 5,
      tool_names: [
        'datasource_schema_context',
        'datasource_query_readonly',
        'spreadsheet_create',
        'spreadsheet_inspect',
        'spreadsheet_update'
      ],
      instructions_present: false,
      latency_ms: 1,
      checked_at: '2026-07-19T00:00:00.000Z',
      public_error: null,
      log_ref: null
    })
  } as any, true);

  assert.equal(available.ok, true);
  assert.equal(available.health_status, 'healthy');
  assert.equal(
    available.capabilities.find((entry) => entry.id === 'host.spreadsheet.workbook.v1')?.state,
    'available'
  );
  assert.equal(
    available.capabilities.find((entry) => entry.id === 'host.document.render.v1')?.state,
    'not_requested'
  );

  const absent = await inspectAgentBridgeHostCapabilities('/fixture/project', {
    inventory: async () => ({
      schema: 'sks.mcp-inventory.v2',
      ok: true,
      scope: 'project',
      source: 'config_toml_static',
      servers: [],
      server_count: 0,
      enabled_count: 0,
      failed_count: 0,
      blockers: [],
      warnings: []
    })
  } as any, true);
  assert.equal(absent.ok, true);
  assert.ok(absent.capabilities.every((entry) => entry.state === 'not_requested'));
});

test('agent-bridge inventory stays bounded and does not read project config without operator trust', async () => {
  let calls = 0;
  const runtime = await inspectAgentBridgeHostCapabilities('/fixture/project', {
    inventory: async () => {
      calls += 1;
      throw new Error('untrusted inventory must not run');
    },
    health: async () => {
      calls += 1;
      throw new Error('untrusted health must not run');
    }
  } as any);

  assert.equal(calls, 0);
  assert.equal(runtime.ok, true);
  assert.equal(runtime.health_status, 'untrusted');
  assert.equal(runtime.server_present, false);
  assert.deepEqual(runtime.blockers, []);
  assert.ok(runtime.capabilities.every((entry) => entry.state === 'not_requested'));
});

test('agent-bridge blocked output prioritizes one actionable reason and redacts unsafe detail', () => {
  const lines = renderAgentBridgeBlockedLines([
    'host_artifact_parent_receipts_mismatch',
    'Error: raw MCP response token=secret /Users/operator/project',
    'host_capability_unhealthy:host.spreadsheet.workbook.v1',
    'host_tool_call_not_allowed:spreadsheet_update'
  ]);
  const output = lines.join('\n');

  assert.deepEqual(lines, [
    '상태: 차단',
    '이유: 현재 에이전트에 엑셀 수정 도구가 허용되지 않았습니다.',
    '조치: ACAS 에이전트 도구 권한에서 spreadsheet_update를 허용한 뒤 같은 요청을 다시 실행하세요.',
    '코드: host_tool_call_not_allowed:spreadsheet_update'
  ]);
  assert.doesNotMatch(output, /raw MCP|token=|\/Users\/|secret/);

  assert.deepEqual(renderAgentBridgeBlockedLines([
    'host_artifact_parent_receipts_mismatch',
    'host_tool_response_malformed:datasource_query_readonly'
  ]), [
    '상태: 차단',
    '이유: DB 조회 결과가 SKS가 검증할 수 있는 응답 형식을 따르지 않았습니다.',
    '조치: ACAS Agent를 최신 호환 버전으로 업데이트한 뒤 같은 mission을 재실행하세요.',
    '코드: host_tool_response_malformed:datasource_query_readonly'
  ]);

  assert.match(
    renderAgentBridgeBlockedLines([
      'host_tool_response_malformed:datasource_query_readonly',
      'host_capability_missing:host.datasource.query.readonly.v1'
    ])[3] || '',
    /^코드: host_capability_missing:/
  );
});
