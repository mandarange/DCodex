import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { UPDATE_STAGE_ORDER } from '../../update-check.js';

const expectedUpdateStageOrder = [
  'preflight',
  'download_or_registry_check',
  'temporary_install_smoke',
  'global_install',
  'resolve_new_binary',
  'version_probe',
  'new_version_doctor',
  'hook_trust_repair',
  'project_receipt',
  'global_skills_reconcile',
  'native_capability_setup',
  'menubar_rebuild',
  'menubar_signature_verify',
  'menubar_version_probe',
  'update_finalize_doctor',
  'final_self_verification',
  'snapshot_refresh'
] as const;

test('compiled OperationCoordinator reads and maps the real 17-stage update receipt contract', async (t) => {
  assert.deepEqual(UPDATE_STAGE_ORDER, expectedUpdateStageOrder);
  if (process.platform !== 'darwin') return t.skip('Swift runtime receipt harness is macOS-only');
  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sks-update-receipt-runtime-'));
  const canonicalTemp = await fs.realpath(temp);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const receiptPath = path.join(temp, 'update-latest.json');
  await fs.writeFile(receiptPath, `${JSON.stringify({
    schema: 'sks.update-operation.v1',
    id: 'update-runtime-fixture',
    kind: 'update',
    state: 'terminal_uncertain',
    current_stage: 'global_install',
    started_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:02.000Z',
    from_version: '6.2.0',
    target_version: '6.3.0',
    previous_version: '6.2.0',
    project_root: canonicalTemp,
    registry: 'https://registry.npmjs.org/',
    rollback_command: `sks update rollback --version 6.2.0 --project-root ${canonicalTemp} --json`,
    side_effects_started: true,
    stages: [
      { id: 'preflight', ok: true, status: 'completed', updated_at: '2026-07-15T00:00:01.000Z', detail: {} },
      { id: 'global_install', ok: false, status: 'terminal_uncertain', updated_at: '2026-07-15T00:00:02.000Z', detail: {} }
    ],
    result_status: 'terminal_uncertain',
    public_error: 'global install completion could not be confirmed',
    receipt_path: receiptPath
  }, null, 2)}\n`, { mode: 0o600 });
  const harness = path.join(temp, 'Harness.swift');
  const binary = path.join(temp, 'operation-receipt-harness');
  await fs.writeFile(harness, `
import Foundation
import Darwin

private func sksCanonicalFilesystemPath(_ value: String) -> String {
    let standardized = URL(fileURLWithPath: value, isDirectory: true)
        .resolvingSymlinksInPath().standardizedFileURL.path
    return standardized.withCString { pointer in
        guard let resolved = Darwin.realpath(pointer, nil) else { return standardized }
        defer { free(resolved) }
        return String(cString: resolved)
    }
}

enum AppRuntime {
    static let lastActionLogPath = "/tmp/sks-operation-runtime.log"
    static let projectRoot = "/tmp/sks-operation-project"
    static let canonicalProjectRoot = sksCanonicalFilesystemPath(projectRoot)
}

@main
struct Harness {
    static func fixtureReceipt(id: String? = nil, kind: String = "update", state: String, resultStatus: String? = nil, complete: Bool = false, failedStage: String? = nil, projectRoot: String = AppRuntime.canonicalProjectRoot, registry: String? = "https://registry.npmjs.org/", rollbackCommand: String? = nil) -> UpdateOperationReceiptSnapshot {
        let stages = complete ? OperationCoordinator.updateStageOrder.enumerated().map { index, id in
            UpdateOperationStageSnapshot(
                id: id,
                ok: id != failedStage,
                status: id == failedStage ? "failed" : "completed",
                updatedAt: "2026-07-15T00:00:\\(String(format: "%02d", index)).000Z"
            )
        } : []
        return UpdateOperationReceiptSnapshot(
            schema: "sks.update-operation.v1",
            id: id ?? "authority-fixture-\\(kind)-\\(state)-\\(resultStatus ?? "none")",
            kind: kind,
            state: state,
            currentStage: "global_install",
            startedAt: "2026-07-15T00:00:00.000Z",
            updatedAt: "2026-07-15T00:00:02.000Z",
            fromVersion: "6.2.0",
            targetVersion: "6.3.0",
            previousVersion: "6.2.0",
            projectRoot: projectRoot,
            registry: registry,
            rollbackCommand: rollbackCommand ?? "sks update rollback --version 6.2.0 --project-root \\(projectRoot) --json",
            sideEffectsStarted: true,
            stages: stages,
            resultStatus: resultStatus,
            publicError: nil,
            receiptPath: "/tmp/update-authority-fixture.json"
        )
    }

    static func main() {
        let directory = CommandLine.arguments[1]
        let canonicalDirectory = sksCanonicalFilesystemPath(directory)
        let receiptPath = CommandLine.arguments[2]
        let coordinator = OperationCoordinator(directory: directory)
        let expectedUpdateStageOrder = [${expectedUpdateStageOrder.map((id) => JSON.stringify(id)).join(', ')}]
        precondition(OperationCoordinator.updateStageOrder == expectedUpdateStageOrder)
        precondition(OperationCoordinator.updateStageOrder.count == 17)
        precondition(OperationCoordinator.postUpdateReconciliationStages.contains("menubar_version_probe"))
        guard let receipt = coordinator.latestUpdateReceipt() else { fatalError("missing receipt") }
        precondition(receipt.schema == "sks.update-operation.v1")
        precondition(receipt.currentStage == "global_install")
        precondition(receipt.sideEffectsStarted)
        precondition(receipt.projectRoot == canonicalDirectory)
        precondition(receipt.rollbackCommand.contains("--project-root"))
        precondition(receipt.rollbackCommand.contains(canonicalDirectory))
        let output = "{\\\"operation_receipt_path\\\":\\\"\\(receiptPath)\\\"}"
        precondition(coordinator.updateReceipt(fromProcessOutput: output)?.id == receipt.id)
        guard let local = coordinator.begin(kind: "update", mutationGroup: "update", summary: "Update") else { fatalError("begin") }
        let synchronized = coordinator.synchronize(local, with: receipt, processCompleted: true)
        precondition(synchronized.state == .terminalUncertain)
        precondition(synchronized.stage == "global_install")
        precondition(abs((synchronized.progress ?? 0) - (2.0 / Double(OperationCoordinator.updateStageOrder.count))) < 0.0001)
        precondition(coordinator.latestSnapshot()?.state == .terminalUncertain)
        guard let held = coordinator.begin(kind: "update", mutationGroup: "update", summary: "Held update") else { fatalError("held begin") }
        _ = coordinator.update(
            held,
            state: .terminalUncertain,
            stage: "receipt",
            progress: nil,
            summary: "Unvalidated final output"
        )
        guard let retry = coordinator.begin(kind: "retry", mutationGroup: "update", summary: "Retry") else {
            fatalError("terminal uncertainty permanently held the mutation guard")
        }
        _ = coordinator.update(retry, state: .cancelled, stage: "cleanup", progress: nil, summary: "Cleanup")
        let launched = OperationSnapshot(
            schema: "sks.operation.v1",
            id: "bound-update",
            kind: "update",
            state: .running,
            stage: "running",
            progress: nil,
            startedAt: "2026-07-15T00:00:00.000Z",
            updatedAt: "2026-07-15T00:00:01.000Z",
            publicSummary: "Update",
            logPath: nil,
            retryable: true,
            targetVersion: "6.3.0",
            projectRoot: AppRuntime.canonicalProjectRoot,
            registry: "https://registry.npmjs.org/"
        )
        precondition(OperationCoordinator.receiptMatchesLaunchedUpdate(
            fixtureReceipt(id: launched.id, state: "running"),
            operation: launched
        ))
        precondition(!OperationCoordinator.receiptMatchesLaunchedUpdate(
            fixtureReceipt(id: "different-update", state: "running"),
            operation: launched
        ))
        precondition(!OperationCoordinator.receiptMatchesLaunchedUpdate(
            fixtureReceipt(id: launched.id, state: "running", registry: "https://registry.example/"),
            operation: launched
        ))
        precondition(OperationCoordinator.canonicalRegistry("https://registry.npmjs.org") == "https://registry.npmjs.org/")
        precondition(OperationCoordinator.canonicalRegistry("file:///tmp/registry") == nil)
        precondition(OperationCoordinator.canonicalRegistry("https://registry.npmjs.org/?token=secret") == nil)
        precondition(OperationCoordinator.authoritativeState(for: fixtureReceipt(state: "queued"), processCompleted: true) == .terminalUncertain)
        precondition(OperationCoordinator.authoritativeState(for: fixtureReceipt(state: "running"), processCompleted: true) == .terminalUncertain)
        precondition(OperationCoordinator.authoritativeState(for: fixtureReceipt(state: "succeeded", resultStatus: "failed")) == .failed)
        precondition(OperationCoordinator.authoritativeState(for: fixtureReceipt(state: "succeeded", resultStatus: "updated_with_issues")) == .failed)
        precondition(OperationCoordinator.authoritativeState(for: fixtureReceipt(state: "succeeded", resultStatus: "terminal_uncertain")) == .terminalUncertain)
        precondition(OperationCoordinator.authoritativeState(for: fixtureReceipt(state: "rolled_back")) == .failed)
        precondition(OperationCoordinator.authoritativeState(for: fixtureReceipt(kind: "rollback", state: "rolled_back", complete: true), expectedProjectRoot: AppRuntime.canonicalProjectRoot) == .succeeded)
        precondition(OperationCoordinator.authoritativeState(for: fixtureReceipt(kind: "rollback", state: "rolled_back")) == .terminalUncertain)
        precondition(OperationCoordinator.receiptRequiresAction(fixtureReceipt(state: "succeeded", resultStatus: "updated_with_issues")))
        precondition(OperationCoordinator.receiptRequiresAction(fixtureReceipt(state: "succeeded", resultStatus: "updated")))
        precondition(!OperationCoordinator.receiptRequiresAction(fixtureReceipt(state: "succeeded", resultStatus: "updated", complete: true)))
        precondition(OperationCoordinator.authoritativeState(for: fixtureReceipt(state: "succeeded", resultStatus: "updated", complete: true), expectedProjectRoot: "/different/project") == .terminalUncertain)
        precondition(OperationCoordinator.authoritativeState(for: fixtureReceipt(state: "succeeded", resultStatus: "updated", complete: true, failedStage: "global_skills_reconcile")) == .failed)
        precondition(OperationCoordinator.completionContractIssues(for: fixtureReceipt(state: "succeeded", resultStatus: "updated", complete: true, failedStage: "menubar_version_probe")).contains { $0 == "failed reconciliation: menubar_version_probe" })
        let apostropheRoot = "/tmp/O'Brien/project"
        precondition(OperationCoordinator.completionContractIssues(
            for: fixtureReceipt(state: "succeeded", resultStatus: "updated", complete: true, projectRoot: apostropheRoot, rollbackCommand: "display-only shell quoting"),
            expectedProjectRoot: apostropheRoot
        ).isEmpty)
        precondition(OperationCoordinator.completionContractIssues(for: fixtureReceipt(state: "succeeded", resultStatus: "updated")).contains { $0.contains("missing stages") })
        print("update-receipt-runtime-ok")
    }
}
`);
  const source = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', 'OperationCoordinator.swift');
  const compiled = await run('swiftc', [source, harness, '-o', binary]);
  assert.equal(compiled.code, 0, `${compiled.stdout}\n${compiled.stderr}`);
  const executed = await run(binary, [temp, receiptPath]);
  assert.equal(executed.code, 0, `${executed.stdout}\n${executed.stderr}`);
  assert.match(executed.stdout, /update-receipt-runtime-ok/);
});

test('compiled ProcessClient uses HOME as its safe launch cwd and passes update deferral only to its child', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Swift ProcessClient harness is macOS-only');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-process-client-update-env-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const actionScript = path.join(temp, 'action.sh');
  await fs.writeFile(actionScript, '#!/bin/zsh\n/usr/bin/printf \'%s\\n\' "${SKS_UPDATE_DEFER_MENUBAR_RESTART:-missing}"\nhome_path="$(cd "$HOME" && /bin/pwd -P)"\ncwd_path="$(/bin/pwd -P)"\nif [ "$cwd_path" = "$home_path" ]; then /usr/bin/printf \'cwd_is_home=1\\n\'; else /usr/bin/printf \'cwd_is_home=0\\n\'; fi\n/usr/bin/printf \'payload_ready=1\\n\'\n/bin/sleep 30\n', { mode: 0o755 });
  const harness = path.join(temp, 'Harness.swift');
  const binary = path.join(temp, 'process-client-update-env-harness');
  await fs.writeFile(harness, `
import Foundation
import Darwin

@main
struct Harness {
    static func main() {
        let temp = CommandLine.arguments[1]
        let actionScript = CommandLine.arguments[2]
        let client = ProcessClient(
            actionScript: actionScript,
            logPath: temp + "/process-client.log",
            projectRoot: temp
        )
        let started = Date()
        client.run(["probe"], environment: ["SKS_UPDATE_DEFER_MENUBAR_RESTART": "1"], timeout: 5.0) { result in
            print("code=" + String(result.code))
            print("elapsed_lt_10=" + String(Date().timeIntervalSince(started) < 10))
            print(result.output)
            print("process-client-safe-cwd-timeout-and-update-env-ok")
            Darwin.exit(0)
        }
        dispatchMain()
    }
}
`);
  const source = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', 'ProcessClient.swift');
  const executionState = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', 'ProcessExecutionState.swift');
  const identityGuard = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', 'ProcessIdentityGuard.swift');
  const secureEnvelope = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', 'SecureProcessEnvelope.swift');
  const compiled = await run('swiftc', [source, executionState, identityGuard, secureEnvelope, harness, '-o', binary]);
  assert.equal(compiled.code, 0, `${compiled.stdout}\n${compiled.stderr}`);
  const executed = await run(binary, [temp, actionScript]);
  assert.equal(executed.code, 0, `${executed.stdout}\n${executed.stderr}`);
  assert.doesNotMatch(executed.stdout, /code=0(?:\D|$)/);
  assert.match(executed.stdout, /elapsed_lt_10=true/);
  assert.match(executed.stdout, /^1$/m);
  assert.match(executed.stdout, /^cwd_is_home=1$/m);
  assert.match(executed.stdout, /^payload_ready=1$/m);
  assert.match(executed.stdout, /process-client-safe-cwd-timeout-and-update-env-ok/);
});

test('compiled ProcessClient bounds noisy output and completes timed-out children on the main queue', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Swift ProcessClient harness is macOS-only');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-process-client-bounds-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const actionScript = path.join(temp, 'action.sh');
  await fs.writeFile(actionScript, `#!/bin/zsh
if [ "$1" = "noisy" ]; then
  while true; do /usr/bin/printf 'bounded-noisy-output-0123456789\\n'; done
fi
if [ "$1" = "exited-parent" ]; then
  /bin/sleep 30 &
  grandchild_pid=$!
  /usr/bin/printf 'exited-parent grandchild_pid=%s\\n' "$grandchild_pid"
  exit 0
fi
/bin/zsh -c 'trap "" TERM; while true; do /bin/sleep 1; done' &
grandchild_pid=$!
/usr/bin/printf 'hung-ready grandchild_pid=%s\\n' "$grandchild_pid"
wait "$grandchild_pid"
`, { mode: 0o755 });
  const harness = path.join(temp, 'Harness.swift');
  const binary = path.join(temp, 'process-client-bounds-harness');
  await fs.writeFile(harness, `
import Foundation
import Darwin

enum AppRuntime { static let lastActionLogPath = "/tmp/sks-process-client-bounds.log" }

@main
struct Harness {
    static func main() {
        let temp = CommandLine.arguments[1]
        let coordinator = OperationCoordinator(directory: temp + "/operations")
        let client = ProcessClient(
            actionScript: CommandLine.arguments[2],
            logPath: temp + "/process-client.log",
            projectRoot: temp
        )
        guard let noisyOperation = coordinator.begin(
            kind: "noisy",
            mutationGroup: "codex-config",
            summary: "Noisy operation"
        ) else { fatalError("noisy operation did not begin") }
        client.run(["noisy"], timeout: 5, maxOutputBytes: 4096, logOutput: false) { noisy in
            dispatchPrecondition(condition: .onQueue(.main))
            precondition(noisy.code == -4)
            precondition(noisy.truncated)
            precondition(!noisy.timedOut)
            precondition(noisy.output.contains("native_process_output_limit"))
            precondition(noisy.output.utf8.count < 5000)
            _ = coordinator.update(
                noisyOperation,
                state: .failed,
                stage: "complete",
                progress: 1,
                summary: "Noisy operation stopped"
            )
            guard let exitedParentOperation = coordinator.begin(
                kind: "exited-parent",
                mutationGroup: "codex-config",
                summary: "Exited parent operation"
            ) else { fatalError("output-limited completion did not release mutation state") }
            let exitedParentStarted = Date()
            client.run(["exited-parent"], timeout: 0.25, maxOutputBytes: 4096, logOutput: false) { exitedParent in
                dispatchPrecondition(condition: .onQueue(.main))
                precondition(Date().timeIntervalSince(exitedParentStarted) < 3)
                precondition(exitedParent.code == -2)
                precondition(exitedParent.timedOut)
                precondition(exitedParent.output.contains("native_process_timeout"))
                let expression = try! NSRegularExpression(pattern: "grandchild_pid=([0-9]+)")
                let range = NSRange(exitedParent.output.startIndex..<exitedParent.output.endIndex, in: exitedParent.output)
                let match = expression.firstMatch(in: exitedParent.output, range: range)!
                let pidRange = Range(match.range(at: 1), in: exitedParent.output)!
                let fixtureGrandchildPid = pid_t(exitedParent.output[pidRange])!
                errno = 0
                precondition(Darwin.kill(fixtureGrandchildPid, 0) == -1 && errno == ESRCH)
                _ = coordinator.update(
                    exitedParentOperation,
                    state: .failed,
                    stage: "complete",
                    progress: 1,
                    summary: "Exited parent operation stopped"
                )
                guard let hungOperation = coordinator.begin(
                    kind: "hung",
                    mutationGroup: "codex-config",
                    summary: "Hung operation"
                ) else { fatalError("exited-parent timeout did not release mutation state") }
                let hungStarted = Date()
                client.run(["hung"], timeout: 0.25, maxOutputBytes: 4096, logOutput: false) { hung in
                    dispatchPrecondition(condition: .onQueue(.main))
                    precondition(Date().timeIntervalSince(hungStarted) < 3)
                    precondition(hung.code == -2)
                    precondition(hung.timedOut)
                    precondition(!hung.truncated)
                    precondition(hung.output.contains("native_process_timeout"))
                    let range = NSRange(hung.output.startIndex..<hung.output.endIndex, in: hung.output)
                    let match = expression.firstMatch(in: hung.output, range: range)!
                    let pidRange = Range(match.range(at: 1), in: hung.output)!
                    let grandchildPid = pid_t(hung.output[pidRange])!
                    errno = 0
                    precondition(Darwin.kill(grandchildPid, 0) == -1 && errno == ESRCH)
                    _ = coordinator.update(
                        hungOperation,
                        state: .failed,
                        stage: "complete",
                        progress: 1,
                        summary: "Hung operation stopped"
                    )
                    precondition(coordinator.begin(
                        kind: "after-timeout",
                        mutationGroup: "codex-config",
                        summary: "After timeout"
                    ) != nil)
                    print("process-client-output-bound-and-deadline-ok")
                    Darwin.exit(0)
                }
            }
        }
        dispatchMain()
    }
}
`);
  const source = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', 'ProcessClient.swift');
  const executionState = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', 'ProcessExecutionState.swift');
  const identityGuard = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', 'ProcessIdentityGuard.swift');
  const secureEnvelope = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', 'SecureProcessEnvelope.swift');
  const coordinatorSource = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', 'OperationCoordinator.swift');
  const compiled = await run('swiftc', [source, executionState, identityGuard, secureEnvelope, coordinatorSource, harness, '-o', binary]);
  assert.equal(compiled.code, 0, `${compiled.stdout}\n${compiled.stderr}`);
  const executed = await run(binary, [temp, actionScript], 10_000);
  assert.equal(executed.code, 0, `${executed.stdout}\n${executed.stderr}`);
  assert.match(executed.stdout, /process-client-output-bound-and-deadline-ok/);
});

test('compiled ProcessClient terminateAll synchronously hard-kills a stubborn tracked root', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Swift ProcessClient harness is macOS-only');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-process-client-terminate-all-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const actionScript = path.join(temp, 'action.sh');
  const harness = path.join(temp, 'Harness.swift');
  const binary = path.join(temp, 'process-client-terminate-all-harness');
  await fs.writeFile(actionScript, `#!/bin/zsh
trap '' TERM
/usr/bin/printf '%s\\n' "$$" > "\${0:A:h}/root.pid"
/usr/bin/printf 'root_pid=%s\\n' "$$"
while true; do /bin/sleep 1; done
`, { mode: 0o755 });
  await fs.writeFile(harness, `
import Foundation
import Darwin

@main
struct Harness {
    static func main() {
        let temp = CommandLine.arguments[1]
        let client = ProcessClient(
            actionScript: CommandLine.arguments[2],
            logPath: temp + "/process-client.log",
            projectRoot: temp
        )
        client.run(["stubborn"], timeout: 30, maxOutputBytes: 4096, logOutput: false) { result in
            let pidText = try! String(contentsOfFile: temp + "/root.pid", encoding: .utf8)
            let rootPid = pid_t(pidText.trimmingCharacters(in: .whitespacesAndNewlines))!
            errno = 0
            precondition(Darwin.kill(rootPid, 0) == -1 && errno == ESRCH)
            precondition(result.code != 0)
            print("process-client-terminate-all-root-gone")
            Darwin.exit(0)
        }
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.15) {
            let pidFile = temp + "/root.pid"
            for _ in 0..<100 {
                if let pidText = try? String(contentsOfFile: pidFile, encoding: .utf8),
                   pid_t(pidText.trimmingCharacters(in: .whitespacesAndNewlines)) != nil {
                    break
                }
                usleep(10_000)
            }
            let pidText = try? String(contentsOfFile: pidFile, encoding: .utf8)
            precondition(pidText.flatMap {
                pid_t($0.trimmingCharacters(in: .whitespacesAndNewlines))
            } != nil)
            let started = Date()
            client.terminateAll()
            precondition(Date().timeIntervalSince(started) < 1)
        }
        dispatchMain()
    }
}
`);
  const source = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', 'ProcessClient.swift');
  const executionState = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', 'ProcessExecutionState.swift');
  const identityGuard = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', 'ProcessIdentityGuard.swift');
  const secureEnvelope = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', 'SecureProcessEnvelope.swift');
  const compiled = await run('swiftc', [source, executionState, identityGuard, secureEnvelope, harness, '-o', binary]);
  assert.equal(compiled.code, 0, `${compiled.stdout}\n${compiled.stderr}`);
  const executed = await run(binary, [temp, actionScript], 10_000);
  assert.equal(executed.code, 0, `${executed.stdout}\n${executed.stderr}`);
  assert.match(executed.stdout, /process-client-terminate-all-root-gone/);
});

test('native reliability source binds menu-open expiry, status keys, and receipt-driven update UI', async () => {
  const sourceRoot = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources');
  const statusItem = await fs.readFile(path.join(sourceRoot, 'StatusItemController.swift'), 'utf8');
  const overview = [
    await fs.readFile(path.join(sourceRoot, 'OverviewViewController.swift'), 'utf8'),
    await fs.readFile(path.join(sourceRoot, 'OverviewSummary.swift'), 'utf8')
  ].join('\n');
  const updates = await fs.readFile(path.join(sourceRoot, 'UpdatesViewController.swift'), 'utf8');
  const processClient = await fs.readFile(path.join(sourceRoot, 'ProcessClient.swift'), 'utf8');
  assert.match(statusItem, /func menuWillOpen\(_ menu: NSMenu\)[\s\S]*refreshExpiredUpdateStatusIfNeeded\(\)/);
  assert.match(statusItem, /guard !updateRefreshInFlight, StatusItemController\.updateStatusNeedsRefresh\(update\) else \{ return \}/);
  assert.match(statusItem, /\["update", "status", "--project-root", AppRuntime\.canonicalProjectRoot, "--json"\]/);
  assert.match(statusItem, /update\["source"\] as\? String == "disabled"/);
  assert.match(statusItem, /expiry <= now/);
  assert.match(overview, /menu\?\["expected_version"\]/);
  assert.match(overview, /menu\?\["installed_version"\]/);
  assert.doesNotMatch(overview, /menu\?\["expected"\]|menu\?\["installed"\]/);
  assert.match(updates, /OperationCoordinator\.updateStageOrder\.count/);
  assert.match(updates, /operations\.updateReceipt\(fromProcessOutput: result\.output\)/);
  assert.match(updates, /updateReceipt\(fromProcessOutput: result\.output\)[\s\S]{0,120}\?\? self\.operations\.latestUpdateReceipt\(\)/);
  assert.match(updates, /SKS_UPDATE_OPERATION_ID.*operation\.id/);
  assert.match(updates, /OperationCoordinator\.receiptMatchesLaunchedUpdate\(receipt, operation: operation\)/);
  assert.match(updates, /state: \.terminalUncertain/);
  assert.doesNotMatch(updates, /state: \.terminalUncertain,[\s\S]{0,400}releaseMutationGuard: false/);
  assert.match(updates, /operations\.synchronize\([\s\S]*operation,[\s\S]*with: receipt,[\s\S]*processCompleted: true,[\s\S]*expectedProjectRoot: AppRuntime\.canonicalProjectRoot/);
  assert.match(updates, /OperationCoordinator\.authoritativeState\([\s\S]*for: receipt,[\s\S]*processCompleted: true,[\s\S]*expectedProjectRoot: AppRuntime\.canonicalProjectRoot/);
  assert.match(updates, /\["update", "review"\] \+ Self\.projectContext \+ \["--json"\]/);
  assert.match(updates, /\["update", "now", "--version", reviewed\.target, "--registry", reviewed\.registry\]/);
  assert.match(updates, /expectedProjectRoot: AppRuntime\.canonicalProjectRoot/);
  assert.match(updates, /rollback project root mismatch|Post-update reconciliation: incomplete/);
  assert.match(updates, /Post-update reconciliation: incomplete/);
  assert.match(updates, /No success state was assumed/);
  assert.match(processClient, /maximumTimeout: TimeInterval = 60 \* 60/);
  assert.match(updates, /Menu Bar expected .*expected_version.*installed .*installed_version/s);
  assert.match(updates, /Last checked .*generatedAt.*expires .*expiresAt/s);
  assert.match(updates, /Rollback .*receipt\.rollbackCommand/);
  assert.match(updates, /state: \.terminalUncertain/);
  assert.match(processClient, /environment: \[String: String\] = \[:\]/);
  assert.match(processClient, /ProcessInfo\.processInfo\.environment\.merging\(environment\)/);
  assert.match(processClient, /let terminationDeadline = timeoutDeadline \+ 2/);
  assert.match(processClient, /terminationSignal\.wait\(timeout: terminationDeadline\)/);
  assert.doesNotMatch(processClient, /terminationSignal\.wait\(\)/);
  assert.match(processClient, /process\.currentDirectoryURL = homeDirectory\(for:/);
  assert.match(processClient, /else \{[\s\S]*process\.standardInput = FileHandle\.nullDevice/);
  assert.match(processClient, /deadline: timeoutDeadline/);
  assert.doesNotMatch(processClient, /readDataToEndOfFile/);
  assert.match(processClient, /read\(upToCount: Self\.readChunkBytes\)/);
  assert.match(processClient, /native_process_output_limit/);
  assert.match(processClient, /timeout \?\? Self\.defaultTimeout/);
  assert.match(processClient, /try\? reader\.close\(\)/);
  assert.match(processClient, /proc_listchildpids/);
  assert.match(processClient, /processIdentityGuard\.signalIfCurrent\(descendant, signal: SIGKILL\)/);
  assert.match(processClient, /func terminateAll\(\)/);
  assert.match(processClient, /scheduleRootHardKill: false/);
  assert.match(processClient, /waitForRootsToExit\(active\.map\(\\\.process\), timeout: 0\.25\)/);
  assert.match(updates, /activeReceiptUpdatedAt == receipt\.updatedAt/);
  assert.match(overview, /longMutationTimeout: TimeInterval = 60 \* 60/);
  assert.doesNotMatch(processClient, /guard process\.isRunning,\s*execution\.markTimedOut/);
  assert.match(processClient, /process\.terminationHandler =/);
  assert.doesNotMatch(processClient, /process\.waitUntilExit\(\)/);
  assert.match(processClient, /execution\.markCompleted\(\)/);
  assert.match(updates, /NativeView\.longMutationTimeout/);
  assert.match(updates, /SKS_UPDATE_DEFER_MENUBAR_RESTART/);
  assert.match(updates, /SKS_SKIP_SKS_MENUBAR_LAUNCH/);
  assert.match(updates, /processClient\.run\(args, environment: environment(?:, timeout: timeout)?\)/);
  assert.match(updates, /receipt\.stages\.contains \{ \$0\.id == "menubar_rebuild" && \$0\.status == "installed_launch_skipped" \}/);
  assert.match(updates, /operations\.synchronize\([\s\S]*expectedProjectRoot: AppRuntime\.canonicalProjectRoot[\s\S]*self\.notifications\.send\([\s\S]*self\.restartMenuBarAfterUpdateCompletion\(\)/);
  assert.match(updates, /runDetached\(\["menubar", "restart", "--json"\]\)/);
  const pollingStart = updates.indexOf('private func startReceiptPolling');
  const pollingEnd = updates.indexOf('private func stopReceiptPolling', pollingStart);
  assert.notEqual(pollingStart, -1);
  assert.notEqual(pollingEnd, -1);
  const polling = updates.slice(pollingStart, pollingEnd);
  assert.match(polling, /receiptMatchesLaunchedUpdate/);
  assert.doesNotMatch(polling, /operations\.(?:synchronize|update)\(/);
});

function run(
  command: string,
  args: string[],
  timeoutMs?: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: timeoutMs !== undefined
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (timer !== undefined) clearTimeout(timer);
      if (timedOut) stderr += `\nprocess exceeded ${timeoutMs}ms deadline`;
      resolve({ code, stdout, stderr });
    });
  });
}
