import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchAgentSource } from '../menubar/launch-agent.js';
import { readMenuBarConfig, writeDefaultMenuBarConfig } from '../menubar/config.js';
import { resolvePackagedMenuBarSourceRoot } from '../menubar/index.js';

test('legacy quit-with-Codex preference migrates to non-terminating lifecycle follow mode', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-menubar-config-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  await fsp.writeFile(configPath, JSON.stringify({
    schema: 'sks.sks-menubar-config.v1',
    codex_bundle_id: 'com.openai.codex',
    quit_with_codex: true
  }));

  const migrated = await readMenuBarConfig(configPath) as any;
  assert.equal(migrated.schema, 'sks.sks-menubar-config.v2');
  assert.equal(migrated.follow_codex_lifecycle, true);
  assert.equal(Object.hasOwn(migrated, 'quit_with_codex'), false);

  await writeDefaultMenuBarConfig(configPath, 'com.openai.codex');
  const persisted = JSON.parse(await fsp.readFile(configPath, 'utf8'));
  assert.equal(persisted.schema, 'sks.sks-menubar-config.v2');
  assert.equal(persisted.follow_codex_lifecycle, true);
  assert.equal(Object.hasOwn(persisted, 'quit_with_codex'), false);
});

test('launch agent keeps the observer resident so a later Codex launch is observable', (t) => {
  if (process.platform !== 'darwin') return t.skip('launchd plist contract is macOS-only');
  const source = launchAgentSource('/tmp/SKSMenuBar', '/tmp/sks-menubar');
  const parsed = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
    input: source,
    encoding: 'utf8'
  });
  assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
  const plist = JSON.parse(parsed.stdout);
  assert.equal(plist.RunAtLoad, true);
  assert.equal(plist.KeepAlive, true);
});

test('Codex lifecycle visibility policy preserves an observer across cold start and termination', (t) => {
  if (process.platform !== 'darwin') return t.skip('Swift lifecycle contract is macOS-only');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-lifecycle-policy-'));
  const harness = path.join(root, 'LifecycleHarness.swift');
  const binary = path.join(root, 'lifecycle-harness');
  try {
    fs.writeFileSync(harness, `
import Foundation

@main
struct LifecycleHarness {
    static func main() {
        precondition(CodexLifecyclePolicy.initialVisibility(followCodex: false, codexRunning: false))
        precondition(!CodexLifecyclePolicy.initialVisibility(followCodex: true, codexRunning: false))
        precondition(CodexLifecyclePolicy.initialVisibility(followCodex: true, codexRunning: true))
        precondition(CodexLifecyclePolicy.visibilityAfterCodexLaunch())
        precondition(!CodexLifecyclePolicy.visibilityAfterCodexTermination(followCodex: true))
        precondition(CodexLifecyclePolicy.visibilityAfterCodexTermination(followCodex: false))
    }
}
`);
    const policy = path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'CodexLifecyclePolicy.swift');
    const compiled = spawnSync('swiftc', [policy, harness, '-o', binary], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
    const executed = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(executed.status, 0, executed.stderr || executed.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bridge status truth accepts nested status without the envelope trio and keeps it type-checked when present', (t) => {
  if (process.platform !== 'darwin') return t.skip('Swift provider truth contract is macOS-only');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-status-envelope-truth-'));
  const harness = path.join(root, 'StatusEnvelopeHarness.swift');
  const binary = path.join(root, 'status-envelope-harness');
  try {
    fs.writeFileSync(harness, `
import Foundation

@main
struct StatusEnvelopeHarness {
    static func profile(_ id: String) -> [String: Any] {
        ["schema": "sks.bridge-provider-profile-status.v1", "provider_id": id, "enabled": true,
         "credential": [String: Any](), "endpoint": [String: Any](),
         "catalog": ["schema": "sks.catalog-sync-state.v2"],
         "capabilities": ["schema": "sks.scope-capability-summary.v1", "scope": "provider:\\(id)"]]
    }

    static func nestedStatus() -> [String: Any] {
        [
            "schema": "sks.desktop-bridge-status.v3",
            "checked_at": "2026-08-08T00:00:00.000Z",
            "correlation_id": "correlation-1",
            "management": ["managed": true, "runtime": "desktop-bridge", "state": "ready", "reason": NSNull()],
            "service": ["installed": true, "loaded": true, "running": true, "checked_at": "2026-08-08T00:00:00.000Z"],
            "http_probe": NSNull(),
            "websocket_probe": NSNull(),
            "native_identity": ["configured": true],
            "providers": ["codex-lb": profile("codex-lb"), "openrouter": profile("openrouter")],
            "routing": ["fallback": "none"],
            "catalog_sync": ["schema": "sks.combined-catalog-sync.v1", "state": "verified", "conflict_count": 0,
                             "providers": [String: Any](), "blockers": [String](), "warnings": [String]()],
            "readiness": ["ready": true, "state": "ready"],
            "recovery_actions": [String](),
            "capabilities": NSNull()
        ]
    }

    static func main() throws {
        // The status nested inside a command result never carries the trio.
        let nested = try DesktopBridgeStatusV3Truth.decode(from: nestedStatus())
        precondition(nested.correlationId == "correlation-1")

        var topLevel = nestedStatus()
        topLevel["ok"] = true
        topLevel["execution_ok"] = true
        topLevel["command_summary"] = "Desktop Bridge status"
        _ = try DesktopBridgeStatusV3Truth.decode(from: topLevel)

        var mistyped = topLevel
        mistyped["ok"] = "true"
        do {
            _ = try DesktopBridgeStatusV3Truth.decode(from: mistyped)
            preconditionFailure("string ok must fail the envelope type check")
        } catch ProviderFacadeError.schemaInvalid { }

        mistyped = topLevel
        mistyped["command_summary"] = ""
        do {
            _ = try DesktopBridgeStatusV3Truth.decode(from: mistyped)
            preconditionFailure("empty command_summary must fail the envelope type check")
        } catch ProviderFacadeError.schemaInvalid { }

        var unknownKey = nestedStatus()
        unknownKey["unexpected_key"] = true
        do {
            _ = try DesktopBridgeStatusV3Truth.decode(from: unknownKey)
            preconditionFailure("unknown top-level keys must stay rejected")
        } catch ProviderFacadeError.schemaInvalid { }
    }
}
`);
    const truth = path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'ProvidersRoutingTruth.swift');
    const compiled = spawnSync('swiftc', [path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'AuthPriorityState.swift'), truth, harness, '-o', binary], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
    const executed = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(executed.status, 0, executed.stderr || executed.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('provider truth rejects partial repair success and filters verified matrix noise', (t) => {
  if (process.platform !== 'darwin') return t.skip('Swift provider truth contract is macOS-only');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-provider-truth-'));
  const harness = path.join(root, 'ProviderTruthHarness.swift');
  const binary = path.join(root, 'provider-truth-harness');
  try {
    fs.writeFileSync(harness, `
import Foundation

@main
struct ProviderTruthHarness {
    static func main() throws {
        let partial: [String: Any] = [
            "schema": "sks.desktop-bridge-command-result.v1",
            "operation": "repair",
            "operation_id": "operation-1",
            "correlation_id": "correlation-1",
            "checked_at": "2026-08-07T00:00:00.000Z",
            "ok": true,
            "execution": ["ok": true, "status": "partial", "blockers": ["historical_native_bridge_selection_mismatch"]],
            "readiness": ["ready": false, "blockers": ["historical_native_bridge_selection_mismatch"], "warnings": []],
            "status": NSNull(),
            "result": [:],
            "recovery_action": "review_config_manually",
            "execution_ok": true,
            "command_summary": "Desktop Bridge repair"
        ]
        let partialTruth = try DesktopBridgeCommandResultTruth.decode(from: partial, expectedOperation: "repair")
        precondition(!partialTruth.completed)
        precondition(partialTruth.blockers == ["historical_native_bridge_selection_mismatch"])
        precondition(partialTruth.recoveryAction == "review_config_manually")

        var completed = partial
        completed["execution"] = ["ok": true, "status": "completed", "blockers": []]
        completed["readiness"] = ["ready": true, "blockers": [], "warnings": []]
        completed["result"] = ["service": ["ok": true, "running": true]]
        completed["recovery_action"] = NSNull()
        let completedTruth = try DesktopBridgeCommandResultTruth.decode(from: completed, expectedOperation: "repair")
        precondition(completedTruth.completed)

        var falseCompletion = completed
        falseCompletion["result"] = ["service": ["ok": false, "running": false]]
        do {
            _ = try DesktopBridgeCommandResultTruth.decode(from: falseCompletion, expectedOperation: "repair")
            preconditionFailure("nested service failure must invalidate a completed repair")
        } catch ProviderFacadeError.schemaInvalid { }

        var inconsistentExecutionOk = completed
        inconsistentExecutionOk["execution_ok"] = false
        do {
            _ = try DesktopBridgeCommandResultTruth.decode(from: inconsistentExecutionOk, expectedOperation: "repair")
            preconditionFailure("execution_ok must agree with execution.ok")
        } catch ProviderFacadeError.schemaInvalid { }

        let rows = [
            CapabilityDisplayRow(scope: .bridge, capability: "health", state: .verified, route: "bridge", oauthRequirement: "not required", checkedAt: "now", stage: .complete, rootCause: nil, recoveryAction: nil),
            CapabilityDisplayRow(scope: .codexLb, capability: "models", state: .failed, route: "codex-lb", oauthRequirement: "not required", checkedAt: "now", stage: .featureRequest, rootCause: "upstream_failed", recoveryAction: "run_deep_verification"),
            CapabilityDisplayRow(scope: .openRouter, capability: "voice", state: .notAttempted, route: "openrouter", oauthRequirement: "not required", checkedAt: "now", stage: .preflight, rootCause: nil, recoveryAction: nil)
        ]
        precondition(CapabilityDisplayFilter.rows(rows, showAll: false).map(\\.capability) == ["models"])
        precondition(CapabilityDisplayFilter.rows(rows, showAll: true).count == 3)
        precondition(CapabilityDisplayFilter.issueCount(rows) == 1)
    }
}
`);
    const truth = path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'ProvidersRoutingTruth.swift');
    const compiled = spawnSync('swiftc', [path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'AuthPriorityState.swift'), truth, harness, '-o', binary], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
    const executed = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(executed.status, 0, executed.stderr || executed.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
