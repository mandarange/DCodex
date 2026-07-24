// First import: this suite spawns the real codex binary, which writes
// $HOME/.codex/tmp lock files when the default home leaks through.
import '../../dist/core/__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  discoverCodexAppGeneratedImage,
  codexAppGeneratedImagesDir
} from '../../dist/core/image-ux-review/codex-app-generated-image-discovery.js';
import { createCodexAppImagegenAdapter, buildCalloutPrompt } from '../../dist/core/image-ux-review/imagegen-adapter.js';

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l/5gVQAAAABJRU5ErkJggg==', 'base64');

async function makeCodexHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-home-'));
  const genDir = codexAppGeneratedImagesDir({ codexHome: home });
  return { home, genDir };
}

async function writeGeneratedImage(genDir, sessionId, name, bytes, mtimeMs) {
  const dir = path.join(genDir, sessionId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, bytes);
  if (mtimeMs) await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

test('discovers the newest fresh Codex App generated image (ig_*.png)', async () => {
  const { home, genDir } = await makeCodexHome();
  const now = 1_000_000_000_000;
  await writeGeneratedImage(genDir, 'sess-old', 'ig_old.png', PNG_1PX, now - 5_000_000);
  const fresh = await writeGeneratedImage(genDir, 'sess-new', 'ig_new.png', PNG_1PX, now - 1000);

  const result = await discoverCodexAppGeneratedImage({ codexHome: home, nowMs: now, sinceMs: now - 60_000 });
  assert.equal(result.ok, true);
  assert.equal(result.selected.path, fresh);
  assert.equal(result.candidates_considered, 2);
});

test('rejects an image that predates the run start (since guard)', async () => {
  const { home, genDir } = await makeCodexHome();
  const now = 1_000_000_000_000;
  await writeGeneratedImage(genDir, 'sess-stale', 'ig_stale.png', PNG_1PX, now - 120_000);

  const result = await discoverCodexAppGeneratedImage({ codexHome: home, nowMs: now, sinceMs: now - 60_000 });
  assert.equal(result.ok, false);
  assert.equal(result.rejected_reason, 'newest_image_predates_run_start');
});

test('rejects an image older than the max-age guard when no since given', async () => {
  const { home, genDir } = await makeCodexHome();
  const now = 1_000_000_000_000;
  await writeGeneratedImage(genDir, 'sess', 'ig_x.png', PNG_1PX, now - 20 * 60 * 1000);

  const result = await discoverCodexAppGeneratedImage({ codexHome: home, nowMs: now, maxAgeMs: 10 * 60 * 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.rejected_reason, 'newest_image_older_than_max_age');
});

test('ignores non-ig files and reports missing directory', async () => {
  const { home, genDir } = await makeCodexHome();
  const now = 1_000_000_000_000;
  // A non-ig file must be ignored even if fresh.
  await writeGeneratedImage(genDir, 'sess', 'screenshot.png', PNG_1PX, now - 1000);
  const onlyOther = await discoverCodexAppGeneratedImage({ codexHome: home, nowMs: now });
  assert.equal(onlyOther.ok, false);
  assert.equal(onlyOther.rejected_reason, 'no_generated_images_found');

  const missing = await discoverCodexAppGeneratedImage({ codexHome: path.join(home, 'nope'), nowMs: now });
  assert.equal(missing.ok, false);
  assert.equal(missing.rejected_reason, 'generated_images_dir_missing');
});

test('codex-app adapter auto-discovers the GUI generated image without manual attach', async () => {
  const { home, genDir } = await makeCodexHome();
  const now = 1_000_000_000_000;
  await writeGeneratedImage(genDir, 'sess', 'ig_auto.png', PNG_1PX, now - 500);
  const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-imagegen-src-'));
  const sourceImage = path.join(sourceDir, 'screen.png');
  await fs.writeFile(sourceImage, PNG_1PX);
  const outputDir = path.join(sourceDir, 'out');

  const adapter = createCodexAppImagegenAdapter({ available: true, codexHome: home, nowMs: now, generatedImageSinceMs: now - 60_000 });
  const result = await adapter.generateCalloutReview({
    mission_id: null,
    source_screen_id: 'screen-1',
    source_image_path: sourceImage,
    output_dir: outputDir,
    prompt: buildCalloutPrompt('screen-1'),
    requested_fidelity: 'original',
    privacy: 'local-only'
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'codex_app_imagegen');
  assert.equal(result.output_source, 'auto_discovered_generated_images');
  assert.ok(result.generated_image_path);
});

test('codex-app adapter blocks honestly when no fresh GUI output exists', async () => {
  const { home } = await makeCodexHome();
  const now = 1_000_000_000_000;
  const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-imagegen-src2-'));
  const sourceImage = path.join(sourceDir, 'screen.png');
  await fs.writeFile(sourceImage, PNG_1PX);

  const adapter = createCodexAppImagegenAdapter({ available: true, codexHome: home, nowMs: now });
  const result = await adapter.generateCalloutReview({
    mission_id: null,
    source_screen_id: 'screen-1',
    source_image_path: sourceImage,
    output_dir: path.join(sourceDir, 'out'),
    prompt: buildCalloutPrompt('screen-1'),
    requested_fidelity: 'original',
    privacy: 'local-only'
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocker, 'codex_app_imagegen_output_missing');
});
