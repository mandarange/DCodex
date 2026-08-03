import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initialProgressRecoveryState, recordProgress } from '../../../runtime/progress-recovery/progress-recovery.js';
import { createArchitectureSafeProjection, readLastSafeProjection, serializeSafeProjection, writeSafeProjection } from '../safe-projection.js';

function projection(internalDiagnostic?: unknown) {
  let recovery = initialProgressRecoveryState('a'.repeat(64));
  recovery = recordProgress(recovery, { kind: 'test', id: 'contract-suite', digest: 'b'.repeat(64), observed_at: '2026-08-02T00:00:00.000Z' });
  return createArchitectureSafeProjection({
    verificationTimeMs: 1250, criticalPath: ['contracts', 'proxy', 'catalog'], cacheStatus: 'MISS', cacheReason: 'target_changed',
    intentRisk: 'HEAVY', intentReason: 'effect_security_requires_heavy', recovery, nextAction: 'run_contract_tests', internalDiagnostic
  });
}

test('golden safe projection contains fixed reasons and no secret-bearing fields', () => {
  const serialized = serializeSafeProjection(projection({ diagnostic_id: 'diag_0123456789abcdef' }));
  assert.equal(serialized, '{"schema":"sks.architecture-safe-projection.v1","verification_time_ms":1250,"critical_path":["contracts","proxy","catalog"],"cache":{"status":"MISS","reason":"target_changed"},"retry_count":0,"intent":{"risk":"HEAVY","reason":"effect_security_requires_heavy"},"progress_signal":"test:contract-suite","pause_cause":null,"recovery_attempt":0,"next_action":"run_contract_tests"}');
  assert.doesNotMatch(serialized, /api_key|account_id|request_body|fingerprint|authorization/i);
});

test('malformed internal diagnostics are rejected before serialization', () => {
  assert.throws(() => projection({ nested: { credential_fingerprint: 'forbidden' } }), /prohibited_field/);
  assert.throws(() => projection({ request_body: 'forbidden' }), /prohibited_field/);
});

test('restart restores the last safe projection', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-safe-projection-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'last-safe.json');
  await writeSafeProjection(file, projection());
  assert.deepEqual(await readLastSafeProjection(file), projection());
});
