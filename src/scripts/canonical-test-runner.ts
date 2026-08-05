#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { SKS_TEMP_LEASE_FILE, tmpdir, writeJsonAtomic } from '../core/fsx.js';
import {
  allCanonicalTestFiles,
  canonicalTestCorpus,
  canonicalTestFiles,
  canonicalTestProofPath,
  RELEASE_HARNESS_REGRESSION_TESTS,
  sameCanonicalTestCorpus,
  writeCanonicalTestProof
} from '../core/release/canonical-test-proof.js';
import {
  releaseAuthorizationSnapshot,
  sameReleaseAuthorizationSnapshot
} from '../core/release/release-authorization-snapshot.js';

const root = process.cwd();
const allTestsRequested = process.argv.includes('--all');
const forwardedTestArgs = process.argv.slice(2).filter((arg) => arg !== '--all');
const proofPath = canonicalTestProofPath(root);
function removeCanonicalTestProof(): void {
  fs.rmSync(proofPath, { force: true });
}

if (!allTestsRequested) removeCanonicalTestProof();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const startedAt = new Date().toISOString();
const initialAuthorization = allTestsRequested ? null : releaseAuthorizationSnapshot(root, pkg);
const initialCorpus = allTestsRequested ? null : canonicalTestCorpus(root);
const { compiled, unit } = allTestsRequested ? allCanonicalTestFiles(root) : canonicalTestFiles(root);
const files = [...compiled, ...unit].sort();
const testConcurrency = resolveTestConcurrency(process.env.SKS_CANONICAL_TEST_CONCURRENCY);
const serialFileSuffixes = new Set<string>(RELEASE_HARNESS_REGRESSION_TESTS);
const serialFiles = files.filter((file) => serialFileSuffixes.has(relativePosix(file)));
const parallelFiles = files.filter((file) => !serialFileSuffixes.has(relativePosix(file)));

if (!compiled.length || !unit.length) {
  console.error(JSON.stringify({
    schema: 'sks.canonical-test-runner.v1',
    ok: false,
    compiled_tests: compiled.length,
    unit_tests: unit.length,
    blockers: ['canonical_test_surface_missing']
  }));
  process.exit(1);
}

const scratch = tmpdir('sks-canonical-test-');
let cleaned = false;
let finalized = false;
let proofCommitted = false;
const removeScratchSync = (): Error | null => {
  if (cleaned) return null;
  try {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    if (!fs.existsSync(scratch)) {
      cleaned = true;
      return null;
    }
    return new Error(`canonical test scratch still exists after cleanup: ${scratch}`);
  } catch (error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
  }
};

const cleanup = async (): Promise<Error | null> => {
  if (cleaned) return null;
  const deadline = Date.now() + 2_000;
  let lastError: Error | null = null;
  do {
    lastError = removeScratchSync();
    if (!lastError) {
      // A just-terminated test descendant can recreate its temp directory a
      // moment after the first rm. Require a short no-recreation window.
      await delay(100);
      if (!fs.existsSync(scratch)) return null;
      cleaned = false;
      lastError = new Error(`canonical test scratch was recreated during cleanup: ${scratch}`);
    }
    await delay(50);
  } while (Date.now() < deadline);
  return lastError ?? new Error(`canonical test scratch cleanup timed out: ${scratch}`);
};

process.once('exit', () => {
  const error = removeScratchSync();
  if (error) console.error(`canonical test cleanup failed during exit: ${error.message}`);
  if (!proofCommitted && !allTestsRequested) removeCanonicalTestProof();
});

await writeJsonAtomic(path.join(scratch, SKS_TEMP_LEASE_FILE), {
  schema: 'sks.temp-lease.v1',
  kind: 'canonical-test-runner',
  pid: process.pid,
  created_at: new Date().toISOString()
});

// Tests run against a scratch HOME so a test that resolves the default Codex
// home (missing codexHome/env override) can never mutate the operator's real
// ~/.codex. The sentinel config is seeded world-readable and with keys a repair
// would preserve; any content, mode, or tree change under the scratch .codex is
// an isolation breach and fails the run.
const realHome = os.homedir();
const isolatedHome = path.join(scratch, 'home');
const isolatedCodexHome = path.join(isolatedHome, '.codex');
const HOME_SENTINEL_EXCLUDES = new Set(['tmp', 'log', 'logs', 'sessions']);
fs.mkdirSync(isolatedCodexHome, { recursive: true });
fs.writeFileSync(path.join(isolatedCodexHome, 'config.toml'), [
  '# sks canonical-test sentinel — tests must never write the default Codex home',
  'model_provider = "sentinel-provider"',
  'model = "sentinel-model"',
  ''
].join('\n'), { mode: 0o644 });
fs.writeFileSync(path.join(isolatedHome, '.gitconfig'), '[user]\n\tname = SKS Canonical Test\n\temail = canonical-test@sks.invalid\n');

function snapshotIsolatedCodexHome(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (dir === isolatedCodexHome && HOME_SENTINEL_EXCLUDES.has(entry.name)) continue;
        walk(file);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(file);
          const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
          out.set(path.relative(isolatedHome, file), `${(stat.mode & 0o777).toString(8)}:${hash}`);
        } catch {}
      }
    }
  };
  walk(isolatedCodexHome);
  return out;
}

function diffIsolatedCodexHome(before: Map<string, string>, after: Map<string, string>): string[] {
  const breaches: string[] = [];
  for (const [file, signature] of after) {
    if (!before.has(file)) breaches.push(`added:${file}`);
    else if (before.get(file) !== signature) breaches.push(`changed:${file}`);
  }
  for (const file of before.keys()) if (!after.has(file)) breaches.push(`removed:${file}`);
  return breaches.sort();
}

const isolatedHomeBaseline = snapshotIsolatedCodexHome();

const isolatedProcessGroup = process.platform !== 'win32';
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  TMPDIR: scratch,
  TMP: scratch,
  TEMP: scratch,
  SKS_TMP_DIR: scratch,
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  SKS_TEST_FORBID_REAL_HOME: '1',
  SKS_TEST_REAL_HOME: realHome
};
delete childEnv.NODE_OPTIONS;
// An inherited CODEX_HOME (user shell export) would defeat the HOME redirect:
// codexHomePath() prefers env.CODEX_HOME over both explicit home arguments and
// $HOME. Tests that need CODEX_HOME set it themselves.
delete childEnv.CODEX_HOME;
console.log(`SKS ${allTestsRequested ? 'exhaustive' : 'release'} tests: ${files.length} files, parallel=${parallelFiles.length}@${testConcurrency}, serial=${serialFiles.length}@1`);
let activeChild: ChildProcess | null = null;
void runTestPhases();

type ForwardedSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
const signals: ForwardedSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const signalExitCodes: Record<ForwardedSignal, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
let forwardedSignal: ForwardedSignal | null = null;
let signalTimer: NodeJS.Timeout | null = null;
const signalHandlers = new Map<ForwardedSignal, () => void>();
for (const signal of signals) {
  const handler = () => {
    if (forwardedSignal) return;
    forwardedSignal = signal;
    signalChildTree(signal);
    signalTimer = setTimeout(() => {
      signalChildTree('SIGKILL');
      void finalize(signalExitCodes[signal], signal, null);
    }, 5_000);
  };
  signalHandlers.set(signal, handler);
  process.once(signal, handler);
}

function removeSignalHandlers(): void {
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
}

async function runTestPhases(): Promise<void> {
  try {
    const parallel = await runChild(process.execPath, ['--test', `--test-concurrency=${testConcurrency}`, ...parallelFiles, ...forwardedTestArgs]);
    if (parallel.code !== 0 || parallel.signal) return await finalize(parallel.code, parallel.signal, null);
    if (serialFiles.length) {
      const serial = await runChild(process.execPath, ['--test', '--test-concurrency=1', ...serialFiles, ...forwardedTestArgs]);
      return await finalize(serial.code, serial.signal, null);
    }
    await finalize(0, null, null);
  } catch (error: unknown) {
    await finalize(1, null, error instanceof Error ? error : new Error(String(error)));
  }
}

function runChild(command: string, args: string[]): Promise<{ code: number; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      detached: isolatedProcessGroup,
      env: childEnv,
      stdio: 'inherit'
    });
    activeChild = child;
    child.once('error', reject);
    child.once('close', async (code, signal) => {
      await settleSpecificChildTree(child);
      if (activeChild === child) activeChild = null;
      resolve({ code: code ?? 1, signal });
    });
  });
}

async function finalize(code: number, signal: NodeJS.Signals | null, spawnError: Error | null): Promise<void> {
  if (finalized) return;
  finalized = true;
  if (signalTimer) clearTimeout(signalTimer);
  await settleChildTree();
  const homeBreaches = diffIsolatedCodexHome(isolatedHomeBaseline, snapshotIsolatedCodexHome());
  const cleanupError = await cleanup();
  removeSignalHandlers();
  if (spawnError) console.error(`canonical test runner failed: ${spawnError.message}`);
  if (cleanupError) console.error(`canonical test cleanup failed: ${cleanupError.message}`);
  const breachError = homeBreaches.length
    ? new Error(`canonical_test_home_isolation_breach: a test wrote the default Codex home (${homeBreaches.join(', ')})`)
    : null;
  if (breachError) console.error(breachError.message);
  let proofError: Error | null = null;
  const successfulRun = code === 0 && !signal && !forwardedSignal && !spawnError && !cleanupError && !breachError;
  if (successfulRun && !allTestsRequested) {
    try {
      const finalAuthorization = releaseAuthorizationSnapshot(root, pkg);
      const finalCorpus = canonicalTestCorpus(root);
      if (!initialAuthorization || !sameReleaseAuthorizationSnapshot(initialAuthorization, finalAuthorization)) {
        throw new Error('canonical_test_release_authorization_drift');
      }
      if (!initialCorpus || !sameCanonicalTestCorpus(initialCorpus, finalCorpus)) {
        throw new Error('canonical_test_corpus_drift');
      }
      await writeCanonicalTestProof(root, {
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        corpus: finalCorpus,
        release_authorization_snapshot: finalAuthorization
      });
      proofCommitted = true;
    } catch (error: unknown) {
      proofError = error instanceof Error ? error : new Error(String(error));
      console.error(`canonical test proof failed: ${proofError.message}`);
    }
  }
  if (!proofCommitted && !allTestsRequested) removeCanonicalTestProof();
  if (forwardedSignal) process.kill(process.pid, forwardedSignal);
  else if (signal) process.kill(process.pid, signal);
  else process.exitCode = spawnError || cleanupError || breachError || proofError ? 1 : code;
}

function signalChildTree(signal: NodeJS.Signals): void {
  const child = activeChild;
  if (!child?.pid) return;
  if (isolatedProcessGroup) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try { child.kill(signal); } catch {}
}

function childTreeAlive(): boolean {
  const child = activeChild;
  return child ? childProcessGroupAlive(child) : false;
}

function childProcessGroupAlive(child: ChildProcess): boolean {
  if (!isolatedProcessGroup || !child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalSpecificChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (isolatedProcessGroup) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try { child.kill(signal); } catch {}
}

async function settleSpecificChildTree(child: ChildProcess): Promise<void> {
  if (!childProcessGroupAlive(child)) return;
  signalSpecificChildTree(child, 'SIGTERM');
  const termDeadline = Date.now() + 750;
  while (childProcessGroupAlive(child) && Date.now() < termDeadline) await delay(25);
  if (!childProcessGroupAlive(child)) return;
  signalSpecificChildTree(child, 'SIGKILL');
  const killDeadline = Date.now() + 750;
  while (childProcessGroupAlive(child) && Date.now() < killDeadline) await delay(25);
}

function relativePosix(file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

async function settleChildTree(): Promise<void> {
  if (!childTreeAlive()) return;
  signalChildTree('SIGTERM');
  const termDeadline = Date.now() + 750;
  while (childTreeAlive() && Date.now() < termDeadline) await delay(25);
  if (!childTreeAlive()) return;
  signalChildTree('SIGKILL');
  const killDeadline = Date.now() + 750;
  while (childTreeAlive() && Date.now() < killDeadline) await delay(25);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveTestConcurrency(raw: string | undefined): number {
  const available = Math.max(1, os.availableParallelism() - 1);
  const safeDefault = Math.min(6, available);
  if (raw === undefined || raw.trim() === '') return safeDefault;
  const requested = Number(raw);
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error('SKS_CANONICAL_TEST_CONCURRENCY must be a positive integer');
  }
  return Math.min(requested, available);
}
