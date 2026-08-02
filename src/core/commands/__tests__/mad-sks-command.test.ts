import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { findGlmOnlyMadFlagBlockers, findRetiredGlmMadFlagBlockers, findUnsupportedMadArgumentErrors, isOptionalZellijUnavailableLaunch, madHighCommand, resolveMadCliDegraded, stripMadLaunchOnlyArgs } from '../mad-sks-command.js';

test('retired GLM MAD flags are blocked instead of launched', () => {
  assert.deepEqual(findRetiredGlmMadFlagBlockers(['--mad', '--bench']), ['retired_glm_mad_flag:--bench']);
  assert.deepEqual(findRetiredGlmMadFlagBlockers(['--mad', '--trace', '--exact-provider', 'foo']), [
    'retired_glm_mad_flag:--trace',
    'retired_glm_mad_flag:--exact-provider'
  ]);
  assert.deepEqual(findGlmOnlyMadFlagBlockers(['--mad', '--glm', '--trace']), [
    'retired_glm_mad_flag:--glm',
    'retired_glm_mad_flag:--trace'
  ]);
});

test('launch sanitizer strips MAD launch flags; retired GLM flags stay for blockers', () => {
  assert.deepEqual(stripMadLaunchOnlyArgs(['--mad', '--deep', '--exact-provider', 'foo']), ['--deep', '--exact-provider', 'foo']);
  assert.deepEqual(findRetiredGlmMadFlagBlockers(['--deep', '--exact-provider']), [
    'retired_glm_mad_flag:--deep',
    'retired_glm_mad_flag:--exact-provider'
  ]);
});

test('removed MAD namespaces and runtime flags are unsupported instead of redirected', async () => {
  assert.deepEqual(findUnsupportedMadArgumentErrors([
    '--naruto',
    '--agent',
    '--clones',
    '--mad-db',
    '--mad-native-swarm',
    '--mad-swarm',
    '--no-mad-swarm',
    '--mad-agents=4',
    '--mad-swarm-work-items',
    '8',
    '--tmux-smoke',
    '--require-tmux-smoke'
  ]), [
    'unsupported_argument:--naruto',
    'unsupported_argument:--agent',
    'unsupported_argument:--clones',
    'unsupported_argument:--mad-db',
    'unsupported_argument:--mad-native-swarm',
    'unsupported_argument:--mad-swarm',
    'unsupported_argument:--no-mad-swarm',
    'unsupported_argument:--mad-agents',
    'unsupported_argument:--mad-swarm-work-items',
    'unsupported_argument:--tmux-smoke',
    'unsupported_argument:--require-tmux-smoke'
  ]);

  const originalExitCode = process.exitCode;
  const originalError = console.error;
  console.error = () => undefined;
  try {
    process.exitCode = 0;
    const result: any = await madHighCommand(['repair-config', '--tmux-smoke']);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.argument_errors, ['unsupported_argument:--tmux-smoke']);
    assert.equal(process.exitCode, 1);
  } finally {
    console.error = originalError;
    process.exitCode = originalExitCode;
  }
});

test('CLI (non-interactive) MAD launches resolve the headless degradation contract', () => {
  // Piped/headless stdout or stdin degrades the launch.
  assert.equal(resolveMadCliDegraded({ args: [], stdoutIsTTY: undefined, stdinIsTTY: undefined }), true);
  assert.equal(resolveMadCliDegraded({ args: [], stdoutIsTTY: true, stdinIsTTY: undefined }), true);
  // A fully interactive TTY keeps the blocking repair contract.
  assert.equal(resolveMadCliDegraded({ args: [], stdoutIsTTY: true, stdinIsTTY: true }), false);
  // --json is a machine-consumer signal and degrades even on a TTY.
  assert.equal(resolveMadCliDegraded({ args: ['--json'], stdoutIsTTY: true, stdinIsTTY: true }), true);
  // SKS_NO_QUESTION=1 is the scripted-launch signal.
  assert.equal(resolveMadCliDegraded({ args: [], env: { SKS_NO_QUESTION: '1' }, stdoutIsTTY: true, stdinIsTTY: true }), true);
  // --attach opts back into the interactive contract.
  assert.equal(resolveMadCliDegraded({ args: ['--attach'], stdoutIsTTY: undefined, stdinIsTTY: undefined }), false);
  // Explicit --headless is handled on its own path, not as CLI degradation.
  assert.equal(resolveMadCliDegraded({ args: [], explicitHeadless: true, stdoutIsTTY: undefined, stdinIsTTY: undefined }), false);
  // SKS_MAD_CLI_HEADLESS=0 restores the legacy blocking behavior.
  assert.equal(resolveMadCliDegraded({ args: [], env: { SKS_MAD_CLI_HEADLESS: '0' }, stdoutIsTTY: undefined, stdinIsTTY: undefined }), false);
});

test('only optional zellij-unavailable launch reports convert to a CLI headless fallback', () => {
  assert.equal(isOptionalZellijUnavailableLaunch({
    ok: false,
    blockers: [],
    warnings: ['zellij_missing_optional_integration', 'zellij_launch_skipped_optional_missing']
  }), true);
  assert.equal(isOptionalZellijUnavailableLaunch({ ok: true, blockers: [], warnings: [] }), false);
  // Required-zellij failures carry blockers and must stay failures.
  assert.equal(isOptionalZellijUnavailableLaunch({
    ok: false,
    blockers: ['zellij_missing_required'],
    warnings: ['zellij_launch_skipped_optional_missing']
  }), false);
  // A failed background session without the skipped-optional warning is a real launch failure.
  assert.equal(isOptionalZellijUnavailableLaunch({ ok: false, blockers: [], warnings: ['zellij_launch_some_other_warning'] }), false);
  assert.equal(isOptionalZellijUnavailableLaunch(null), false);
});

async function makeMadSksMission(gate: Record<string, unknown>) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-mad-sks-status-'));
  const missionId = 'M-mad-sks-status-gate-verdict';
  const dir = path.join(root, '.sneakoscope', 'missions', missionId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'mission.json'), JSON.stringify({ id: missionId, mode: 'mad-sks', prompt: 'fixture', created_at: new Date().toISOString(), phase: 'PREPARE' }, null, 2));
  await fsp.writeFile(path.join(dir, 'mad-sks-gate.json'), JSON.stringify(gate, null, 2));
  return { root, missionId };
}

test('mad-sks status surfaces gate_verdict.verdict=mock_only for a mock_fixture gate in --json output', async () => {
  const { root } = await makeMadSksMission({ passed: true, ok: true, blockers: [], execution_class: 'mock_fixture' });
  const originalCwd = process.cwd();
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => { logs.push(args.map(String).join(' ')); };
  try {
    process.chdir(root);
    await madHighCommand(['status', '--json']);
  } finally {
    console.log = originalLog;
    process.chdir(originalCwd);
  }
  const jsonLine = logs.find((line) => line.trim().startsWith('{'));
  assert.ok(jsonLine, 'expected a JSON line to be printed');
  const parsed = JSON.parse(jsonLine as string);
  assert.equal(parsed.gate_verdict.verdict, 'mock_only');
  assert.equal(parsed.gate_verdict.pass, false);
});

test('mad-sks status prints the gate verdict word as the first line in human-readable output', async () => {
  const { root } = await makeMadSksMission({ passed: false, ok: false, blockers: ['fixture_blocker'], execution_class: 'real' });
  const originalCwd = process.cwd();
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => { logs.push(args.map(String).join(' ')); };
  try {
    process.chdir(root);
    await madHighCommand(['status']);
  } finally {
    console.log = originalLog;
    process.chdir(originalCwd);
  }
  assert.equal(logs[0], 'fail');
});

test('mad-sks proof reads the current state path after legacy current.json cleanup', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-mad-sks-proof-current-state-'));
  const missionId = 'M-mad-sks-proof-current-state';
  const mission = path.join(root, '.sneakoscope', 'missions', missionId);
  const currentState = path.join(root, '.sneakoscope', 'state', 'current.json');
  const proof = {
    schema: 'sks.mad-sks-proof-evidence.v1',
    ok: true,
    mission_id: missionId
  };
  await fsp.mkdir(path.dirname(currentState), { recursive: true });
  await fsp.mkdir(mission, { recursive: true });
  await fsp.writeFile(currentState, JSON.stringify({ mission_id: missionId }, null, 2));
  await fsp.writeFile(path.join(mission, 'mad-sks-proof-evidence.json'), JSON.stringify(proof, null, 2));

  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: any[]) => { logs.push(args.map(String).join(' ')); };
  try {
    process.chdir(root);
    process.exitCode = 0;
    await madHighCommand(['proof', '--json']);
  } finally {
    console.log = originalLog;
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    await fsp.rm(root, { recursive: true, force: true });
  }

  const printed = JSON.parse(logs.find((line) => line.trim().startsWith('{')) || '{}');
  assert.equal(printed.schema, proof.schema);
  assert.equal(printed.mission_id, missionId);
});
