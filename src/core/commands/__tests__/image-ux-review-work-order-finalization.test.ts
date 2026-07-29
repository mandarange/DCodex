import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { imageUxReviewCommand } from '../image-ux-review-command.js';
import { createMission } from '../../mission.js';
import {
  createAndWriteWorkOrderLedgerForPrompt,
  evaluateWorkOrderCoverage,
  readWorkOrderLedger
} from '../../work-order-ledger.js';

test('Image UX proof finalization resolves its work-order ledger instead of leaving pending stop blockers', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-image-ux-work-order-'));
  await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'image-ux-work-order-fixture',
    private: true
  }));
  const created = await createMission(root, {
    mode: 'image-ux-review',
    prompt: 'Review every page and stabilize the UI.'
  });
  await fsp.writeFile(path.join(created.dir, 'decision-contract.json'), JSON.stringify({
    prompt: 'Review every page and stabilize the UI.',
    sealed_hash: `image-ux-work-order-${created.id}`,
    answers: {
      IMAGE_UX_REVIEW_SOURCE_IMAGES: [],
      TARGET_SURFACE: 'fixture',
      REMEDIATION_REQUESTED: true
    }
  }, null, 2));
  await createAndWriteWorkOrderLedgerForPrompt(created.dir, {
    missionId: created.id,
    route: '$Image-UX-Review',
    prompt: 'Review every page and stabilize the UI.'
  });

  const previousCwd = process.cwd();
  const previousExitCode = process.exitCode;
  const previousLog = console.log;
  const previousError = console.error;
  process.chdir(root);
  console.log = () => {};
  console.error = () => {};
  try {
    await imageUxReviewCommand('image-ux-review', [
      'proof',
      created.id,
      '--mock',
      '--json'
    ]);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.chdir(previousCwd);
    process.exitCode = previousExitCode;
  }

  const ledger = await readWorkOrderLedger(created.dir);
  assert.ok(ledger);
  assert.equal(ledger.items[0].status, 'blocked');
  assert.equal(ledger.all_work_items_resolved, true);
  assert.equal(evaluateWorkOrderCoverage(ledger).ok, true);
});
