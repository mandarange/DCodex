import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const releaseGates = JSON.parse(fs.readFileSync('release-gates.v2.json', 'utf8'));
const scripts = pkg.scripts || {};
const buildManifestWriter = fs.readFileSync('dist/scripts/write-build-manifest.js', 'utf8');
const distRuntimeCheck = fs.readFileSync('dist/scripts/check-dist-runtime.js', 'utf8');
const prepublishVerifier = fs.readFileSync('dist/scripts/prepublish-release-check-or-fast.js', 'utf8');
const npmrc = fs.readFileSync('.npmrc', 'utf8');

test('publish lifecycle supports official npm publish with prepack post-build verification', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.publishConfig?.tag, 'latest');
  assert.match(npmrc, /^tag=latest$/m);
  assert.match(scripts['feature-quality:check'], /--release/);
  assert.doesNotMatch(scripts['feature-quality:check'], /--rc/);
  assert.equal(scripts.prepack, 'node ./dist/scripts/prepublish-release-check-or-fast.js --prepack-build');
  assert.equal(scripts.check, undefined);
  assert.match(scripts['build:incremental'], /tsc -p tsconfig\.build\.json/);
  const buildTsconfig = JSON.parse(fs.readFileSync('tsconfig.build.json', 'utf8'));
  assert.equal(buildTsconfig.compilerOptions.declaration, false);
  assert.equal(buildTsconfig.compilerOptions.declarationMap, false);
  assert.equal(buildTsconfig.compilerOptions.sourceMap, false);
  assert.ok(fs.existsSync('dist/native/sks-menubar/Sources/AppDelegate.swift'));
  assert.ok(fs.existsSync('dist/native/sks-menubar/Resources/AppIcon.icns'));
  for (const checkoutOnlySurface of ['Tests', 'UITests', 'QAFixtures']) {
    assert.equal(
      fs.existsSync(path.join('dist/native/sks-menubar', checkoutOnlySurface)),
      false,
      `built package payload must omit native ${checkoutOnlySurface}`
    );
  }
  for (const file of [
    'TelegramStateLock.swift',
    'TelegramPrivateFileSupport.swift',
    'TelegramPrivateFileStore.swift',
    'TelegramProcessGateway.swift',
    'TelegramRuntimeSupport.swift',
    'TelegramSupport.swift',
    'TelegramTransport.swift'
  ]) {
    assert.ok(
      fs.existsSync(path.join('dist/native/sks-menubar/Sources', file)),
      `published package must include native Telegram source ${file}`
    );
  }
  const packagedTelegramPage = path.join('dist/native/sks-menubar/Sources', 'RemoteCodingViewController.swift');
  assert.ok(fs.existsSync(packagedTelegramPage), 'published package must include the Telegram Control Center page');
  const telegramPageSource = fs.readFileSync(packagedTelegramPage, 'utf8');
  assert.match(telegramPageSource, /Connect with BotFather/);
  assert.match(telegramPageSource, /\["telegram", "setup", "--token-stdin", "--json"\]/);
  assert.match(telegramPageSource, /\["telegram", "pair", "--json"\]/);
  assert.match(telegramPageSource, /\["telegram", "doctor", "--json"\]/);
  assert.doesNotMatch(telegramPageSource, /\borca\b|onorca|stablyai/i);
  assert.ok(pkg.files.includes('dist'), 'published package must include the built Telegram runtime through dist');
  assert.ok(fs.existsSync('dist/core/config-adopt/index.js'));
  assert.ok(fs.existsSync('dist/core/commands/telegram-command.js'));
  assert.ok(fs.existsSync('dist/core/telegram'));
  for (const file of ['access.js', 'client.js', 'confirmation.js', 'doctor.js', 'index.js', 'keychain.js', 'liveness.js', 'poller.js', 'redaction.js', 'types.js']) {
    assert.ok(fs.existsSync(path.join('dist/core/telegram', file)), `built Telegram runtime must include ${file}`);
  }
  assert.equal(fs.existsSync('dist/core/telegram/controller.js'), false, 'published package must not include the retired Telegram controller');
  assert.equal(scripts['release:check'], 'npm run release:check:affected');
  assert.match(scripts['release:check:affected'], /--preset affected/);
  assert.match(scripts['release:check:affected'], /release:ensure-build/);
  assert.doesNotMatch(scripts['release:check:affected'], /build:incremental/);
  assert.doesNotMatch(scripts['release:check:affected'], /release-check-stamp/);
  assert.match(scripts['release:check:confidence'], /--sla 5m/);
  assert.match(scripts['release:check:confidence'], /release:ensure-build/);
  assert.doesNotMatch(scripts['release:check:confidence'], /build:incremental/);
  assert.match(scripts['release:ensure-build'], /release-dist-freshness-check\.js/);
  assert.match(scripts['release:ensure-build'], /dist\/scripts\/release-dist-freshness-check\.js/);
  assert.match(scripts['release:check:full'], /--preset release --full/);
  assert.doesNotMatch(scripts['release:check:full'], /doctor --fix/);
  assert.doesNotMatch(scripts['release:check:full'], /release-check-full-doctor\.json/);
  assert.doesNotMatch(scripts['release:check:full'], /\/tmp\//);
  assert.match(scripts['release:check:full'], /release-check-stamp\.js write/);
  assert.match(scripts['release:check:full'], /release-real-check\.js --skip-release-check/);
  assert.equal(count(scripts['release:check:full'], 'build:clean'), 1);
  assert.equal(count(scripts['release:check:full'], 'npm test --silent'), 1);
  assert.ok(scripts['release:check:full'].indexOf('build:clean') < scripts['release:check:full'].indexOf('npm test --silent'));
  assert.match(scripts['release:check:full'], /release-real-check\.js --skip-release-check && npm run release:dist-freshness --silent && node \.\/dist\/scripts\/release-check-stamp\.js write/);
  assert.match(scripts.prepublishOnly, /prepublish-release-check-or-fast\.js/);
  assert.doesNotMatch(scripts.prepublishOnly, /--block-lifecycle-publish/);
  assert.doesNotMatch(scripts.prepublishOnly, /publish:packlist-performance|release-registry-check/);
  assert.doesNotMatch(prepublishVerifier, /runReleaseCheck/);
  assert.doesNotMatch(prepublishVerifier, /SKS_PREPUBLISH_RELEASE_CHECK_CMD/);
  assert.match(prepublishVerifier, /current authoritative full-release stamp/);
  assert.match(prepublishVerifier, /--prepack-build/);
  assert.match(prepublishVerifier, /npm_command/);
  assert.match(prepublishVerifier, /publish-preflight\.js/);
  assert.match(prepublishVerifier, /check-publish-tag\.js/);
  assert.match(prepublishVerifier, /\['run', 'build'\]/);
  for (const removed of ['publish:dry', 'publish:verify-ignore-scripts', 'publish:prep-ignore-scripts', 'publish:ignore-scripts']) {
    assert.equal(scripts[removed], undefined, `${removed} must not expose a direct-publish path`);
  }
  assert.doesNotMatch(Object.values(scripts).join('\n'), /\bnpm\s+publish\b/);
  assert.ok(pkg.files.some((entry) => entry.includes('publish-preflight.js')), 'publish preflight must ship with the lifecycle verifier');
  for (const required of [
    'release:file-ownership',
    'release:macos-menubar-proof',
    'release:main-push-guard',
    'release:main-push-receipt',
    'release:pack-receipt',
    'runtime:installed-smoke'
  ]) assert.ok(scripts[required], `${required} must be wired`);
  assert.equal(Object.keys(scripts).length <= 101, true, 'package script budget must remain frozen');
  assert.equal(scripts['publish:npm'], undefined);
  assert.equal(scripts['release:publish'], undefined);
  const officialSubagentGates = releaseGates.gates.filter((gate) => gate.command === 'node ./dist/scripts/official-subagent-workflow-check.js');
  assert.deepEqual(officialSubagentGates.map((gate) => gate.id), ['naruto:canonical-stop-gate']);
  const packlistGate = releaseGates.gates.find((gate) => gate.id === 'publish:packlist-performance');
  assert.ok(packlistGate, 'publish:packlist-performance gate must exist');
  assert.equal(packlistGate.cache?.enabled, true, 'packlist proof may be reused only while its required artifacts remain current');
  assert.deepEqual(packlistGate.deps, ['publish:runtime-script-closure']);
  const closureGate = releaseGates.gates.find((gate) => gate.id === 'publish:runtime-script-closure');
  assert.ok(closureGate, 'publish:runtime-script-closure gate must exist');
  assert.equal(closureGate.command, 'node ./dist/scripts/runtime-script-pack-closure-check.js');
  const runtimeManifests = {
    'release-gates.v2.json': 'sks.release-gates.v2',
    'infra-harness-gates.json': 'sks.infra-harness-gates.v1',
    'runtime-required-scripts.json': 'sks.runtime-required-scripts.v1'
  };
  for (const [manifest, schema] of Object.entries(runtimeManifests)) {
    assert.ok(pkg.files.includes(manifest), `installed package must include ${manifest}`);
    assert.equal(JSON.parse(fs.readFileSync(manifest, 'utf8')).schema, schema);
  }
  const commonJsBin = fs.readFileSync('dist/bin/sks.js', 'utf8');
  assert.match(commonJsBin, /const \{ version: PACKAGE_VERSION \} = require\('\.\.\/\.\.\/package\.json'\);/);
  assert.doesNotMatch(commonJsBin, /require\('\.\.\/core\/version\.js'\)/);
});

test('npm pack excludes native checkout-only QA surfaces while retaining required native sources', () => {
  for (const surface of ['Tests', 'UITests', 'QAFixtures']) {
    assert.ok(pkg.files.includes(`!dist/native/**/${surface}`), `package files must exclude native ${surface}`);
  }

  const result = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 20 * 1024 * 1024
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const [pack] = JSON.parse(result.stdout);
  assert.ok(pack && Array.isArray(pack.files), 'npm pack must return a JSON file list');
  const packedPaths = pack.files.map((file) => file.path);
  assert.equal(
    packedPaths.some((packedPath) => /^dist\/native\/.*\/(?:Tests|UITests|QAFixtures)\//.test(packedPath)),
    false,
    'published package must exclude native test and QA fixture sources'
  );
  for (const excludedPath of [
    'scripts/build-clean-atomic.mjs',
    'dist/core/agents/parallel-write-fixture.js',
    'dist/core/ops/upgrade-migration-fixtures.js',
    'dist/core/proof/route-finalizer-fixtures.js'
  ]) {
    assert.equal(packedPaths.includes(excludedPath), false, `published package must exclude ${excludedPath}`);
  }
  for (const requiredPath of [
    'dist/native/sks-menubar/Sources/AppDelegate.swift',
    'dist/native/sks-menubar/Sources/TelegramStateLock.swift',
    'dist/native/sks-menubar/Sources/TelegramTransport.swift',
    'dist/native/sks-menubar/Sources/RemoteCodingViewController.swift',
    'dist/scripts/check-publish-tag.js'
  ]) {
    assert.ok(packedPaths.includes(requiredPath), `published package must include ${requiredPath}`);
  }
});

test('plain lifecycle publish requires release proof instead of being categorically blocked', () => {
  const missingStamp = path.join(os.tmpdir(), `sks-missing-release-stamp-${process.pid}.json`);
  const result = spawnSync(process.execPath, ['./dist/scripts/prepublish-release-check-or-fast.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_lifecycle_event: 'prepublishOnly',
      npm_command: 'publish',
      SKS_RELEASE_STAMP_PATH: missingStamp
    }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /current authoritative full-release stamp/);
  assert.doesNotMatch(result.stderr, /Lifecycle-enabled npm publish is unsupported/);
  assert.doesNotMatch(result.stderr, /Direct npm publish is disabled/);
  assert.doesNotMatch(buildManifestWriter, /generated_at/);
  assert.match(distRuntimeCheck, /build_manifest_generated_at_non_deterministic/);
});

test('actual npm publish lifecycle fails closed in a dirty or detached worktree', () => {
  const result = spawnSync(process.execPath, ['./dist/scripts/prepublish-release-check-or-fast.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_lifecycle_event: 'prepublishOnly',
      npm_command: 'publish'
    }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /"schema": "sks\.publish-preflight\.v1"/);
  assert.match(result.stdout, /"ok": false/);
  assert.match(result.stderr, /npm publish blocked by reproducibility preflight/);
  assert.match(`${result.stdout}\n${result.stderr}`, /publish_requires_main_branch:detached|worktree_not_clean/);
});

test('build-dist CommonJS conversion is byte-idempotent across incremental rebuilds', () => {
  const files = ['dist/bin/sks.js', 'dist/bin/sks-dispatch.js', 'dist/bin/fast-inline.js'];
  runBuildDist();
  const first = Object.fromEntries(files.map((file) => [file, fs.readFileSync(file, 'utf8')]));
  runBuildDist();
  const second = Object.fromEntries(files.map((file) => [file, fs.readFileSync(file, 'utf8')]));
  assert.deepEqual(second, first);
  assert.match(first[files[0]], /require\('\.\.\/\.\.\/package\.json'\)/);
  assert.equal(count(first[files[1]], 'exports.runSks = runSks;'), 1);
  for (const name of ['rootJsonFastInline', 'doctorJsonFastInline', 'narutoHelpJsonFastInline', 'hookUserPromptSubmitPerfInline']) {
    assert.equal(count(first[files[2]], `exports.${name} = ${name};`), 1);
  }
});

function runBuildDist() {
  const result = spawnSync(process.execPath, ['./dist/scripts/build-dist.js'], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function count(text, needle) {
  return text.split(needle).length - 1;
}
