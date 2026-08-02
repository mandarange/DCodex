#!/usr/bin/env node
// @ts-nocheck
// Publish-time release stamp verifier and prepack build bridge.
//
// `npm publish` verifies the authoritative release stamp before prepack, rebuilds
// dist through the normal prepack lifecycle, then verifies the same stamp again
// before npm creates the publish tarball. Ordinary `npm pack` keeps build-only
// behavior and does not require release authorization.
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function runFastCheck() {
  const result = spawnSync(process.execPath, ['./dist/scripts/prepublish-fast-check.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

function runStampVerify() {
  const result = spawnSync(process.execPath, ['./dist/scripts/release-check-stamp.js', 'verify'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

function runPublishPreflight() {
  const result = spawnSync(process.execPath, ['./dist/scripts/publish-preflight.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

function runPublishTagCheck() {
  const result = spawnSync(process.execPath, ['./dist/scripts/check-publish-tag.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

function runBuild() {
  return spawnSync(npmCmd, ['run', 'build'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit'
  });
}

function failClosed(status = 1) {
  console.error('Prepublish requires a current authoritative full-release stamp.');
  console.error('Run `npm run release:check:full` separately, then rerun the publish command.');
  process.exit(status || 1);
}

function verifyReleaseStamp() {
  if (String(process.env.npm_command || '').toLowerCase() === 'publish') {
    const preflight = runPublishPreflight();
    if (preflight.status !== 0) failClosed(preflight.status);

    const tag = runPublishTagCheck();
    if (tag.status !== 0) failClosed(tag.status);
  }

  const fast = runFastCheck();
  if (fast.status !== 0) failClosed(fast.status);

  const stamp = runStampVerify();
  if (stamp.status !== 0) failClosed(stamp.status);
}

function main() {
  if (process.argv.includes('--prepack-build')) {
    const build = runBuild();
    if (build.status !== 0) process.exit(build.status || 1);
    if (String(process.env.npm_command || '').toLowerCase() === 'publish') verifyReleaseStamp();
    return;
  }
  verifyReleaseStamp();
}

main();
