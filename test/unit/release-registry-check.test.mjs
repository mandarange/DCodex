import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pkg = JSON.parse(fsSync.readFileSync('package.json', 'utf8'));
const pkgVersion = pkg.version;

test('release registry check ignores inherited publish dist-tag config', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-release-registry-check-'));
  const bin = path.join(tmp, 'bin');
  const log = path.join(tmp, 'npm-log.jsonl');
  const fakeNpm = path.join(bin, 'npm-fake.mjs');
  await fs.mkdir(bin);
  await fs.writeFile(fakeNpm, `#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
fs.appendFileSync(process.env.SKS_FAKE_NPM_LOG, JSON.stringify({
  args,
  tag: process.env.npm_config_tag || null
}) + '\\n');

if (args[0] === 'pack') {
  console.log(JSON.stringify([{ name: 'sneakoscope', version: '${pkgVersion}' }]));
  process.exit(0);
}

if (args[0] === 'view' && args[1] === 'sneakoscope@latest') {
  console.log(JSON.stringify({ version: '0.9.20', 'dist-tags': { latest: '0.9.20' } }));
  process.exit(0);
}

if (args[0] === 'view' && args[1] === 'sneakoscope@${pkgVersion}') {
  console.error('No match found for version ${pkgVersion}');
  process.exit(1);
}

console.error(\`unexpected fake npm args: \${args.join(' ')}\`);
process.exit(1);
`);
  await fs.chmod(fakeNpm, 0o755);
  await fs.writeFile(path.join(bin, 'npm'), `#!/usr/bin/env sh
exec "${process.execPath}" "${fakeNpm}" "$@"
`);
  await fs.chmod(path.join(bin, 'npm'), 0o755);
  await fs.writeFile(path.join(bin, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${fakeNpm}" %*\r\n`);

  const result = spawnSync(process.execPath, ['dist/scripts/release-registry-check.js', '--require-unpublished'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      SKS_FAKE_NPM_LOG: log,
      npm_config_tag: 'rc'
    }
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Registry metadata check passed/);

  const calls = (await fs.readFile(log, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const viewCalls = calls.filter((call) => call.args[0] === 'view');
  assert.deepEqual(viewCalls.map((call) => call.args[1]), ['sneakoscope@latest', `sneakoscope@${pkgVersion}`]);
  assert.deepEqual(viewCalls.map((call) => call.tag), [null, null]);
});

test('release registry publish auth check blocks unauthenticated npm publish', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-release-registry-auth-check-'));
  const bin = path.join(tmp, 'bin');
  const home = path.join(tmp, 'home');
  await fs.mkdir(bin);
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, '.npmrc'), '//registry.npmjs.org/:_authToken=stale-token\n');
  await writeFakeNpm(bin, `
if (args[0] === 'whoami') {
  console.error('npm ERR! code E401');
  process.exit(1);
}
`);

  const result = spawnSync(process.execPath, ['dist/scripts/release-registry-check.js', '--require-unpublished', '--require-publish-auth'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      HOME: home
    }
  });

  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /npm publish auth is missing or invalid/);
  assert.match(result.stderr, /npm auth config was found/);
  assert.match(result.stderr, /\.npmrc:1/);
  assert.match(result.stderr, /token is expired, revoked, not valid for npmjs\.org, or not publish-capable/);
  assert.match(result.stderr, /npm logout --registry https:\/\/registry\.npmjs\.org\//);
  assert.match(result.stderr, /npm whoami --registry https:\/\/registry\.npmjs\.org\//);
});

test('release registry publish auth check requires npm user to be a maintainer', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-release-registry-maintainer-check-'));
  const bin = path.join(tmp, 'bin');
  await fs.mkdir(bin);
  await writeFakeNpm(bin, `
if (args[0] === 'whoami') {
  console.log(process.env.SKS_FAKE_NPM_USER || 'cdw0424');
  process.exit(0);
}
if (args[0] === 'view' && args[1] === 'sneakoscope' && args[2] === 'maintainers') {
  console.log(JSON.stringify(['cdw0424 <cdw0424@gmail.com>']));
  process.exit(0);
}
`);

  const baseEnv = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    SKS_RELEASE_PUBLISH_AUTH_REPORT_PATH: path.join(tmp, 'release-publish-auth.json')
  };
  const ok = spawnSync(process.execPath, ['dist/scripts/release-registry-check.js', '--require-unpublished', '--require-publish-auth'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: baseEnv
  });
  assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
  assert.match(ok.stdout, /Publish auth check passed: sneakoscope@/);

  const okJsonWhoami = spawnSync(process.execPath, ['dist/scripts/release-registry-check.js', '--require-unpublished', '--require-publish-auth'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...baseEnv, SKS_FAKE_NPM_USER: JSON.stringify('cdw0424') }
  });
  assert.equal(okJsonWhoami.status, 0, `${okJsonWhoami.stdout}\n${okJsonWhoami.stderr}`);
  assert.match(okJsonWhoami.stdout, /Publish auth check passed: sneakoscope@/);

  const blocked = spawnSync(process.execPath, ['dist/scripts/release-registry-check.js', '--require-unpublished', '--require-publish-auth'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...baseEnv, SKS_FAKE_NPM_USER: 'someone-else' }
  });
  assert.equal(blocked.status, 2, `${blocked.stdout}\n${blocked.stderr}`);
  assert.match(blocked.stderr, /authenticated npm user is not a package maintainer/);
  assert.match(blocked.stderr, /npm whoami: someone-else/);
  assert.match(blocked.stderr, /sneakoscope maintainers: cdw0424/);
});

test('release registry trusted-publisher auth validates OIDC context without npm whoami', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-release-registry-oidc-check-'));
  const bin = path.join(tmp, 'bin');
  const log = path.join(tmp, 'npm-log.jsonl');
  await fs.mkdir(bin);
  await writeFakeNpm(bin, `
if (args[0] === 'whoami') {
  console.error('whoami must not run for trusted publishing');
  process.exit(91);
}
`);

  const result = spawnSync(process.execPath, ['dist/scripts/release-registry-check.js', '--require-unpublished', '--require-publish-auth'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      SKS_FAKE_NPM_LOG: log,
      SKS_PUBLISH_AUTH_MODE: 'trusted-publisher',
      GITHUB_ACTIONS: 'true',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REPOSITORY: 'mandarange/Sneakoscope-Codex',
      GITHUB_WORKFLOW_REF: 'mandarange/Sneakoscope-Codex/.github/workflows/publish-npm.yml@refs/heads/main',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'redacted-test-token',
      SKS_RELEASE_PUBLISH_AUTH_REPORT_PATH: path.join(tmp, 'release-publish-auth.json')
    }
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Trusted-publisher environment check passed/);
  const calls = (await fs.readFile(log, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(calls.some((args) => args[0] === 'whoami'), false);
});

test('release registry trusted-publisher auth cannot skip unpublished network checks', () => {
  const result = spawnSync(process.execPath, ['dist/scripts/release-registry-check.js', '--require-unpublished', '--require-publish-auth'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      SKS_SKIP_REGISTRY_NETWORK_CHECK: '1',
      SKS_PUBLISH_AUTH_MODE: 'trusted-publisher',
      GITHUB_ACTIONS: 'true',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REPOSITORY: 'mandarange/Sneakoscope-Codex',
      GITHUB_WORKFLOW_REF: 'mandarange/Sneakoscope-Codex/.github/workflows/publish-npm.yml@refs/heads/main',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'redacted-test-token'
    }
  });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /registry network checks cannot be skipped/);
  assert.doesNotMatch(result.stderr, /redacted-test-token/);
});

async function writeFakeNpm(bin, extraCases = '') {
  const fakeNpm = path.join(bin, 'npm-fake.mjs');
  await fs.writeFile(fakeNpm, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (process.env.SKS_FAKE_NPM_LOG) {
  fs.appendFileSync(process.env.SKS_FAKE_NPM_LOG, JSON.stringify(args) + '\\n');
}

if (args[0] === 'pack') {
  console.log(JSON.stringify([{ name: 'sneakoscope', version: '${pkgVersion}' }]));
  process.exit(0);
}

if (args[0] === 'view' && args[1] === 'sneakoscope@latest') {
  console.log(JSON.stringify({ version: '0.9.20', 'dist-tags': { latest: '0.9.20' } }));
  process.exit(0);
}

if (args[0] === 'view' && args[1] === 'sneakoscope@${pkgVersion}') {
  console.error('No match found for version ${pkgVersion}');
  process.exit(1);
}

${extraCases}

console.error(\`unexpected fake npm args: \${args.join(' ')}\`);
process.exit(1);
`);
  await fs.chmod(fakeNpm, 0o755);
  await fs.writeFile(path.join(bin, 'npm'), `#!/usr/bin/env sh
exec "${process.execPath}" "${fakeNpm}" "$@"
`);
  await fs.chmod(path.join(bin, 'npm'), 0o755);
  await fs.writeFile(path.join(bin, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${fakeNpm}" %*\r\n`);
}
