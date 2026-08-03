import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decideImageReferenceUse } from '../../../image-ux-review/reference-policy/reference-policy.js';
import {
  ExternalTransferPermitRegistry,
  assertReferenceCanPass,
  registerPathImageReference,
  registerUriImageReference,
  revalidateImageReference,
  upsertImageReferenceRegistry
} from '../reference-registry.js';

async function fixture(t: test.TestContext) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-image-reference-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const image = path.join(root, 'screen.png');
  await fsp.writeFile(image, Buffer.from('png-fixture'));
  return { root, image };
}

test('unchanged references validate without copying bytes', async (t) => {
  const setup = await fixture(t);
  const registry = path.join(setup.root, 'mission', 'image-references.json');
  const reference = await registerPathImageReference({ id: 'screen-1', filePath: setup.image, allowedRoots: [setup.root] });
  await upsertImageReferenceRegistry(registry, reference);
  assert.equal((await revalidateImageReference(reference)).status, 'valid');
  assert.deepEqual((await fsp.readdir(path.dirname(registry))).sort(), ['image-references.json']);
  assert.doesNotThrow(() => assertReferenceCanPass(reference));
});

test('changed and missing bytes become expired and cannot HIT/PASS', async (t) => {
  const setup = await fixture(t);
  const reference = await registerPathImageReference({ id: 'screen-1', filePath: setup.image, allowedRoots: [setup.root] });
  await fsp.writeFile(setup.image, Buffer.from('changed-image'));
  const changed = await revalidateImageReference(reference);
  assert.equal(changed.status, 'expired_reference');
  assert.throws(() => assertReferenceCanPass(changed), /cannot_hit_or_pass/);
  await fsp.rm(setup.image);
  assert.equal((await revalidateImageReference(reference)).reason_code, 'image_reference_missing');
});

test('symlink and out-of-root paths fail closed unless the external path is explicit', async (t) => {
  const setup = await fixture(t);
  const outsideRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-image-outside-'));
  t.after(() => fsp.rm(outsideRoot, { recursive: true, force: true }));
  const outside = path.join(outsideRoot, 'outside.png');
  await fsp.writeFile(outside, Buffer.from('outside'));
  await assert.rejects(() => registerPathImageReference({ id: 'outside', filePath: outside, allowedRoots: [setup.root] }), /out_of_root/);
  assert.equal((await registerPathImageReference({ id: 'outside', filePath: outside, allowedRoots: [setup.root], allowOutOfRoot: true })).scope, 'external-explicit');
  const symlink = path.join(setup.root, 'link.png');
  await fsp.symlink(outside, symlink);
  await assert.rejects(() => registerPathImageReference({ id: 'link', filePath: symlink, allowedRoots: [setup.root], allowOutOfRoot: true }), /symlink_forbidden/);
});

test('URI metadata is registered without network and external transfer needs a one-shot permit', () => {
  const reference = registerUriImageReference({
    id: 'remote-1', uri: 'https://example.invalid/image.png', sha256: 'a'.repeat(64), sizeBytes: 10,
    mediaType: 'image/png', consent: 'external-transfer-approved'
  });
  assert.equal(decideImageReferenceUse({ reference, operation: 'external-transfer' }).allowed, false);
  const permits = new ExternalTransferPermitRegistry();
  const permit = permits.issue(reference);
  permits.consume(reference, permit.token);
  assert.throws(() => permits.consume(reference, permit.token), /permit_invalid/);
});
