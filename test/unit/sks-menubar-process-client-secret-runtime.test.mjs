import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('Menu Bar ProcessClient suppresses arbitrary secure stdin echoes in UI output and the 0600 action log', async (t) => {
  if (process.platform !== 'darwin') return t.skip('AppKit runtime required');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-menubar-process-secret-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const action = path.join(temp, 'action.sh');
  const harness = path.join(temp, 'Harness.swift');
  const binary = path.join(temp, 'process-client-harness');
  const log = path.join(temp, 'last-action.log');

  await fs.writeFile(action, `#!/bin/sh
printf 'args:%s\\n' "$*"
IFS= read -r value || true
case "$*" in
  *--plain-success*)
    printf 'saved\\n'
    exit 0
    ;;
  *--logical-fail*)
    printf '{"schema":"sks.codex-lb-set-key.v2","ok":false,"status":"rejected"}\\n'
    exit 0
    ;;
  *--unexpected-schema*)
    printf '{"schema":"sks.untrusted-result.v1","ok":true,"status":"stored"}\\n'
    exit 0
    ;;
  *--partial*)
    printf '{"schema":"sks.codex-lb-set-key.v2","ok":false,"status":"partial_configuration_keychain_retained","error":"setup_failed","partial_configuration":{"schema":"sks.codex-lb-partial-configuration.v1","failure_stage":"sync_center_desktop_credentials","filesystem_state":"restored","process_environment_state":"unchanged","keychain_state":"replacement_retained","external_environment_state":"inspect_with_status","durable_applied_state":["macOS Keychain replacement retained"],"recovery_actions":["Run: sks codex-lb status --json"],"recovery_paths":["/tmp/sks-recovery"],"secret_recovery_paths":["/tmp/sks-secret-recovery"],"ignored_secret":"%s"},"rollback":{"recovery_paths":["/tmp/sks-backup"],"secret_recovery_paths":["/tmp/sks-secret-backup"]},"reflected":"%s"}\\n' "$value" "$value"
    exit 1
    ;;
  *--fail*)
    printf '{"schema":"sks.codex-lb-set-key.v2","ok":false,"error":"secure_input_rejected","reflected":"%s"}\\n' "$value"
    exit 1
    ;;
esac
printf '{"schema":"sks.codex-lb-set-key.v2","ok":true,"status":"stored","reflected":"%s"}\\n' "$value"
`, { mode: 0o755 });
  await fs.writeFile(harness, `
import Foundation

@main
struct Harness {
    static func waitForResult(_ client: ProcessClient, arguments: [String], stdin: String) -> ProcessResult {
        var captured: ProcessResult?
        client.run(arguments, stdin: stdin) { result in captured = result }
        while captured == nil {
            _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
        }
        return captured!
    }

    static func main() throws {
        let action = CommandLine.arguments[1]
        let log = CommandLine.arguments[2]
        let root = CommandLine.arguments[3]
        let client = ProcessClient(actionScript: action, logPath: log, projectRoot: root)
        let sentinel = "opaque value " + UUID().uuidString.lowercased() + " +/!?=[]{}"
        let reflected = "reflected:" + sentinel
        precondition(client.redact(reflected).contains(sentinel))
        precondition(!client.redact(reflected, sensitiveValues: [sentinel]).contains(sentinel))
        let homeJSONData = try JSONSerialization.data(withJSONObject: [
            "root": FileManager.default.homeDirectoryForCurrentUser.path,
            "ok": true
        ])
        let homeJSON = String(data: homeJSONData, encoding: .utf8)!
        let redactedHomeJSON = client.redact(homeJSON)
        let redactedHomePayload = try JSONSerialization.jsonObject(
            with: Data(redactedHomeJSON.utf8)
        ) as! [String: Any]
        precondition(redactedHomePayload["root"] as? String == "[redacted]")
        precondition(redactedHomePayload["ok"] as? Bool == true)

        let secure = waitForResult(
            client,
            arguments: ["codex-lb", "set-key", "--api-key-stdin", "--json"],
            stdin: sentinel + "\\n"
        )
        precondition(secure.code == 0)
        precondition(!secure.output.contains(sentinel))
        let securePayload = try JSONSerialization.jsonObject(with: Data(secure.output.utf8)) as! [String: Any]
        precondition(securePayload["ok"] as? Bool == true)
        precondition(securePayload["output_suppressed"] as? Bool == true)
        precondition(securePayload["source_schema"] as? String == "sks.codex-lb-set-key.v2")
        let secureLog = try String(contentsOfFile: log, encoding: .utf8)
        precondition(!secureLog.contains(sentinel))
        precondition(secureLog.contains("--api-key-stdin"))
        precondition(secureLog.contains(#""output_suppressed":true"#))
        let permissions = try FileManager.default.attributesOfItem(atPath: log)[.posixPermissions] as? NSNumber
        precondition(permissions?.intValue == 0o600)

        let failed = waitForResult(
            client,
            arguments: ["codex-lb", "set-key", "--api-key-stdin", "--json", "--fail"],
            stdin: sentinel + "\\n"
        )
        precondition(failed.code == 1)
        precondition(!failed.output.contains(sentinel))
        precondition(failed.output.contains("secure_input_rejected"))
        let failedPayload = try JSONSerialization.jsonObject(with: Data(failed.output.utf8)) as! [String: Any]
        precondition(failedPayload["ok"] as? Bool == false)
        let failedLog = try String(contentsOfFile: log, encoding: .utf8)
        precondition(!failedLog.contains(sentinel))
        precondition(failedLog.contains("secure_input_rejected"))

        let plainSuccess = waitForResult(
            client,
            arguments: ["codex-lb", "set-key", "--api-key-stdin", "--json", "--plain-success"],
            stdin: sentinel + "\\n"
        )
        precondition(plainSuccess.code == 0)
        let plainPayload = try JSONSerialization.jsonObject(with: Data(plainSuccess.output.utf8)) as! [String: Any]
        precondition(plainPayload["ok"] as? Bool == false)
        precondition(plainPayload["error"] as? String == "secure_input_operation_invalid_json")

        let logicalFailure = waitForResult(
            client,
            arguments: ["codex-lb", "set-key", "--api-key-stdin", "--json", "--logical-fail"],
            stdin: sentinel + "\\n"
        )
        precondition(logicalFailure.code == 0)
        let logicalPayload = try JSONSerialization.jsonObject(with: Data(logicalFailure.output.utf8)) as! [String: Any]
        precondition(logicalPayload["ok"] as? Bool == false)
        precondition(logicalPayload["error"] as? String == "secure_input_operation_rejected")

        let unexpectedSchema = waitForResult(
            client,
            arguments: ["codex-lb", "set-key", "--api-key-stdin", "--json", "--unexpected-schema"],
            stdin: sentinel + "\\n"
        )
        precondition(unexpectedSchema.code == 0)
        let unexpectedPayload = try JSONSerialization.jsonObject(with: Data(unexpectedSchema.output.utf8)) as! [String: Any]
        precondition(unexpectedPayload["ok"] as? Bool == false)
        precondition(unexpectedPayload["error"] as? String == "secure_input_operation_unexpected_schema")

        let partial = waitForResult(
            client,
            arguments: ["codex-lb", "set-key", "--api-key-stdin", "--json", "--partial"],
            stdin: sentinel + "\\n"
        )
        precondition(partial.code == 1)
        precondition(!partial.output.contains(sentinel))
        let partialPayload = try JSONSerialization.jsonObject(with: Data(partial.output.utf8)) as! [String: Any]
        precondition(partialPayload["ok"] as? Bool == false)
        let partialConfiguration = partialPayload["partial_configuration"] as! [String: Any]
        precondition(partialConfiguration["keychain_state"] as? String == "replacement_retained")
        precondition(partialConfiguration["ignored_secret"] == nil)
        precondition((partialPayload["recovery_paths"] as? [String]) == ["/tmp/sks-recovery", "/tmp/sks-backup"])
        precondition((partialPayload["secret_recovery_paths"] as? [String]) == ["/tmp/sks-secret-recovery", "/tmp/sks-secret-backup"])

        let ordinary = "ordinary-input"
        let normal = waitForResult(client, arguments: ["echo"], stdin: ordinary + "\\n")
        precondition(normal.code == 0)
        precondition(normal.output.contains(ordinary))
        let normalLog = try String(contentsOfFile: log, encoding: .utf8)
        precondition(normalLog.contains(ordinary))
        print("process-client-secret-runtime-ok")
    }
}
`);

  const source = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', 'ProcessClient.swift');
  const executionState = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', 'ProcessExecutionState.swift');
  const identityGuard = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', 'ProcessIdentityGuard.swift');
  const secureEnvelope = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', 'SecureProcessEnvelope.swift');
  const compiled = await run('swiftc', ['-framework', 'Cocoa', source, executionState, identityGuard, secureEnvelope, harness, '-o', binary]);
  assert.equal(compiled.code, 0, `${compiled.stdout}\n${compiled.stderr}`);
  const executed = await run(binary, [action, log, temp]);
  assert.equal(executed.code, 0, `${executed.stdout}\n${executed.stderr}`);
  assert.match(executed.stdout, /process-client-secret-runtime-ok/);
});

test('ProcessIdentityGuard refuses stale PID and process-group signals after PID reuse', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Darwin process identity runtime required');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-process-identity-guard-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const harness = path.join(temp, 'Harness.swift');
  const binary = path.join(temp, 'process-identity-guard-harness');
  await fs.writeFile(harness, `
import Darwin
import Foundation

@main
struct Harness {
    static func main() {
        let pid: pid_t = 4242
        let stale = OwnedProcessIdentity(pid: pid, startSeconds: 10, startMicroseconds: 20)
        let replacement = OwnedProcessIdentity(pid: pid, startSeconds: 30, startMicroseconds: 40)
        var current: OwnedProcessIdentity? = replacement
        var signals: [(pid_t, Int32)] = []
        let guarder = ProcessIdentityGuard(
            identityLookup: { requested in requested == pid ? current : nil },
            processGroupLookup: { _ in pid },
            processGroupExists: { _ in true },
            processSignal: { target, signal in
                signals.append((target, signal))
                return 0
            }
        )

        precondition(!guarder.signalIfCurrent(stale, signal: SIGKILL))
        precondition(!guarder.signalProcessGroupIfOwned(
            pid,
            rootIdentity: stale,
            descendants: [],
            signal: SIGKILL
        ))
        precondition(signals.isEmpty)

        current = stale
        precondition(guarder.signalIfCurrent(stale, signal: SIGKILL))
        precondition(guarder.signalProcessGroupIfOwned(
            pid,
            rootIdentity: stale,
            descendants: [],
            signal: SIGKILL
        ))
        precondition(signals.count == 2)
        precondition(signals[0].0 == pid)
        precondition(signals[1].0 == -pid)
        print("process-identity-reuse-guard-ok")
    }
}
`);
  const source = path.join(
    process.cwd(),
    'native',
    'sks-menubar',
    'Sources',
    'ProcessIdentityGuard.swift'
  );
  const compiled = await run('swiftc', [source, harness, '-o', binary]);
  assert.equal(compiled.code, 0, `${compiled.stdout}\n${compiled.stderr}`);
  const executed = await run(binary, []);
  assert.equal(executed.code, 0, `${executed.stdout}\n${executed.stderr}`);
  assert.match(executed.stdout, /process-identity-reuse-guard-ok/);
});

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
