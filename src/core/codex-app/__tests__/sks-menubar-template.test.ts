import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actionScriptSource,
  aggregateFileHashes,
  createSksMenuBarBuildStamp,
  evaluateActionScriptIntegrity,
  infoPlistSource,
  loadNativeMenuBarSources,
  nativeResourceHashes,
  NATIVE_RESOURCE_FILES,
  NATIVE_SOURCE_FILES,
  resolvePackagedMenuBarSourceRoot,
  swiftMenuSource
} from '../menubar/index.js';
import { sha256 } from '../../fsx.js';
import { UPDATE_STAGE_ORDER } from '../../update-check.js';

function source(codexBundleId: string | null = 'com.openai.codex') {
  return swiftMenuSource({
    actionScriptPath: '/tmp/sks-menubar-action.sh',
    buildStampPath: '/tmp/build-stamp.json',
    configPath: '/tmp/config.json',
    lastActionLogPath: '/tmp/logs/last-action.log',
    operationDirPath: '/tmp/operations',
    codexBundleId,
    packageVersion: '6.3.0'
  });
}

test('SKS Menu Bar uses the required split native source and resource inventory', () => {
  const root = resolvePackagedMenuBarSourceRoot();
  assert.deepEqual([...NATIVE_SOURCE_FILES], [
    'main.swift', 'AppDelegate.swift', 'StatusItemController.swift',
    'ControlCenterWindowController.swift', 'SidebarItem.swift', 'ControlKit.swift',
    'OverviewViewController.swift', 'OverviewSummary.swift', 'UpdatesViewController.swift',
    'MCPServersViewController.swift', 'ProvidersViewController.swift', 'ProvidersReliability.swift',
    'ProvidersRoutingTruth.swift',
    'ProvidersOpenRouter.swift',
    'ProvidersBridgeCatalog.swift',
    'RemoteCodingViewController.swift',
    'DiagnosticsViewController.swift',
    'SettingsViewController.swift', 'OperationModels.swift', 'OperationCoordinator.swift',
    'ProcessClient.swift', 'ProcessExecutionState.swift', 'ProcessIdentityGuard.swift',
    'SecureProcessEnvelope.swift', 'SKSKeychainStore.swift',
    'TelegramStateLock.swift',
    'TelegramPrivateFileSupport.swift',
    'TelegramPrivateFileStore.swift', 'TelegramSupport.swift', 'TelegramRuntimeSupport.swift', 'TelegramTransport.swift',
    'TelegramProcessGateway.swift',
    'NotificationCoordinator.swift', 'AlertFactory.swift',
    'AppIdentity.swift', 'SingletonInstanceGuard.swift'
  ]);
  assert.deepEqual([...NATIVE_RESOURCE_FILES], [
    'AppIcon.icns', 'SKSStatusTemplate.pdf', 'SKSStatusUpdateTemplate.pdf',
    'SKSStatusWarningTemplate.pdf', 'SKSStatusAttentionTemplate.pdf',
    'Localizable.strings'
  ]);
  for (const name of NATIVE_SOURCE_FILES) assert.ok(fs.statSync(path.join(root, 'Sources', name)).size > 0, name);
  for (const name of NATIVE_RESOURCE_FILES) assert.ok(fs.statSync(path.join(root, 'Resources', name)).size > 0, name);
  assert.match(fs.readFileSync(path.join(root, 'Resources', 'AppIcon.icns')).subarray(0, 4).toString('ascii'), /icns/);
  const materialized = source();
  assert.match(materialized, /\/\/ MARK: - ProvidersBridgeCatalog\.swift/);
  assert.doesNotMatch(materialized, /MultiProviderRouterControls|ProvidersConnectTest/);
  assert.match(materialized, /One managed Desktop Bridge routes through independent Codex-LB and OpenRouter profiles/);
  assert.match(materialized, /\["bridge", "route", "explain", model, "--json"\]/);
  assert.doesNotMatch(materialized, /model\.contains\("\/"\) \? model :/);
});

test('status template resources are distinct valid 18x18 PDFs', () => {
  const resources = path.join(resolvePackagedMenuBarSourceRoot(), 'Resources');
  const names = [
    'SKSStatusTemplate.pdf',
    'SKSStatusUpdateTemplate.pdf',
    'SKSStatusWarningTemplate.pdf',
    'SKSStatusAttentionTemplate.pdf'
  ];
  const digests = names.map((name) => {
    const bytes = fs.readFileSync(path.join(resources, name));
    const pdf = bytes.toString('latin1');
    assert.match(pdf, /^%PDF-\d\.\d/, `${name}: PDF header`);
    assert.match(pdf, /\/Type\s*\/Catalog\b/, `${name}: catalog`);
    assert.match(pdf, /\/Type\s*\/Pages\b/, `${name}: pages tree`);
    assert.match(pdf, /\/Type\s*\/Page\b/, `${name}: page`);
    assert.match(pdf, /\/MediaBox\s*\[\s*0\s+0\s+18\s+18\s*\]/, `${name}: 18x18 MediaBox`);
    const startXref = pdf.match(/startxref\s+(\d+)\s+%%EOF\s*$/);
    assert.ok(startXref, `${name}: startxref and EOF`);
    assert.equal(pdf.slice(Number(startXref[1]), Number(startXref[1]) + 4), 'xref', `${name}: xref offset`);
    return sha256(bytes);
  });
  assert.equal(new Set(digests).size, names.length, 'every status glyph PDF must have a distinct SHA-256');
});

test('status template keeps Control Center reachable on cold start before Codex launches', () => {
  const status = fs.readFileSync(path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'StatusItemController.swift'), 'utf8');
  assert.match(status, /Keep the status item visible on cold start/);
  assert.match(status, /statusItem\.isVisible = true/);
  assert.doesNotMatch(status, /statusItem\.isVisible = NSWorkspace\.shared\.runningApplications\.contains/);
  assert.match(status, /else \{[\s\S]{0,400}self\?\.statusItem\.isVisible = true/);
  assert.doesNotMatch(status, /else \{ self\?\.statusItem\.isVisible = false \}/);
});

test('runtime materialization injects paths, version, and optional Codex bundle id without unresolved tokens', () => {
  const withCodex = source('com.openai.codex');
  const withoutCodex = source(null);
  assert.match(withCodex, /static let codexBundleId: String\? = "com\.openai\.codex"/);
  assert.match(withoutCodex, /static let codexBundleId: String\? = nil/);
  assert.match(withCodex, /static let operationDirectory = "\/tmp\/operations"/);
  assert.match(withCodex, /static let packageVersion = "6\.3\.0"/);
  assert.doesNotMatch(withCodex, /__SKS_[A-Z_]+__/);
  assert.match(withCodex, /NSWorkspace\.didLaunchApplicationNotification/);
  assert.match(withCodex, /NSWorkspace\.didTerminateApplicationNotification/);
  assert.match(withCodex, /if config\?\["quit_with_codex"\] as\? Bool == true/);
  assert.match(withCodex, /else \{[\s\S]{0,400}self\?\.statusItem\.isVisible = true/);
  assert.doesNotMatch(withCodex, /else \{ self\?\.statusItem\.isVisible = false \}/);
  assert.match(withCodex, /applicationShouldHandleReopen\(_ sender: NSApplication, hasVisibleWindows flag: Bool\)/);
  assert.match(withCodex, /controlCenter\?\.show\(section: \.overview\)/);
  assert.match(withCodex, /switch singletonGuard\.acquire\(\)/);
  assert.match(withCodex, /case \.lostArbitration:\s*exit\(EXIT_SUCCESS\)/);
  assert.match(withCodex, /case \.degraded:\s*break/);
});

test('Control Center is a non-modal seven-section AppKit sidebar with native accessibility', () => {
  const swift = source();
  for (const section of ['Overview', 'Updates', 'MCP Servers', 'Providers', 'Remote Coding', 'Diagnostics', 'Settings']) {
    assert.match(swift, new RegExp(`= "${section.replace(/[&]/g, '\\&')}"`));
  }
  assert.match(swift, /styleMask: \[\.titled, \.closable, \.miniaturizable, \.resizable\]/);
  assert.match(swift, /window\.isReleasedWhenClosed = false/);
  assert.match(swift, /NSFont\.systemFont/);
  assert.match(swift, /\.secondaryLabelColor/);
  assert.match(swift, /setAccessibilityLabel\("Control Center sections"\)/);
  assert.match(swift, /setAccessibilityLabel\("Effective MCP servers"\)/);
  assert.match(swift, /button\.setAccessibilityLabel\(title\)/);
  assert.match(swift, /setAccessibilityIdentifier\("sks-center-page-/);
  assert.match(swift, /view\.widthAnchor\.constraint\(equalTo: stack\.widthAnchor, constant: -48\)/);
  assert.match(swift, /box\.setAccessibilityRole\(\.group\)/);
  assert.match(swift, /setContentCompressionResistancePriority\(\.defaultLow, for: \.horizontal\)/);
  assert.match(swift, /setAccessibilityIdentifier\("sks-center-heading-/);
  assert.match(swift, /protocol ControlCenterPage: AnyObject/);
  assert.match(swift, /func refreshOnAppear\(\)/);
  assert.match(swift, /NativeView\.scrollable\(controller\.view\)/);
  assert.match(swift, /scroll\.scrollerStyle = \.overlay/);
  assert.match(swift, /let preservedFrame = window\?\.frame/);
  assert.match(swift, /window\?\.setFrame\(preservedFrame, display: true\)/);
  assert.match(swift, /if !hasPresented/);
  assert.doesNotMatch(swift, /runModal\s*\(/);
  assert.doesNotMatch(swift, /NSAnimationContext|animator\(\)/);
  assert.match(swift, /accessibilityDisplayShouldReduceMotion/);
});

test('Overview renders every release work-order health field from bounded local commands', () => {
  const swift = source();
  const overview = [
    'OverviewViewController.swift',
    'OverviewSummary.swift'
  ].map((name) => fs.readFileSync(
    path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', name),
    'utf8'
  )).join('\n');
  for (const field of ['SKS install:', 'Codex CLI:', 'Codex app:', 'Menu Bar:', 'Updates:', 'MCP:', 'Last operation:']) {
    assert.match(overview, new RegExp(field));
  }
  assert.ok(overview.includes('Menu Bar build \\(AppRuntime.packageVersion)'));
  assert.ok(overview.includes('running build \\(menuBarBuild)'));
  assert.match(overview, /snapshotSource\(update\["source"\] as\? String\)/);
  assert.ok(overview.includes('notice: \\(error)'));
  assert.match(overview, /diagnosticNotice\(update\["public_error"\] as\? String, update: update\)/);
  assert.match(overview, /MCP: unavailable/);
  assert.match(overview, /validatedUpdate\(update\)/);
  assert.match(overview, /validatedMCP\(mcp\)/);
  assert.ok(!overview.includes('installed \\(menu?["installed_version"] as? String ?? "unknown")'));
  assert.doesNotMatch(overview, /Telegram|telegram/);
  assert.match(overview, /"mcp", "config", "list", "--scope", "effective",[\s\S]*"--project-root", AppRuntime\.projectRoot, "--trusted-project", "--json"/);
  assert.match(overview, /\], timeout: 3\)/);
  assert.match(overview, /loadStatus\(forceUpdateRefresh: false\)/);
  assert.match(overview, /loadStatus\(forceUpdateRefresh: true\)/);
  assert.match(overview, /if forceUpdateRefresh \{ updateArguments\.append\("--refresh"\) \}/);
  assert.match(overview, /DispatchQueue\.main\.asyncAfter\(deadline: \.now\(\) \+ 5\)/);
  assert.match(overview, /if age > 24 \* 60 \* 60 \{ return "None in the last 24 hours" \}/);
  assert.match(overview, /codexUpdateInducement/);
  assert.match(overview, /Action: update Codex CLI/);
  assert.match(overview, /NativeView\.button\("Update Codex CLI"/);
  assert.match(overview, /\["codex", "update", "--json"\]/);
  assert.ok(overview.includes('stale \\(operation.state.rawValue) record · review operation log'));
  assert.match(swift, /func latestSnapshot\(\) -> OperationSnapshot\?/);
});

test('Diagnostics induces Codex CLI updates with a guarded action', () => {
  const diagnostics = fs.readFileSync(path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'DiagnosticsViewController.swift'), 'utf8');
  assert.match(diagnostics, /NativeView\.button\("Update Codex CLI"/);
  assert.match(diagnostics, /\["codex", "update", "--json"\]/);
  assert.match(diagnostics, /prefer the latest channel/);
  assert.match(diagnostics, /operations\.begin\(kind: "codex-cli-update", mutationGroup: "update"/);
  assert.match(diagnostics, /sks\.codex-cli-update-result\.v1/);
  assert.match(diagnostics, /Codex CLI update available/);
});

test('Overview summary distinguishes Menu Bar build, installed SKS, cached status, and unavailable probes', (t) => {
  if (process.platform !== 'darwin') return t.skip('Swift AppKit overview harness is macOS-only');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-overview-summary-'));
  const harness = path.join(root, 'OverviewHarness.swift');
  const binary = path.join(root, 'overview-harness');
  try {
    fs.writeFileSync(harness, `
import Cocoa
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
    static let packageVersion = "6.2.0"
    static let codexBundleId: String? = nil
    static let projectRoot = "/tmp"
    static let canonicalProjectRoot = sksCanonicalFilesystemPath(projectRoot)
}

struct ProcessResult { let code: Int32; let output: String; let truncated: Bool }
final class ProcessClient {
    func run(_ arguments: [String], stdin: String? = nil, environment: [String: String] = [:], timeout: TimeInterval? = nil, completion: @escaping (ProcessResult) -> Void) {}
}
enum OperationState: String { case succeeded, failed, running }
enum OperationProgressSignal: String { case evidence, fileChange, testResult, modelResponse, toolResponse, none }
enum OperationRecoveryCause: String { case transientNetwork, authentication, providerMode, accountBinding, externalConfiguration, unknown }
enum OperationRecoveryState: String { case active, warning, autoResumePending, pausedResumable }
struct OperationRecoveryStatus {
    let state: OperationRecoveryState
    let cause: OperationRecoveryCause?
    let automaticResume: Bool
    let retryCount: Int
    let maxAutomaticRetries: Int
    let lastProgressSignal: OperationProgressSignal
    let lastProgressAt: String
    let stallReason: String?
    let recoveryAttempt: String?
    let nextAction: String
    let pinnedMode: String?
    let pinnedModel: String?
    let accountBinding: String
    let evidenceIntegrity: String
}
struct OperationSnapshot {
    let kind: String
    let state: OperationState
    let publicSummary: String
    let updatedAt: String
    let stage: String?
    let recovery: OperationRecoveryStatus?
}
final class OperationCoordinator {
    func latestSnapshot() -> OperationSnapshot? { nil }
    func begin(kind: String, mutationGroup: String?, summary: String) -> OperationSnapshot? { nil }
    func update(_ snapshot: OperationSnapshot, state: OperationState, stage: String?, progress: Double?, summary: String, retryable: Bool = true) -> OperationSnapshot { snapshot }
}
enum SKSTimestamp { static func date(from value: String) -> Date? { ISO8601DateFormatter().date(from: value) } }

@main
struct OverviewHarness {
    static func main() {
        let update: [String: Any] = [
            "schema": "sks.update-status.v3",
            "source": "cache",
            "sks": ["current": "1.10.0", "latest": "99.99.99", "update_available": true],
            "codex_cli": ["current": "0.144.4", "latest": "0.145.0", "update_available": true],
            "menubar": [
                "expected_version": "6.2.0", "installed_version": NSNull(),
                "signature_ok": true, "resources_ok": true, "rebuild_required": true
            ],
            "update_count": 2,
            "warnings": [],
            "public_error": "fixture cache"
        ]
        let rendered = OverviewSummary.render(
            update: update, mcp: nil,
            menuBarBuild: "6.2.0", codexRunning: true, operationSummary: "None recorded"
        )
        precondition(rendered.contains("SKS install: 1.10.0 → 99.99.99 available"))
        precondition(rendered.contains("Codex CLI: 0.144.4 → 0.145.0 available"))
        precondition(rendered.contains("Action: update Codex CLI (0.144.4 → 0.145.0)"))
        precondition(rendered.contains("Menu Bar: running build 6.2.0 · expected 6.2.0 · rebuild required"))
        precondition(!rendered.contains("installed unknown"))
        precondition(rendered.contains("Updates: 2 pending · cache snapshot · notice: fixture cache"))
        precondition(rendered.contains("MCP: unavailable"))

        let unavailable = OverviewSummary.render(
            update: nil, mcp: nil,
            menuBarBuild: "6.2.0", codexRunning: nil, operationSummary: "None recorded"
        )
        precondition(unavailable.contains("SKS install: unavailable"))
        precondition(unavailable.contains("Updates: unavailable"))

        let partial = OverviewSummary.render(
            update: ["source": "cache", "sks": [:], "codex_cli": [:], "menubar": [:]],
            mcp: [:],
            menuBarBuild: "6.2.0", codexRunning: nil, operationSummary: "None recorded"
        )
        precondition(partial.contains("Menu Bar: running build 6.2.0 · update status unavailable"))
        precondition(partial.contains("Updates: unavailable"))
        precondition(partial.contains("MCP: unavailable"))

        let aheadOfRegistry: [String: Any] = [
            "schema": "sks.update-status.v3",
            "source": "stale",
            "sks": ["current": "7.1.0", "latest": "7.0.5", "update_available": false],
            "codex_cli": ["current": "0.145.0", "latest": "0.145.0", "update_available": false],
            "menubar": ["expected_version": "7.1.0", "rebuild_required": false],
            "update_count": 0,
            "warnings": [],
            "public_error": NSNull()
        ]
        let aheadRendered = OverviewSummary.render(
            update: aheadOfRegistry, mcp: nil,
            menuBarBuild: "7.1.0", codexRunning: true, operationSummary: "None recorded"
        )
        precondition(aheadRendered.contains("SKS install: 7.1.0 · registry last seen 7.0.5"))
    }
}
`);
    const sourceRoot = path.join(resolvePackagedMenuBarSourceRoot(), 'Sources');
    const overview = path.join(sourceRoot, 'OverviewViewController.swift');
    const summary = path.join(sourceRoot, 'OverviewSummary.swift');
    const compiled = spawnSync('swiftc', [summary, overview, harness, '-o', binary], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
    const executed = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(executed.status, 0, executed.stderr || executed.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('status item is concise and applies the documented integrity-to-healthy priority', () => {
  const swift = source();
  for (const item of [
    'Open SKS Control Center…', 'Pending approvals (0)',
    'Check for Updates', 'Update Codex CLI Now', 'Open Updates…', 'View Last Operation', 'Quit SKS Menu'
  ]) assert.match(swift, new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(swift, /\["codex", "update", "--json"\]/);
  assert.match(swift, /openControlCenter\(\.updates\)/);
  assert.doesNotMatch(swift, /Open Dashboard|openDashboard|127\.0\.0\.1:4477/);
  assert.match(swift, /enum SKSStatusIcon \{\s*case healthy, working, attention, updateAvailable, warning\s*\}/);
  const priority = [
    'if integrityBroken', 'else if operationFailed',
    'else if actionRequired || notificationAuthorizationDenied || pendingCount > 0',
    'else if sksUpdate || codexUpdate', 'else if operationRunning',
    'else { icon = .healthy'
  ].map((needle) => swift.indexOf(needle));
  assert.ok(priority.every((index) => index >= 0));
  assert.deepEqual(priority, [...priority].sort((a, b) => a - b));
  assert.match(swift, /hydrateFromLatestOperation/);
  assert.match(swift, /case \.healthy, \.working: pair = \("SKSStatusTemplate", "textformat"\)/);
  assert.match(swift, /case \.updateAvailable: pair = \("SKSStatusUpdateTemplate", "arrow\.down\.circle"\)/);
  assert.doesNotMatch(swift, /checkmark\.circle|ellipsis\.circle/);
  assert.ok(swift.includes('setAccessibilityLabel("SKS status — \\(summary)")'));
  assert.match(swift, /setAccessibilityValue\(summary\)/);
  assert.ok(swift.includes('toolTip = "SKS Control Center — \\(summary)"'));
  assert.match(swift, /Pending approvals \(\\\(pendingCount\)\)/);
  assert.match(swift, /NSImage\(systemSymbolName: symbol, accessibilityDescription: "SKS status"\)/);
  assert.match(swift, /Bundle\.main\.image\(forResource: resource\)/);
  assert.match(swift, /SKSStatusWarningTemplate/);
  assert.doesNotMatch(swift, /SKS [↑⚠⬆⋯]/);
});

test('Control Center scroll documents start at the top and stale local versions self-refresh', () => {
  const overview = fs.readFileSync(path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'OverviewViewController.swift'), 'utf8');
  assert.match(overview, /final class TopAlignedStackView: NSStackView/);
  assert.match(overview, /override var isFlipped: Bool \{ true \}/);
  assert.match(overview, /let stack = TopAlignedStackView\(views: views\)/);
  assert.match(overview, /updateSnapshotNeedsRefresh\(initial\)/);
  assert.match(overview, /\["update", "status", "--refresh", "--project-root", AppRuntime\.canonicalProjectRoot, "--json"\]/);
});

test('app identity, alert identity, and Info.plist icon contract are explicit', () => {
  const swift = source();
  const plist = infoPlistSource('6.3.0');
  assert.match(swift, /Bundle\.main\.url\(forResource: "AppIcon", withExtension: "icns"\)/);
  assert.match(swift, /NSApplication\.shared\.applicationIconImage = image/);
  assert.match(swift, /alert\.icon = NSApplication\.shared\.applicationIconImage/);
  assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>AppIcon<\/string>/);
  assert.match(plist, /<key>CFBundleDisplayName<\/key>\s*<string>SKS<\/string>/);
  assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
  assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>6\.3\.0<\/string>/);
});

test('confirmation and input flows use sheets and never nest modal loops', () => {
  const swift = source();
  assert.match(swift, /alert\.beginSheetModal\(for: window\)/);
  assert.match(swift, /NSSecureTextField/);
  assert.match(swift, /destructive \? "Remove" : "Continue"/);
  assert.doesNotMatch(swift, /NSApp\.runModal|runModal\s*\(/);
  assert.doesNotMatch(swift, /tell application "Terminal"|runInTerminal|runSksInTerminal/);
});

test('Providers configures independent bridge profiles through masked stdin without exposing secrets', () => {
  const root = resolvePackagedMenuBarSourceRoot();
  const providers = [
    fs.readFileSync(path.join(root, 'Sources', 'ProvidersViewController.swift'), 'utf8'),
    fs.readFileSync(path.join(root, 'Sources', 'ProvidersReliability.swift'), 'utf8'),
    fs.readFileSync(path.join(root, 'Sources', 'ProvidersOpenRouter.swift'), 'utf8')
  ].join('\n');
  const providersSurface = providers;
  const processClient = fs.readFileSync(path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'ProcessClient.swift'), 'utf8');
  const secureEnvelope = fs.readFileSync(path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'SecureProcessEnvelope.swift'), 'utf8');
  const alertFactory = fs.readFileSync(path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'AlertFactory.swift'), 'utf8');
  const appIdentity = fs.readFileSync(path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'AppIdentity.swift'), 'utf8');
  const appDelegate = fs.readFileSync(path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'AppDelegate.swift'), 'utf8');
  assert.match(providers, /title: "Provider Credentials"/);
  assert.match(providers, /Profiles coexist/);
  assert.match(providers, /NativeView\.button\(ProviderReconnectLabel\.codexLb/);
  assert.match(providers, /NativeView\.button\(ProviderReconnectLabel\.openRouter/);
  assert.match(providers, /#selector\(configureCodexLbProfile\)/);
  assert.match(providers, /#selector\(configureOpenRouterProfile\)/);
  assert.match(providers, /secure: true/);
  assert.match(providers, /placeholder: "https:\/\/lb\.example\.com"/);
  assert.match(providers, /placeholder: "sk-clb-…"/);
  assert.match(providers, /placeholder: "sk-or-…"/);
  assert.match(providers, /\["bridge", "provider", "configure", "codex-lb", "--host", host, "--api-key-stdin", "--json"\]/);
  assert.match(providers, /\["bridge", "provider", "configure", "openrouter", "--api-key-stdin", "--json"\]/);
  assert.match(providers, /\["bridge", "provider", "validate", "codex-lb", "--json"\]/);
  assert.match(providers, /\["bridge", "provider", "validate", "openrouter", "--json"\]/);
  assert.doesNotMatch(providers, /"--keychain"/);
  assert.match(providers, /keychainStore\.store\(key, credential: credential, explicitUserAction: true\)/);
  assert.match(providers, /AlertFactory\.textSheet\(/);
  assert.match(providers, /"--api-key-stdin"/);
  assert.match(providers, /stdin: key \+ "\\n"/);
  assert.doesNotMatch(providers, /"--api-key",\s*key/);
  assert.match(providers, /ChatGPT OAuth remain(?:s)? unchanged/);
  assert.match(providers, /providerActionInFlight\.contains\(providerId\)/);
  assert.match(providers, /result\.code == 0 && parsed\?\["ok"\] as\? Bool == true/);
  assert.match(providers, /operations\.begin\(kind: kind, mutationGroup: group/);
  assert.match(providers, /ControlCenterPage/);
  assert.match(alertFactory, /placeholderString = placeholder/);
  assert.match(alertFactory, /isEditable = true/);
  assert.match(alertFactory, /isSelectable = true/);
  assert.match(alertFactory, /makeFirstResponder\(field\)/);
  assert.match(appIdentity, /installStandardEditMenu/);
  assert.match(appIdentity, /#selector\(NSText\.paste\(_:\)\)/);
  assert.match(appDelegate, /installStandardEditMenu\(\)/);
  assert.match(appDelegate, /applicationWillTerminate[\s\S]*processClient\?\.terminateAll\(\)/);
  assert.match(processClient, /arguments\.contains\("--api-key-stdin"\)/);
  assert.match(processClient, /redact\(value, sensitiveValues: sensitiveValues\)/);
  assert.match(processClient, /SecureProcessEnvelope\.render\(payload: payload, code: code, arguments: arguments\)/);
  assert.match(secureEnvelope, /sks\.secure-input-operation\.v1/);
  assert.match(secureEnvelope, /code == 0 && object != nil && schemaOk && sourceOk/);
  assert.doesNotMatch(secureEnvelope, /"ok": code == 0/);
});

test('Control Center avoids competing Return defaults and protects recovery-sensitive settings', () => {
  const root = resolvePackagedMenuBarSourceRoot();
  const controlKit = fs.readFileSync(path.join(root, 'Sources', 'ControlKit.swift'), 'utf8');
  const updates = fs.readFileSync(path.join(root, 'Sources', 'UpdatesViewController.swift'), 'utf8');
  const diagnostics = fs.readFileSync(path.join(root, 'Sources', 'DiagnosticsViewController.swift'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'Sources', 'SettingsViewController.swift'), 'utf8');
  const mcp = fs.readFileSync(path.join(root, 'Sources', 'MCPServersViewController.swift'), 'utf8');

  assert.match(controlKit, /isDefault: Bool = false/);
  assert.match(controlKit, /if isDefault \{ button\.keyEquivalent = "\\r" \}/);
  assert.match(updates, /Review and Update"[\s\S]*isDefault: true/);
  assert.match(diagnostics, /Run Doctor"[\s\S]*isDefault: true/);
  assert.doesNotMatch(controlKit, /button\.keyEquivalent = "\\r"\s*\n\s*button\.setAccessibilityLabel/);

  assert.match(settings, /case unreadable/);
  assert.match(settings, /case malformed/);
  assert.match(settings, /No file was overwritten/);
  assert.match(settings, /Open Notification Settings…/);
  assert.match(settings, /urlForApplication\(withBundleIdentifier: "com\.apple\.systempreferences"\)/);

  assert.match(mcp, /private var refreshGeneration = 0/);
  assert.match(mcp, /self\.refreshGeneration == requestGeneration/);
  assert.match(mcp, /No MCP servers are configured in the/);
  assert.match(mcp, /NativeView\.scrollable\(stack\)/);
});

test('Providers exposes one Desktop Bridge with strict v3 scoped evidence and explicit routes', () => {
  const root = resolvePackagedMenuBarSourceRoot();
  const providers = [
    fs.readFileSync(path.join(root, 'Sources', 'ProvidersViewController.swift'), 'utf8'),
    fs.readFileSync(path.join(root, 'Sources', 'ProvidersReliability.swift'), 'utf8')
  ].join('\n');
  const routingTruth = fs.readFileSync(path.join(root, 'Sources', 'ProvidersRoutingTruth.swift'), 'utf8');
  const openRouter = fs.readFileSync(path.join(root, 'Sources', 'ProvidersOpenRouter.swift'), 'utf8');
  const routeCards = fs.readFileSync(path.join(root, 'Sources', 'ProvidersBridgeCatalog.swift'), 'utf8');
  const providersSurface = `${providers}\n${routingTruth}\n${openRouter}\n${routeCards}`;

  for (const label of ['Desktop Bridge', 'Provider Credentials', 'Combined Model Catalog', 'Routes', 'Capability Matrix']) {
    assert.match(providersSurface, new RegExp(label));
  }
  for (const removed of [
    'Desktop Bridge Mode (keeps ChatGPT sign-in)', 'Use ChatGPT OAuth Only',
    'Use Codex LB through the atomic CLI provider path', 'SKS selects one provider path'
  ]) assert.doesNotMatch(providersSurface, new RegExp(removed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(providers, /\["bridge", "status", "--json"\]/);
  assert.match(providers, /\["bridge", "verify", "--level", level, "--json"\]/);
  assert.match(providers, /report\.summary\.levelSatisfied/);
  assert.match(providers, /responseGate\.accept\(identity\)/);
  assert.match(providers, /operations\.recordDiagnostic\(completed, metadata: metadata\)/);
  assert.match(routingTruth, /sks\.desktop-capabilities\.v3/);
  assert.match(routingTruth, /sks\.desktop-bridge-status\.v3/);
  assert.match(routingTruth, /frameRoundTrip = "frame_round_trip"/);
  assert.match(routingTruth, /cleanClose = "clean_close"/);
  assert.match(routingTruth, /catalog_sync missing/);
  assert.match(providers, /case "degraded", "stale", "available_unverified", "configured_unverified": return \.systemOrange/);
  assert.match(providers, /case "not_attempted", "unsupported": return \.secondaryLabelColor/);
  assert.doesNotMatch(providersSurface, /deepEvidenceTrusted/);
  assert.match(providersSurface, /fallback none/);
  assert.match(openRouter, /Profiles coexist/);
  assert.match(openRouter, /ChatGPT OAuth remain(?:s)? unchanged/);
});

test('Providers manages OpenRouter as a coexisting bridge profile instead of a mode', () => {
  const root = resolvePackagedMenuBarSourceRoot();
  const providers = [
    fs.readFileSync(path.join(root, 'Sources', 'ProvidersViewController.swift'), 'utf8'),
    fs.readFileSync(path.join(root, 'Sources', 'ProvidersReliability.swift'), 'utf8'),
    fs.readFileSync(path.join(root, 'Sources', 'ProvidersOpenRouter.swift'), 'utf8')
  ].join('\n');
  assert.match(providers, /#selector\(configureOpenRouterProfile\)/);
  assert.match(providers, /#selector\(validateOpenRouterProfile\)/);
  assert.match(providers, /#selector\(toggleOpenRouterProfile\)/);
  assert.match(providers, /\["bridge", "provider", "configure", "openrouter", "--api-key-stdin", "--json"\]/);
  assert.match(providers, /\["bridge", "provider", "validate", "openrouter", "--json"\]/);
  assert.match(providers, /\["bridge", "provider", verb, id, "--json"\]/);
  assert.match(providers, /OpenRouter profile configured; Codex-LB preserved/);
  assert.match(providers, /Codex-LB and ChatGPT OAuth remain unchanged/);
  assert.doesNotMatch(providers, /\["codex-app", "use-openrouter"/);
  assert.doesNotMatch(providers, /Restore previous provider/);
  assert.match(providers, /providerButtons\["openrouter"\]/);
});

test('Menu Bar keeps global Fast controls outside the five-card Providers page', () => {
  const swift = source();
  const providers = fs.readFileSync(path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'ProvidersViewController.swift'), 'utf8');
  for (const label of ['Codex Fast: Checking…', 'Codex Fast On', 'Codex Fast Off']) assert.match(swift, new RegExp(label));
  assert.match(swift, /\["fast-mode", "status", "--json"\]/);
  assert.match(swift, /\["fast-mode", "on", "--json"\]/);
  assert.match(swift, /\["fast-mode", "off", "--json"\]/);
  assert.match(swift, /let global = json\["global"\] as\? \[String: Any\], let on = global\["on"\] as\? Bool/);
  assert.match(swift, /fastLine\.title = "Codex Fast: Unavailable"/);
  assert.match(swift, /guard !fastRefreshInFlight else \{ fastRefreshPending = true; return \}/);
  assert.match(swift, /private func completeFastRefresh\(\)/);
  assert.match(swift, /setAccessibilityLabel\("Current Codex Fast state"\)/);
  assert.match(swift, /setAccessibilityLabel\("Turn Codex Fast on"\)/);
  assert.match(swift, /setAccessibilityLabel\("Turn Codex Fast off"\)/);
  assert.doesNotMatch(providers, /fast-mode|Codex Fast/);
});

test('operation coordinator persists redacted bounded-tail receipts and excludes concurrent mutations', () => {
  const swift = source();
  for (const state of ['queued', 'running', 'waitingForConfirmation', 'succeeded', 'failed', 'cancelled', 'terminalUncertain']) {
    assert.match(swift, new RegExp(`\\b${state}\\b`));
  }
  assert.match(swift, /schema: "sks\.operation\.v1"/);
  assert.match(swift, /\.posixPermissions: 0o600/);
  assert.match(swift, /let data = self\.readBoundedOutput\(/);
  assert.match(swift, /tail = Data\(tail\.suffix\(limit\)\)/);
  assert.doesNotMatch(swift, /readDataToEndOfFile\(\)/);
  assert.match(swift, /max\(1024, min\(1024 \* 1024, maxOutputBytes \?\? outputLimit\)\)/);
  assert.match(swift, /private var activeMutation: \(id: String, group: String\)\?/);
  assert.match(swift, /if mutationGroup != nil, activeMutation != nil \{ return nil \}/);
  assert.match(swift, /if activeMutation\?\.id == snapshot\.id \{ activeMutation = nil \}/);
  assert.match(swift, /redact\(command\.joined\(separator: " "\), sensitiveValues: sensitiveValues\)/);
  assert.match(swift, /64 \* 1024/);
});

test('UserNotifications declares all categories/actions, redacts public bodies, and surfaces denial without failing operations', () => {
  const swift = source();
  for (const category of ['SKS_OPERATION_RESULT', 'SKS_UPDATE_AVAILABLE', 'SKS_ACTION_REQUIRED']) assert.match(swift, new RegExp(category));
  for (const action of ['OPEN_CONTROL_CENTER', 'OPEN_LOG', 'RETRY_OPERATION']) assert.match(swift, new RegExp(action));
  assert.doesNotMatch(swift, /OPEN_DASHBOARD|onOpenDashboard/);
  assert.match(swift, /UNUserNotificationCenterDelegate/);
  assert.match(swift, /getNotificationSettings/);
  assert.match(swift, /authorizationIsDenied\(settings\.authorizationStatus\)/);
  assert.match(swift, /func dispatchActionIdentifier\(_ identifier: String\) -> String/);
  assert.match(swift, /case UNNotificationDismissActionIdentifier: return "dismissed"/);
  assert.match(swift, /Notifications require attention/);
  assert.match(swift, /permission denied — operation results remain available in this Control Center inbox/);
  assert.match(swift, /api\[_-\]\?key\|secret\|token\|authorization/);
  assert.match(swift, /replacingOccurrences\(of: home, with: "~"\)/);
  assert.doesNotMatch(swift, /display notification|osascript/);
});

test('Remote Coding page is a secret-safe Telegram control surface with no retired-brand residue', () => {
  const swift = source();
  const overview = fs.readFileSync(path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'OverviewViewController.swift'), 'utf8');
  const sidebar = fs.readFileSync(path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'SidebarItem.swift'), 'utf8');
  const remote = fs.readFileSync(
    path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'RemoteCodingViewController.swift'),
    'utf8'
  );
  const gateway = fs.readFileSync(path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'TelegramProcessGateway.swift'), 'utf8');
  const processClient = fs.readFileSync(path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'ProcessClient.swift'), 'utf8');
  const secureEnvelope = fs.readFileSync(path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'SecureProcessEnvelope.swift'), 'utf8');
  const privateStore = fs.readFileSync(path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'TelegramPrivateFileStore.swift'), 'utf8');
  const telegramSupport = fs.readFileSync(path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'TelegramSupport.swift'), 'utf8');
  const transport = fs.readFileSync(path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'TelegramTransport.swift'), 'utf8');
  const controlCenter = fs.readFileSync(path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'ControlCenterWindowController.swift'), 'utf8');
  assert.match(sidebar, /case remoteCoding = "Remote Coding"/);
  assert.match(overview, /NativeView\.button\("Remote Coding…"/);
  assert.match(overview, /openSection\?\("Remote Coding"\)/);
  assert.match(remote, /final class RemoteCodingViewController: NSViewController, ControlCenterPage/);
  assert.match(remote, /Telegram Remote Control/);
  assert.match(remote, /Connect with BotFather/);
  assert.match(remote, /Open @BotFather/);
  assert.match(remote, /(?:https:\/\/t\.me\/BotFather|tg:\/\/resolve\?domain=BotFather)/);
  assert.match(remote, /Enter Bot Token…/);
  assert.match(remote, /secure: true/);
  assert.match(remote, /let normalizedToken = token\.trimmingCharacters\(in: \.whitespacesAndNewlines\)[\s\S]*validTokenShape\(normalizedToken\)[\s\S]*saveToken\(normalizedToken,/);
  assert.match(remote, /\["telegram", "setup", "--token-stdin", "--json"\]/);
  assert.match(remote, /stdin: normalizedToken \+ "\\n"/);
  assert.match(remote, /logOutput: false/);
  assert.match(remote, /Pair a Private Chat/);
  assert.match(remote, /Generate Pairing Code/);
  assert.match(remote, /\["telegram", "pair", "--json"\]/);
  assert.match(remote, /pairButton\.isEnabled = !operationInFlight && tokenConfigured && pollerRunning/);
  assert.match(remote, /Service Status/);
  assert.match(remote, /\["telegram", "doctor", "--json"\]/);
  assert.match(remote, /telegram_webhook_configured_remove_consent_required/);
  assert.match(remote, /arguments\.append\("--remove-webhook"\)/);
  assert.match(remote, /TelegramPrivateFileStore\.operatorEnvironmentOverrideActive\(\)[\s\S]*arguments\.append\("--operator-env-override-active"\)/);
  assert.match(remote, /telegram_operator_env_override_active/);
  assert.match(remote, /response\?\.partial_success == true[\s\S]*partialSetupRecovery\(response\)/);
  assert.match(telegramSupport, /struct TelegramCenterSetupResponse[\s\S]*let token_source: String\?/);
  assert.match(telegramSupport, /struct TelegramCenterPairResponse[\s\S]*let instruction: String\?[\s\S]*let post_pair_command: String\?[\s\S]*let confirmation_grammar: String\?/);
  assert.match(remote, /let statusGuidance = instruction\.contains\(postPair\)/);
  assert.match(remote, /After pairing, try \/sks status \{\}/);
  assert.match(remote, /without dropping pending updates/);
  assert.match(remote, /AlertFactory\.confirmSheet/);
  assert.doesNotMatch(remote, /\borca\b|onorca|stablyai/i);
  assert.doesNotMatch(swift, /\borca\b|onorca|stablyai/i);
  assert.equal((remote.match(/\["telegram", "setup"/g) ?? []).length, 1);
  assert.doesNotMatch(remote, /stringValue\s*=\s*token|NativeView\.(?:detail|title)\(\s*token/);
  assert.match(controlCenter, /RemoteCodingViewController\([\s\S]*processClient: processClient,[\s\S]*telegramService: telegramService/);
  assert.match(gateway, /init\([\s\S]*processClient: ProcessClient,[\s\S]*canonicalProjectRoot: String/);
  assert.equal((gateway.match(/"--project-root", canonicalProjectRoot/g) ?? []).length, 2);
  assert.match(gateway, /\["name": request\.name, "input": object\]/);
  assert.doesNotMatch(gateway, /object\["project_root"\]|request\.projectRoot/);
  assert.match(gateway, /gateway: TelegramProcessCommandGateway\([\s\S]*processClient: processClient,[\s\S]*canonicalProjectRoot: canonicalProjectRoot/);
  assert.match(processClient, /arguments\.contains\("--token-stdin"\)/);
  assert.match(secureEnvelope, /case \("telegram", "setup"\):\s*return \["sks\.telegram-setup-command\.v1"\]/);
  assert.match(secureEnvelope, /sourceSchema == "sks\.telegram-setup-command\.v1"[\s\S]*"getme_verified"[\s\S]*"token_stored"[\s\S]*"partial_success"[\s\S]*"webhook_removed"/);
  assert.match(secureEnvelope, /\["env", "user_secret_file", "none", "unchanged"\]\.contains\(source\)/);
  assert.match(secureEnvelope, /for key in \["action", "command", "note"\]/);
  assert.doesNotMatch(secureEnvelope, /(?:envelope|object)\["(?:storage|token|raw|payload)"\]/);
  assert.match(privateStore, /func consumePairing[\s\S]*state\.chats = \[AuthorizedChat\([\s\S]*state\.confirmations = \[\][\s\S]*writeStateUnlocked\(state\)/);
  assert.match(transport, /SKS Telegram control paired\. Try \/sks status \{\}\. Confirm prompted actions with \/confirm <nonce>\./);
  assert.match(swift, /TelegramRuntimeFactory\.make\([\s\S]*processClient: processClient,[\s\S]*canonicalProjectRoot: AppRuntime\.canonicalProjectRoot/);
  assert.match(swift, /telegramService\?\.stopAndWait\(timeout: 2\)/);
  assert.doesNotMatch(swift, /RemoteTelegram|TelegramHub/);
  for (const removed of [
    'TelegramHubSupervisor.swift',
    'RemoteTelegramViewController.swift',
    'RemoteTelegramCenterState.swift',
    'RemoteTelegramRendering.swift'
  ]) {
    assert.equal(fs.existsSync(path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', removed)), false);
  }
});

test('MCP Control Center exposes scoped CRUD, health, OAuth, backups, policy editing, and redacted review without raw secret entry', () => {
  const swift = source();
  assert.match(swift, /scopePopup\.addItems\(withTitles: \["Effective", "Global", "Project"\]\)/);
  assert.match(swift, /\["mcp", "config", "list", "--scope", scope\] \+ scopeContext\(scope, mutation: false\) \+ \["--json"\]/);
  assert.match(swift, /\["mcp", "config", "add", "--scope", draft\.scope\].*\["--stdin-json", "--json"\]/s);
  assert.match(swift, /\["mcp", "config", "edit", selection\.row\.name, "--scope", selection\.row\.scope\].*\["--stdin-json", "--json"\]/s);
  assert.match(swift, /\["mcp", "config", "duplicate", selection\.row\.name, "--new-name", name, "--scope", selection\.row\.scope\]/);
  assert.match(swift, /\["mcp", "config", action, selection\.row\.name, "--scope", selection\.row\.scope\]/);
  assert.match(swift, /\["mcp", "config", "remove", selection\.row\.name, "--scope", selection\.row\.scope\]/);
  assert.match(swift, /\["mcp", "config", "test", selection\.row\.name, "--scope", selection\.row\.scope\]/);
  assert.match(swift, /let action = selection\.row\.authenticated == true \? "logout" : "login"/);
  assert.match(swift, /\["mcp", "config", "backups", "--scope", scope\]/);
  assert.match(swift, /\["mcp", "config", "restore", id, "--scope", scope\]/);
  assert.match(swift, /\["--project-root", AppRuntime\.projectRoot, "--trusted-project"\]/);
  assert.match(swift, /args\.append\("--confirm-project"\)/);
  for (const label of ['Add…', 'Edit…', 'Duplicate…', 'Enable/Disable', 'Remove', 'Test Connection', 'OAuth Login/Logout', 'Backups…']) {
    assert.match(swift, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  for (const field of ['startup_timeout_sec', 'tool_timeout_sec', 'enabled_tools', 'disabled_tools', 'default_tools_approval_mode', 'required']) {
    assert.match(swift, new RegExp(field));
  }
  assert.match(swift, /Review is required before Apply/);
  assert.match(swift, /No secret values are included/);
  assert.match(swift, /environment-variable names only/);
  assert.match(swift, /oauthButton\.isEnabled = .*streamable-http/s);
  assert.match(swift, /guard selectedScope\(\) != "effective"/);
  assert.match(swift, /writableScopeForBackup\(\).*global.*project/s);
  assert.match(swift, /selection\.row\.managedBy != "plugin"/);
  assert.match(swift, /columnAutoresizingStyle = \.lastColumnOnlyAutoresizingStyle/);
  assert.match(swift, /let stateActions = ControlKit\.actionRow/);
  assert.match(swift, /let maintenance = ControlKit\.actionRow/);
  assert.match(swift, /orderedLines\(args\.string\)/);
  assert.match(swift, /NSEvent\.addLocalMonitorForEvents\(matching: \.keyDown\)/);
  assert.match(swift, /event\.keyCode == 53/);
  assert.doesNotMatch(swift, /KEY=VALUE/);
});

test('update UI reads the v3 snapshot and refreshes only through explicit refresh commands', () => {
  const swift = source();
  assert.match(swift, /\.sneakoscope-global\/cache\/update-status\.json/);
  assert.match(swift, /\["update", "status", "--project-root", AppRuntime\.canonicalProjectRoot, "--json"\]/);
  assert.match(swift, /\["update", "status", "--refresh", "--project-root", AppRuntime\.canonicalProjectRoot, "--json"\]/);
  assert.match(swift, /\["update", "review"\] \+ Self\.projectContext \+ \["--json"\]/);
  assert.match(swift, /\["update", "now", "--version", reviewed\.target, "--registry", reviewed\.registry\]/);
  assert.match(swift, /let projectRoot = json\["project_root"\] as\? String,[\s\S]*projectRoot == AppRuntime\.canonicalProjectRoot/);
  assert.match(swift, /canonicalRegistry\(registry\)[\s\S]*canonicalRegistry == registry/);
  assert.match(swift, /expectedProjectRoot: AppRuntime\.canonicalProjectRoot/);
  assert.match(swift, /static let canonicalProjectRoot = sksCanonicalFilesystemPath\(projectRoot\)/);
  assert.match(swift, /resolvingSymlinksInPath\(\)\.standardizedFileURL\.path[\s\S]*Darwin\.realpath/);
  assert.match(swift, /Update review cancelled\. No staged update was applied\./);
  assert.match(swift, /state: \.cancelled/);
  assert.match(swift, /Timer\.scheduledTimer\(withTimeInterval: 30, repeats: true\).*refreshLocalState\(\)/s);
  assert.match(swift, /Rollback guidance and the previous Menu Bar app remain available/);
  assert.match(swift, /No success state was assumed/);
});

test('Updates exposes a guarded Codex CLI update action and refreshes its snapshot after completion', () => {
  const updates = fs.readFileSync(path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'UpdatesViewController.swift'), 'utf8');
  const button = updates.match(/(\w+)\s*=\s*NativeView\.button\("Update Codex CLI", target: self, action: #selector\((\w+)\)\)/);
  assert.ok(button, 'missing visible Update Codex CLI button');
  const buttonName = button[1];
  const actionName = button[2];
  assert.ok(buttonName && actionName, 'Codex CLI update button must name its control and action');
  assert.match(updates, new RegExp(`NSStackView\\(views: \\[[^\\]]*\\b${buttonName}\\b`));

  const actionStart = updates.indexOf(`@objc private func ${actionName}()`);
  assert.ok(actionStart >= 0, `missing ${actionName} action`);
  const actionTail = updates.slice(actionStart + actionName.length);
  const nextMethodOffset = actionTail.search(/\n    (?:@objc )?private func /);
  const actionFlow = updates.slice(actionStart, nextMethodOffset >= 0 ? actionStart + actionName.length + nextMethodOffset : updates.length);
  assert.match(actionFlow, /run\(\["codex", "update", "--json"\], kind: "[^"]+", group: "[^"]+"/);
  assert.match(actionFlow, /reloadSnapshot\(\)/);
  assert.match(updates, /operations\.begin\([\s\S]*kind: kind,[\s\S]*mutationGroup: group,[\s\S]*targetVersion: reviewedUpdate\?\.target,[\s\S]*projectRoot: reviewedUpdate\?\.projectRoot,[\s\S]*registry: reviewedUpdate\?\.registry/);
  assert.match(updates, /codexUpdateButton\?\.isEnabled\s*=\s*!value/);
  assert.match(updates, /codexUpdateResultIsSuccessful[\s\S]{0,900}!result\.truncated[\s\S]{0,900}sks\.codex-cli-update-result\.v1[\s\S]{0,500}\["ok"\]\s+as\?\s+Bool\s*==\s*true/);
  assert.match(updates, /args\.contains\("--refresh"\)\s*\?\s*NativeView\.mutationTimeout\s*:\s*NativeView\.statusTimeout/);
  assert.match(updates, /kind\s*==\s*"codex-cli-update"\s*\?\s*!codexUpdateSucceeded/);
  const codexUpdateFailureStart = updates.indexOf('if result.code != 0 {');
  const codexUpdateFailureEnd = updates.indexOf('} else if state == .waitingForConfirmation', codexUpdateFailureStart);
  assert.ok(codexUpdateFailureStart >= 0 && codexUpdateFailureEnd > codexUpdateFailureStart);
  const codexUpdateFailureFlow = updates.slice(codexUpdateFailureStart, codexUpdateFailureEnd);
  assert.match(codexUpdateFailureFlow, /kind\s*==\s*"codex-cli-update"\s*\n\s*\?\s*"Codex CLI update failed\. Structured guidance is shown below\."\s*\n\s*:\s*[^\n]*NativeView\.redactPreview\(result\.output\)/);
  assert.doesNotMatch(actionFlow, /(?:npm|npx|brew)\s+(?:install|update|upgrade)|curl\s/);
});

test('Menu Bar action runner executes from HOME and prefers the pinned package entry', () => {
  const script = actionScriptSource({ nodeBin: '/usr/bin/node', sksEntry: '/opt/sneakoscope/dist/bin/sks.js' });
  const homeCd = script.indexOf('cd "$HOME" 2>/dev/null || true');
  const migrationGate = script.indexOf('export SKS_UPDATE_MIGRATION_GATE_DISABLED=1');
  const pinned = script.indexOf('run_node_entry "$SKS_ENTRY" "$@"');
  const pathLookup = script.indexOf('command -v sks');
  const npmLookup = script.indexOf('npm root -g');
  assert.ok(homeCd >= 0 && migrationGate > homeCd && pinned > migrationGate);
  assert.ok(pinned < pathLookup && pinned < npmLookup);
  assert.equal(script.lastIndexOf('run_node_entry "$SKS_ENTRY" "$@"'), pinned);
  assert.match(script, /\.nvm\/versions\/node\/\*\/lib\/node_modules\/sneakoscope\/dist\/bin\/sks\.js/);
});

test('build stamp carries aggregate and per-file source/resource integrity', () => {
  const runtime = {
    actionScriptPath: '/tmp/action', buildStampPath: '/tmp/stamp', configPath: '/tmp/config',
    lastActionLogPath: '/tmp/log', operationDirPath: '/tmp/operations',
    codexBundleId: null, packageVersion: '6.3.0'
  };
  const sourceHashes = Object.fromEntries(loadNativeMenuBarSources(runtime).map((entry) => [entry.name, entry.sha256]));
  const resourceHashes = nativeResourceHashes();
  const stamp = createSksMenuBarBuildStamp({
    packageVersion: '6.3.0', sourceHashes, resourceHashes,
    actionScriptSha256: 'a', infoPlistSha256: 'b', launchAgentSha256: 'c',
    swiftcVersion: 'swift', codesignIdentifier: 'com.sneakoscope.sks-menubar'
  });
  assert.equal(stamp.source_sha256, aggregateFileHashes(sourceHashes));
  assert.equal(stamp.resources_sha256, aggregateFileHashes(resourceHashes));
  assert.equal(Object.keys(stamp.source_files_sha256).length, NATIVE_SOURCE_FILES.length);
  assert.equal(Object.keys(stamp.resource_files_sha256).length, NATIVE_RESOURCE_FILES.length);
  assert.ok(Object.values(stamp.resource_files_sha256).every((digest) => /^[a-f0-9]{64}$/.test(digest)));
});

test('action integrity detects drift even when the pinned target remains runnable', () => {
  const script = actionScriptSource({ nodeBin: '/usr/bin/node', sksEntry: '/opt/sneakoscope/dist/bin/sks.js' });
  const expected = sha256(script);
  assert.deepEqual(evaluateActionScriptIntegrity(script, { action_script_sha256: expected }), {
    script_sha256: expected,
    expected_script_sha256: expected,
    script_hash_matches_stamp: true
  });
  assert.equal(evaluateActionScriptIntegrity(`${script}# drift\n`, { action_script_sha256: expected }).script_hash_matches_stamp, false);
  assert.equal(evaluateActionScriptIntegrity(script, null).script_hash_matches_stamp, false);
});

test('all split files remain inside the release line budgets', () => {
  const root = resolvePackagedMenuBarSourceRoot();
  for (const name of NATIVE_SOURCE_FILES) {
    const lines = fs.readFileSync(path.join(root, 'Sources', name), 'utf8').split(/\r?\n/).length;
    assert.ok(lines <= (name === 'AppDelegate.swift' ? 250 : 500), `${name}: ${lines}`);
  }
});

test('Swift update stage order stays identical to the TypeScript UPDATE_STAGE_ORDER contract', () => {
  // Center renders update progress as completed/updateStageOrder.count and
  // intersects receipt stage ids with this list. If the two lists drift, the
  // progress denominator and the completed-stage count silently disagree with
  // the receipt the CLI actually wrote.
  const root = resolvePackagedMenuBarSourceRoot();
  const swift = fs.readFileSync(path.join(root, 'Sources', 'OperationCoordinator.swift'), 'utf8');
  const literal = swift.match(/static let updateStageOrder\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(literal, 'OperationCoordinator.updateStageOrder literal not found');
  const swiftStages = [...String(literal[1]).matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  assert.deepEqual(swiftStages, [...UPDATE_STAGE_ORDER]);
});

test('materialized Control Center source typechecks as one Swift translation unit', (t) => {
  // Split-file regex assertions cannot catch a type or selector error, and the
  // only other Swift compile in the suite builds OperationCoordinator.swift
  // alone. Without this gate a broken view controller reaches the user as a
  // failed menubar_rebuild stage during `sks update`.
  if (process.platform !== 'darwin') return t.skip('swiftc typecheck is macOS-only');
  const probe = spawnSync('swiftc', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) return t.skip('swiftc unavailable');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-menubar-typecheck-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'SKSMenuBar.swift');
  fs.writeFileSync(file, source());
  const checked = spawnSync('swiftc', ['-typecheck', file], { encoding: 'utf8' });
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
});

test('Providers source inventory has no retired role-model compatibility screen', () => {
  assert.equal(NATIVE_SOURCE_FILES.includes('ProvidersRoleModels.swift' as never), false);
  assert.doesNotMatch(source(), /ProvidersRoleModels\.swift|role-models/);
});
