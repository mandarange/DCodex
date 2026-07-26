import test from 'node:test';
import assert from 'node:assert/strict';
import { imageUxReviewSourcePreflight } from '../../dist/core/commands/image-ux-review-command.js';

test('a ready Chrome capture route still requires the captured screenshot artifact path', async () => {
  const result = await imageUxReviewSourcePreflight(['--from-chrome-extension'], {
    chromeStatus: async () => ({ ok: true, status: 'ready' })
  });
  assert.equal(result.chromePreflight.ok, true);
  assert.equal(result.result?.ok, false);
  assert.equal(result.result?.blocker, 'captured_screenshot_path_required');
});

test('a ready Chrome capture route accepts a bound screenshot artifact path', async () => {
  const result = await imageUxReviewSourcePreflight(['--from-chrome-extension', '--image', '/tmp/captured-page.png'], {
    chromeStatus: async () => ({ ok: true, status: 'ready' })
  });
  assert.equal(result.result, null);
});
