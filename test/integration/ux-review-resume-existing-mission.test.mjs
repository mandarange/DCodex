import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { imageUxReviewCommand } from '../../dist/core/commands/image-ux-review-command.js';
import { createMission } from '../../dist/core/mission.js';
import { PNG_1X1 } from '../helpers/ux-review-1-0-8-fixtures.mjs';

test('attaching a generated image resumes extraction and persists the source-to-generated relation in the same mission', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-ux-resume-existing-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ux-resume-fixture', private: true }));
  const sourceImage = path.join(root, 'source.png');
  const generatedImage = path.join(root, 'generated.png');
  const png = Buffer.from(PNG_1X1, 'base64');
  await fs.writeFile(sourceImage, png);
  await fs.writeFile(generatedImage, png);

  const created = await createMission(root, { mode: 'image-ux-review', prompt: 'resume generated image extraction' });
  const stagedSource = path.join(created.dir, 'source-screens', 'source.png');
  await fs.mkdir(path.dirname(stagedSource), { recursive: true });
  await fs.copyFile(sourceImage, stagedSource);
  const sourceRel = path.relative(root, stagedSource).split(path.sep).join('/');
  await fs.writeFile(path.join(created.dir, 'decision-contract.json'), JSON.stringify({
    prompt: 'resume generated image extraction',
    sealed_hash: `resume-${created.id}`,
    answers: {
      IMAGE_UX_REVIEW_SOURCE_IMAGES: [sourceRel],
      TARGET_SURFACE: 'fixture'
    }
  }, null, 2));

  const previousCwd = process.cwd();
  const previousExtractor = process.env.SKS_TEST_FAKE_EXTRACTOR;
  const previousExitCode = process.exitCode;
  const previousLog = console.log;
  process.chdir(root);
  process.env.SKS_TEST_FAKE_EXTRACTOR = '1';
  console.log = () => {};
  try {
    const result = await imageUxReviewCommand('ux-review', [
      'attach-generated',
      '--mission',
      created.id,
      '--image',
      generatedImage
    ]);
    assert.equal(result.mission_id, created.id);
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    process.exitCode = previousExitCode;
    if (previousExtractor === undefined) delete process.env.SKS_TEST_FAKE_EXTRACTOR;
    else process.env.SKS_TEST_FAKE_EXTRACTOR = previousExtractor;
  }

  const response = JSON.parse(await fs.readFile(path.join(created.dir, 'image-ux-gpt-image-2-response.json'), 'utf8'));
  const issues = JSON.parse(await fs.readFile(path.join(created.dir, 'image-ux-issue-ledger.json'), 'utf8'));
  const ledger = JSON.parse(await fs.readFile(path.join(created.dir, 'image-voxel-ledger.json'), 'utf8'));
  assert.ok(response.generated_review_image_id);
  assert.equal(issues.generated_image_id, response.generated_review_image_id);
  assert.equal(ledger.relations.length, 1);
  assert.equal(ledger.relations[0].type, 'generated_callout_review_of');
  assert.equal(ledger.relations[0].source_image_id, `${created.id}-screen-1-source`);
  assert.equal(ledger.relations[0].generated_image_id, `${created.id}-${response.generated_review_image_id}`);
});
