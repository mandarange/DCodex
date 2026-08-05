import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { enforceRetention } from '../retention.js';

test('NC-20: closed mission capacity prune writes completion receipt outside mission dir', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-retention-receipt-'));
  const missionId = 'M-20260805-completion-receipt';
  const missionDir = path.join(root, '.sneakoscope', 'missions', missionId);
  await fs.mkdir(missionDir, { recursive: true });
  await fs.writeFile(path.join(missionDir, 'completion-proof.json'), JSON.stringify({
    schema_version: 1,
    status: 'verified',
    blockers: []
  }));

  const result = await enforceRetention(root, {
    dryRun: false,
    policy: {
      prune_old_missions: true,
      max_missions: 0,
      max_mission_age_days: 0,
      compact_inactive_open_mission_workdirs: false,
      compact_closed_mission_workdirs: false
    }
  });
  assert.ok(Array.isArray(result.actions), JSON.stringify(result.actions?.slice?.(0, 20) || result));
  assert.ok(
    result.actions.some((row: any) => row.action === 'write_mission_completion_receipt' || row.action === 'reuse_mission_completion_receipt'),
    JSON.stringify(result.actions)
  );
  const receiptPath = path.join(root, '.sneakoscope', 'retention', 'completion-receipts', `${missionId}.json`);
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.schema, 'sks.mission-completion-receipt.v1');
  assert.equal(receipt.mission_id, missionId);
  assert.equal(receipt.delete_after_receipt, true);
  // Durable missions may be compacted rather than fully deleted; receipt must still exist.
  assert.equal(await fs.access(receiptPath).then(() => true, () => false), true);
});
