import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  codexCurrentSchemaCachePath,
  detectCodexCurrentCapability
} from '../codex-current-capability.js';
import { CURRENT_CODEX_RUNTIME_CONTRACT } from '../../codex-compat/codex-runtime-contract.js';
import { resolveCodexRuntime } from '../../codex-runtime/resolve-codex-runtime.js';

test('require-real capability probes bypass untrusted schema cache', {
  skip: process.platform === 'win32'
}, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-codex-current-cache-'));
  const codexBin = path.join(root, 'codex');
  try {
    await fsp.writeFile(codexBin, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      // The stub must report the CURRENT contract version: capability
      // detection treats an older CLI as not-current, which is its own
      // blocker, not the cache-bypass behavior under test.
      `  echo "codex-cli ${CURRENT_CODEX_RUNTIME_CONTRACT.requiredCliVersion}"`,
      '  exit 0',
      'fi',
      'echo "schema generation intentionally disabled" >&2',
      'exit 17',
      ''
    ].join('\n'), { mode: 0o755 });

    const runtime = await resolveCodexRuntime({ explicitPath: codexBin, requestedBy: 'cache-adversary-test' });
    assert.ok(runtime.identity);
    const cachePath = codexCurrentSchemaCachePath(root, runtime.identity);
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    await fsp.writeFile(cachePath, `${JSON.stringify({
      ok: true,
      text: [
        'MultiAgentMode', 'budgetLimited', 'indexed', 'thread/list', 'ThreadSearchResult', 'thread/read',
        'plugin/list', 'plugin/install', 'AppListUpdatedNotification', 'subagentStart', 'subagentStop',
        'error', 'mcp', 'remote', 'JSONRPCError'
      ].join(' '),
      sha256: 'attacker-controlled'
    })}\n`);

    const diagnostic = await detectCodexCurrentCapability({ root, codexBin, requireReal: false });
    assert.equal(diagnostic.ok, true);
    assert.equal(diagnostic.probe_mode, 'cached-schema');
    assert.equal(diagnostic.release_authorizing, false);
    assert.equal(diagnostic.feature_states.protocol_schema_generation.certainty, 'discovered');

    const required = await detectCodexCurrentCapability({ root, codexBin, requireReal: true });
    assert.equal(required.ok, false);
    assert.equal(required.probe_mode, 'blocked');
    assert.equal(required.release_authorizing, false);
    assert.ok(required.blockers.includes('codex_current_schema_generation_failed'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
