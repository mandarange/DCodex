import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('compiled singleton guard enforces version and recorded-start arbitration', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Swift singleton guard harness is macOS-only');

  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sks-singleton-guard-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const harness = path.join(temp, 'Harness.swift');
  const binary = path.join(temp, 'singleton-guard-harness');
  const isolatedEnvironment = {
    ...process.env,
    HOME: temp,
    CFFIXED_USER_HOME: temp,
    TMPDIR: temp,
    CLANG_MODULE_CACHE_PATH: path.join(temp, 'clang-module-cache'),
    SWIFT_MODULECACHE_PATH: path.join(temp, 'swift-module-cache')
  };

  await fs.writeFile(harness, `
import Foundation

@main
struct Harness {
    static let bundleIdentifier = "com.sneakoscope.menubar"

    static func instance(
        _ pid: Int32,
        _ package: String?,
        _ build: String?,
        startedAt: TimeInterval? = nil
    ) -> MenuBarInstanceIdentity {
        MenuBarInstanceIdentity(
            processIdentifier: pid,
            packageVersion: package,
            buildVersion: build,
            startedAt: startedAt.map(Date.init(timeIntervalSince1970:))
        )
    }

    static func main() {
        precondition(SingletonInstanceGuard.arbitrate(
            candidate: instance(200, "7.9.0", "790", startedAt: 20),
            running: [instance(100, "8.0.3", "803", startedAt: 10)]
        ) == .exitCandidate(winner: 100, terminate: []), "older-version candidate must lose")

        precondition(SingletonInstanceGuard.arbitrate(
            candidate: instance(200, "8.0.3", "803", startedAt: 20),
            running: [instance(100, "7.9.0", "790", startedAt: 10)]
        ) == .keepCandidate(terminate: [100]), "newer-version candidate must win")

        precondition(SingletonInstanceGuard.arbitrate(
            candidate: instance(50, "8.0.3", "803", startedAt: 20),
            running: [instance(100, "8.0.3", "803", startedAt: 10)]
        ) == .exitCandidate(winner: 100, terminate: []), "later same-version starter must exit")

        let missingState = SingletonInstanceGuard.identity(
            processIdentifier: 300,
            runtimeState: nil,
            expectedBundleIdentifier: bundleIdentifier
        )
        precondition(
            missingState.packageVersion == nil &&
            missingState.buildVersion == nil &&
            missingState.startedAt == nil,
            "missing runtime state must remain unversioned"
        )
        precondition(SingletonInstanceGuard.arbitrate(
            candidate: instance(400, "8.0.3", "803", startedAt: 20),
            running: [missingState]
        ) == .keepCandidate(terminate: [300]), "versioned candidate must replace legacy incumbent")

        let incumbentWithoutStart = SingletonInstanceGuard.identity(
            processIdentifier: 100,
            runtimeState: MenuBarRuntimeState(
                schema: "sks.menubar-runtime-state.v1",
                pid: 100,
                package_version: "8.0.3",
                build_version: "803",
                bundle_identifier: bundleIdentifier,
                executable_path: "/tmp/SKS Menu Bar",
                started_at: nil
            ),
            expectedBundleIdentifier: bundleIdentifier
        )
        precondition(SingletonInstanceGuard.arbitrate(
            candidate: instance(50, "8.0.3", "803", startedAt: 20),
            running: [incumbentWithoutStart]
        ) == .exitCandidate(winner: 100, terminate: []), "incumbent without start time must be kept")

        precondition(SingletonInstanceGuard.arbitrate(
            candidate: instance(50, "8.0.3", "803"),
            running: [instance(100, "8.0.3", "803")]
        ) == .keepCandidate(terminate: [100]), "PID fallback applies when neither start time exists")

        print("singleton-guard-runtime-ok")
    }
}
`);

  const source = path.join(
    process.cwd(),
    'native',
    'sks-menubar',
    'Sources',
    'SingletonInstanceGuard.swift'
  );
  const compiled = await run('swiftc', [source, harness, '-o', binary], isolatedEnvironment);
  assert.equal(compiled.code, 0, `${compiled.stdout}\n${compiled.stderr}`);
  const executed = await run(binary, [], isolatedEnvironment);
  assert.equal(executed.code, 0, `${executed.stdout}\n${executed.stderr}`);
  assert.match(executed.stdout, /singleton-guard-runtime-ok/);
});

async function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 20_000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
