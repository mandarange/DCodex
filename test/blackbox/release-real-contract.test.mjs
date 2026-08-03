import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const contractUrl = pathToFileURL(path.join(root, 'dist', 'core', 'release', 'release-real-contract.js')).href

test('compiled release-real contract keeps optional live coverage out of release passes and recovers stderr blockers', () => {
  const source = `
    import { normalizeReleaseRealProcessResult, dependencyReleaseRealResult, summarizeReleaseRealPhases } from ${JSON.stringify(contractUrl)};
    const optionalPolicy = {
      requirement: 'live_optional',
      expectedSchemas: ['sks.fixture.v1'],
      statusRequired: true,
      allowedStatuses: ['passed', 'skipped', 'integration_optional', 'blocked'],
      passStatuses: ['passed']
    };
    const baseTask = { id: 'imagegen', script: 'imagegen', group: 'real_smoke', phase: 'parallel_processing', deps: [], command: null, policy: optionalPolicy };
    const skipped = normalizeReleaseRealProcessResult({
      task: baseTask,
      commandLine: ['node', 'imagegen.js'], code: 0, signal: null, error: null,
      stdout: JSON.stringify({ schema: 'sks.fixture.v1', ok: true, status: 'skipped' }), stderr: '', durationMs: 1, attempt: 1
    });
    const downstream = dependencyReleaseRealResult({ ...baseTask, id: 'ux', deps: ['imagegen'] }, [skipped]);
    const requiredTask = {
      id: 'codex', script: 'codex', group: 'environment_required', phase: 'parallel_processing', deps: [], command: null,
      policy: { requirement: 'release_authorizing', expectedSchemas: ['sks.fixture.v1'], statusRequired: false, allowedStatuses: ['blocked'], passStatuses: [] }
    };
    const stderr = JSON.stringify({ ok: false, detail: { schema: 'sks.fixture.v1', overall_ok: false, blockers: ['native_probe_failed'] } });
    const failed = normalizeReleaseRealProcessResult({
      task: requiredTask,
      commandLine: ['node', 'codex.js'], code: 1, signal: null, error: null,
      stdout: '', stderr, durationMs: 1, attempt: 1
    });
    const phase = summarizeReleaseRealPhases(['parallel_processing'], [skipped, downstream, failed], null)[0];
    console.log(JSON.stringify({ skipped, downstream, failed, phase }));
  `
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000
  })
  assert.equal(run.status, 0, run.stderr || run.stdout)
  const result = JSON.parse(run.stdout)
  assert.equal(result.skipped.ok, true)
  assert.equal(result.skipped.passed, false)
  assert.equal(result.downstream.outcome, 'optional')
  assert.equal(result.downstream.process_ok, null)
  assert.ok(result.downstream.blockers.includes('optional_by_dependency:imagegen:skipped'))
  assert.equal(result.failed.ok, false)
  assert.ok(result.failed.blockers.includes('native_probe_failed'))
  assert.equal(result.phase.passed, 0)
  assert.equal(result.phase.live_optional_total, 2)
  assert.equal(result.phase.outcome_counts.skipped, 1)
  assert.equal(result.phase.outcome_counts.optional, 1)
})

test('release-real CLI denies an unbound --skip-release-check before launching live tasks', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-real-skip-'))
  const scratchBase = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-real-tmp-'))
  try {
    const run = spawnSync(process.execPath, [path.join(root, 'dist', 'scripts', 'release-real-check.js'), '--skip-release-check'], {
      cwd: fixture,
      env: { ...process.env, TMPDIR: scratchBase, TMP: scratchBase, TEMP: scratchBase, SKS_TMP_DIR: path.join(scratchBase, 'caller') },
      encoding: 'utf8',
      timeout: 15_000
    })
    assert.equal(run.status, 1, run.stderr || run.stdout)
    const report = JSON.parse(fs.readFileSync(path.join(fixture, '.sneakoscope', 'reports', 'release-real-check.json'), 'utf8'))
    assert.equal(report.ok, false)
    assert.equal(report.release_check.outcome, 'blocked')
    assert.equal(report.release_check.execution, 'reused_full_release_proof')
    assert.equal(report.all_checks.length, 0)
    assert.ok(report.blockers.includes('release_real_skip_full_summary_missing'))
    assert.equal(report.scratch_isolation.cleanup.trigger, 'finish')
    assert.equal(report.scratch_isolation.cleanup.ok, true)
    assert.equal(report.scratch_isolation.cleanup.removed, true)
    assert.equal(fs.existsSync(report.scratch_isolation.root), false)
    assert.equal(path.dirname(path.dirname(report.scratch_isolation.root)), scratchBase)
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
    fs.rmSync(scratchBase, { recursive: true, force: true })
  }
})

for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`release-real CLI forwards one owned scratch root and removes it after ${signal}`, { timeout: 20_000 }, async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-real-signal-'))
  const scratchBase = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-real-signal-tmp-'))
  const checker = path.join(root, 'dist', 'scripts', 'release-real-check.js')
  try {
    fs.writeFileSync(path.join(fixture, 'package.json'), `${JSON.stringify({
      private: true,
      scripts: { 'release:check': 'node hold.mjs' }
    }, null, 2)}\n`)
    fs.writeFileSync(path.join(fixture, 'hold.mjs'), [
      "import fs from 'node:fs'",
      "fs.writeFileSync('hold-env.json', JSON.stringify({ pid: process.pid, TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP, SKS_TMP_DIR: process.env.SKS_TMP_DIR }))",
      "process.on('SIGINT', () => process.exit(0))",
      "process.on('SIGTERM', () => process.exit(0))",
      'setInterval(() => {}, 1000)'
    ].join('\n'))
    const child = spawn(process.execPath, [checker], {
      cwd: fixture,
      env: { ...process.env, TMPDIR: scratchBase, TMP: scratchBase, TEMP: scratchBase, SKS_TMP_DIR: path.join(scratchBase, 'caller') },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.stdout.resume()

    await waitFor(() => fs.existsSync(path.join(fixture, 'hold-env.json')), 7_500)
    const inherited = JSON.parse(fs.readFileSync(path.join(fixture, 'hold-env.json'), 'utf8'))
    assert.match(inherited.TMPDIR, new RegExp(`^${escapeRegExp(path.join(scratchBase, 'sks', 'rr-'))}`))
    assert.equal(inherited.TMP, inherited.TMPDIR)
    assert.equal(inherited.TEMP, inherited.TMPDIR)
    assert.equal(inherited.SKS_TMP_DIR, inherited.TMPDIR)

    child.kill(signal)
    const result = await waitForClose(child)
    assert.equal(result.code, exitCode, stderr)
    const report = JSON.parse(fs.readFileSync(path.join(fixture, '.sneakoscope', 'reports', 'release-real-check.json'), 'utf8'))
    assert.ok(report.blockers.includes(`release_real_check_signal:${signal}`))
    assert.equal(report.scratch_isolation.root, inherited.TMPDIR)
    assert.equal(report.scratch_isolation.cleanup.trigger, `signal:${signal}`)
    assert.equal(report.scratch_isolation.cleanup.ok, true)
    assert.equal(report.scratch_isolation.cleanup.removed, true)
    assert.equal(fs.existsSync(inherited.TMPDIR), false)
    await waitFor(() => !processExists(inherited.pid), 5_000)
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
    fs.rmSync(scratchBase, { recursive: true, force: true })
  }
  })
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`condition not met within ${timeoutMs}ms`)
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
