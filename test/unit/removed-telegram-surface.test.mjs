import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildFeatureRegistry } from '../../dist/core/feature-registry.js';
import { remoteCommand } from '../../dist/core/commands/remote-command.js';

const root = process.cwd();
const cli = path.join(root, 'dist', 'bin', 'sks.js');

function runCli(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-removed-telegram-'));
  try {
    return spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: path.join(home, '.codex'),
        SKS_CODEX_HOME: path.join(home, '.codex')
      }
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('sks telegram follows the ordinary unknown-command contract', () => {
  const result = runCli(['telegram', 'status', '--json']);

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(
    {
      ok: output.ok,
      status: output.status,
      command: output.command,
      reason: output.reason
    },
    {
      ok: false,
      status: 'blocked',
      command: 'telegram',
      reason: 'unknown_command'
    }
  );
  assert.match(result.stderr, /Unknown command: telegram/);
});

test('Doctor JSON has no Telegram readiness projection', () => {
  const result = runCli(['doctor', '--json']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const output = JSON.parse(result.stdout);

  assert.equal(Object.hasOwn(output, 'telegram_remote'), false);
  assert.equal(JSON.stringify(output).toLowerCase().includes('telegram'), false);
});

test('public feature inventory has no Telegram transport', async () => {
  const registry = await buildFeatureRegistry({ root });
  const serialized = JSON.stringify(registry).toLowerCase();

  assert.equal(registry.source_inventory.cli_command_names.includes('telegram'), false);
  assert.equal(registry.source_inventory.handler_keys.includes('telegram'), false);
  assert.equal(registry.features.some((feature) => feature.id === 'cli-telegram'), false);
  assert.equal(serialized.includes('telegram'), false);
});

test('remote command help presents Paseo as an independent companion', async () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const result = await remoteCommand(['--help']);
    assert.deepEqual(result, { schema: 'sks.remote-command.v2', ok: true, action: 'help' });
  } finally {
    console.log = originalLog;
  }

  const output = lines.join('\n');
  assert.match(output, /separately installed independent companion such as Paseo/);
  assert.doesNotMatch(output, /supported mobile-first integration/i);
});

test('Paseo project config keeps its ordered setup and named npm scripts', () => {
  const paseo = JSON.parse(fs.readFileSync(path.join(root, 'paseo.json'), 'utf8'));
  assert.deepEqual(paseo, {
    worktree: {
      setup: [
        'npm ci --ignore-scripts',
        'npm run build:clean'
      ]
    },
    scripts: {
      build: { command: 'npm run build' },
      typecheck: { command: 'npm run typecheck' },
      test: { command: 'npm run test' },
      'release-check': { command: 'npm run release:check:affected' },
      'release-confidence': { command: 'npm run release:check:confidence' }
    }
  });

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const entry of Object.values(paseo.scripts)) {
    const script = entry.command.replace(/^npm run /, '');
    assert.equal(typeof pkg.scripts[script], 'string', `missing package script: ${script}`);
  }
});

test('npm pack exposes no Telegram command, runtime, or native source', () => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 20 * 1024 * 1024
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const [pack] = JSON.parse(result.stdout);
  assert.ok(pack && Array.isArray(pack.files), 'npm pack must return a JSON file list');
  const telegramPaths = pack.files
    .map((file) => file.path)
    .filter((packedPath) => /(?:^|\/)telegram/i.test(packedPath));
  assert.deepEqual(telegramPaths, []);

  const remoteCodingPath = 'dist/native/sks-menubar/Sources/RemoteCodingViewController.swift';
  assert.ok(pack.files.some((file) => file.path === remoteCodingPath));
  const remoteCodingSource = fs.readFileSync(path.join(root, remoteCodingPath), 'utf8');
  assert.match(remoteCodingSource, /https:\/\/paseo\.sh\//);
  assert.match(remoteCodingSource, /https:\/\/paseo\.sh\/docs/);
  assert.doesNotMatch(remoteCodingSource, /telegram|botfather/i);
});
