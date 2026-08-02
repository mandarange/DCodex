import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createReleaseStampProof } from '../helpers/release-stamp-proof.mjs';
import { currentDistFreshness } from '../../dist/scripts/lib/ensure-dist-fresh.js';

const root = process.cwd();

test('prepublish wrapper fails closed on a stale stamp without running a release check', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-prepublish-stamp-'));
  const stampPath = path.join(dir, 'release-check-stamp.json');
  const markerPath = path.join(dir, 'unexpected-release-check.txt');
  await fs.writeFile(stampPath, `${JSON.stringify({
    schema: 'sks.release-check-stamp.v2',
    package_name: 'sneakoscope',
    package_version: '0.0.0',
    package_json_sha256: 'stale'
  }, null, 2)}\n`);

  const result = spawnSync(process.execPath, ['./dist/scripts/prepublish-release-check-or-fast.js'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SKS_RELEASE_STAMP_PATH: stampPath,
      SKS_PREPUBLISH_RELEASE_CHECK_CMD: `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')"`
    }
  });

  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /requires a current authoritative full-release stamp/);
  assert.match(result.stderr, /Run `npm run release:check:full` separately/);
  const stamp = JSON.parse(await fs.readFile(stampPath, 'utf8'));
  assert.equal(stamp.package_version, '0.0.0');
  await assert.rejects(fs.access(markerPath));
});

test('prepublish wrapper fails closed when authoritative verification finds drift after the cheap check', async () => {
  const proof = createReleaseStampProof();
  const stampPath = proof.stampPath;
  const write = spawnSync(process.execPath, ['./dist/scripts/release-check-stamp.js', ...proof.writeArgs], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...proof.env }
  });
  assert.equal(write.status, 0, write.stderr || write.stdout);

  const stamp = JSON.parse(await fs.readFile(stampPath, 'utf8'));
  stamp.package_files_sha256 = 'stale';
  await fs.writeFile(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);

  const result = spawnSync(process.execPath, ['./dist/scripts/prepublish-release-check-or-fast.js'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...proof.env
    }
  });

  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"ok":true/);
  assert.match(result.stderr, /Release check stamp failed: release:check stamp is stale/);
  assert.match(result.stderr, /requires a current authoritative full-release stamp/);
  assert.match(result.stderr, /Run `npm run release:check:full` separately/);

  const unchanged = JSON.parse(await fs.readFile(stampPath, 'utf8'));
  assert.equal(unchanged.package_files_sha256, 'stale');
  proof.cleanup();
});

test('prepublish wrapper accepts an equivalent rebuild and still rejects dist digest drift', async (t) => {
  const proof = createReleaseStampProof();
  t.after(() => proof.cleanup());
  const env = { ...process.env, ...proof.env };
  const write = spawnSync(process.execPath, ['./dist/scripts/release-check-stamp.js', ...proof.writeArgs], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.equal(write.status, 0, write.stderr || write.stdout);

  const rebuilt = spawnSync(process.execPath, ['./dist/scripts/prepublish-release-check-or-fast.js', '--prepack-build'], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.equal(rebuilt.status, 0, rebuilt.stderr || rebuilt.stdout);
  const verifiedAfterRebuild = spawnSync(process.execPath, ['./dist/scripts/prepublish-release-check-or-fast.js'], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.equal(verifiedAfterRebuild.status, 0, verifiedAfterRebuild.stderr || verifiedAfterRebuild.stdout);
  assert.match(verifiedAfterRebuild.stdout, /Release check stamp verified/);
  const summaryStat = await fs.stat(proof.summaryPath);
  const buildStampStat = await fs.stat(currentDistFreshness().stamp_path);
  assert.ok(summaryStat.mtimeMs < buildStampStat.mtimeMs);

  const stamp = JSON.parse(await fs.readFile(proof.stampPath, 'utf8'));
  stamp.dist_build_sha256 = '0'.repeat(64);
  await fs.writeFile(proof.stampPath, `${JSON.stringify(stamp, null, 2)}\n`);

  const drifted = spawnSync(process.execPath, ['./dist/scripts/prepublish-release-check-or-fast.js'], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.notEqual(drifted.status, 0, drifted.stderr || drifted.stdout);
  assert.match(drifted.stdout, /"ok":true/);
  assert.match(drifted.stderr, /dist_build_sha256/);
  assert.match(drifted.stderr, /requires a current authoritative full-release stamp/);
});
