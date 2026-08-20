import Cocoa

final class SettingsViewController: NSViewController, ControlCenterPage {
    private enum ConfigReadResult {
        case loaded([String: Any])
        case missing
        case unreadable
        case malformed
    }

    private let processClient: ProcessClient
    private let operations: OperationCoordinator
    private let notifications: NotificationCoordinator
    private let followCodexLifecycle = NSButton(checkboxWithTitle: "Show SKS Menu only while Codex is running", target: nil, action: nil)
    private let status = NativeView.detail("Settings use the native app configuration file.")
    private let contextStatus = NativeView.detail("Codex 1M context: checking current state…")
    private var notificationButton: NSButton!
    private var contextToggleButton: NSButton!
    private var contextEnabled: Bool?
    private var contextBusy = false
    private var contextGeneration = 0
    init(processClient: ProcessClient, operations: OperationCoordinator, notifications: NotificationCoordinator) {
        self.processClient = processClient
        self.operations = operations
        self.notifications = notifications
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { nil }

    override func loadView() {
        followCodexLifecycle.target = self; followCodexLifecycle.action = #selector(save)
        followCodexLifecycle.setAccessibilityLabel("Show SKS Menu only while Codex is running")
        notificationButton = NativeView.button("Enable Notifications", target: self, action: #selector(enableNotifications))
        contextToggleButton = NativeView.button("Enable 1M Context", target: self, action: #selector(toggleContext1m))
        contextToggleButton.isEnabled = false
        let lifecycleCard = NativeView.card(
            title: "Codex lifecycle",
            subtitle: "On keeps a lightweight observer running, hides the icon when Codex is closed, and shows it automatically when Codex opens.",
            views: [followCodexLifecycle]
        )
        let contextCard = NativeView.card(
            title: "Codex 1M Context",
            subtitle: "Opt Codex into the documented 1,000,000-token context window for GPT-5.6 Sol (model_context_window = 1000000, model_auto_compact_token_limit = 900000 in ~/.codex/config.toml). Requests beyond 272K input tokens bill the entire request at the long-context rate, only new sessions pick up the change, and Codex restarts automatically when it is running. Off restores the previous value.",
            views: [NativeView.row([contextToggleButton]), contextStatus]
        )
        let notificationsCard = NativeView.card(
            title: "Notifications",
            subtitle: "Operation results always stay available in Control Center, even when notifications are denied.",
            views: [NativeView.row([notificationButton]), status]
        )
        view = NativeView.page([
            ControlKit.header("Settings", "These options stay on this Mac. Notification permission and Codex lifecycle behavior never leave the machine."),
            lifecycleCard, contextCard, notificationsCard
        ])
    }

    func refreshOnAppear() {
        refreshContext1m()
        let configResult = readConfig()
        switch configResult {
        case .loaded(let config):
            followCodexLifecycle.isEnabled = true
            followCodexLifecycle.state = CodexLifecyclePolicy.followsCodex(from: config) ? .on : .off
        case .missing:
            followCodexLifecycle.isEnabled = true
            followCodexLifecycle.state = .off
        case .unreadable, .malformed:
            followCodexLifecycle.isEnabled = false
        }
        if notifications.authorizationDenied {
            notificationButton.title = "Open Notification Settings…"
            notificationButton.setAccessibilityLabel("Open macOS Notification Settings")
            status.stringValue = "Notifications are blocked by macOS. Open System Settings, select SKS, and allow notifications. Operation results still appear in Control Center."
        } else {
            notificationButton.title = "Enable Notifications"
            notificationButton.setAccessibilityLabel("Enable Notifications")
            switch configResult {
            case .loaded:
            status.stringValue = "Settings loaded from the native app configuration file."
            case .missing:
            status.stringValue = "No settings file yet. Changing an option creates one with owner-only permissions."
            case .unreadable:
                status.stringValue = "The settings file exists but cannot be read. No option can be changed until file access is restored."
            case .malformed:
                status.stringValue = "The settings file is malformed. No option can be changed or overwritten; repair it, then reopen Settings."
            }
        }
    }

    private func refreshContext1m(preserveStatusText: Bool = false) {
        contextGeneration += 1
        let requestGeneration = contextGeneration
        processClient.run(["codex-app", "context-1m", "status", "--json"], timeout: NativeView.statusTimeout) { [weak self] result in
            guard let self = self, self.contextGeneration == requestGeneration, !self.contextBusy else { return }
            guard let json = self.json(result.output),
                  json["schema"] as? String == "sks.codex-context-1m.v1",
                  json["ok"] as? Bool == true,
                  let enabled = json["enabled"] as? Bool else {
                self.contextEnabled = nil
                self.contextToggleButton.isEnabled = false
                if !preserveStatusText {
                    self.contextStatus.stringValue = "Codex 1M context state unavailable · update SKS, then reopen Settings."
                    self.contextStatus.textColor = .systemOrange
                }
                return
            }
            self.contextEnabled = enabled
            self.contextToggleButton.isEnabled = true
            self.contextToggleButton.title = enabled ? "Disable 1M Context" : "Enable 1M Context"
            guard !preserveStatusText else { return }
            let model = json["model"] as? String
            var text = enabled
                ? "Enabled · window 1,000,000 · auto-compact 900,000 · applies to new sessions only."
                : "Disabled · Codex uses its tuned default context window."
            var tone: NSColor = enabled ? .systemGreen : .secondaryLabelColor
            if enabled, let model = model, model != "gpt-5.6-sol" {
                text += " Active model is \(model); the 1M window is documented for gpt-5.6-sol."
                tone = .systemOrange
            }
            self.contextStatus.stringValue = text
            self.contextStatus.textColor = tone
        }
    }

    @objc private func toggleContext1m() {
        guard !contextBusy, let enabled = contextEnabled else { return }
        let verb = enabled ? "off" : "on"
        guard let snapshot = operations.begin(
            kind: "codex-context-1m",
            mutationGroup: "codex-config",
            summary: enabled ? "Disable Codex 1M context" : "Enable Codex 1M context"
        ) else {
            contextStatus.stringValue = "Another guarded mutation is running. Try again after it completes."
            contextStatus.textColor = .systemOrange
            return
        }
        contextBusy = true
        contextToggleButton.isEnabled = false
        contextStatus.stringValue = enabled ? "Disabling 1M context…" : "Enabling 1M context and restarting Codex if it is running…"
        contextStatus.textColor = .secondaryLabelColor
        _ = operations.update(snapshot, state: .running, stage: "applying", progress: nil, summary: contextStatus.stringValue)
        processClient.run(["codex-app", "context-1m", verb, "--json"], timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.contextBusy = false
            self.contextToggleButton.isEnabled = true
            let json = self.json(result.output)
            let ok = result.code == 0
                && json?["schema"] as? String == "sks.codex-context-1m.v1"
                && json?["ok"] as? Bool == true
            let summary: String
            if ok {
                let restart = json?["restart"] as? [String: Any]
                let applied = verb == "on" ? "1M context enabled" : "1M context disabled"
                if restart?["status"] as? String == "restarted" {
                    summary = "\(applied) · Codex restarted — start a new session to apply it."
                } else if restart?["reason"] as? String == "codex_not_running" {
                    summary = "\(applied) · Codex is not running — the change applies on its next launch."
                } else if restart?["reason"] as? String == "config_unchanged" {
                    summary = "\(applied) · configuration already matched; nothing restarted."
                } else {
                    summary = "\(applied) · restart Codex manually, then start a new session."
                }
            } else {
                let blocker = (json?["blockers"] as? [String])?.first
                summary = blocker.map { "1M context change failed · \($0)" } ?? "1M context change failed · unexpected CLI response."
            }
            _ = self.operations.update(snapshot, state: ok ? .succeeded : .failed, stage: "complete", progress: 1, summary: summary)
            self.contextStatus.stringValue = summary
            self.contextStatus.textColor = ok ? .systemGreen : .systemRed
            self.refreshContext1m(preserveStatusText: true)
        }
    }

    private func json(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8) else { return nil }
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { return object }
        // Child processes may print banner lines before JSON; prefer the last
        // top-level object payload, matching the Overview parser.
        guard let start = text.range(of: "{", options: [.backwards])?.lowerBound else { return nil }
        let slice = String(text[start...])
        guard let sliced = slice.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: sliced) as? [String: Any]
    }

    @objc private func enableNotifications() {
        if notifications.authorizationDenied {
            guard openSystemSettings() else {
                status.stringValue = "System Settings could not be opened. Open it manually, then choose Notifications → SKS."
                return
            }
            status.stringValue = "System Settings opened. Choose Notifications → SKS and allow notifications."
            return
        }
        notifications.requestAuthorizationFromSettings()
        status.stringValue = "Notification authorization was requested from macOS."
    }

    @objc private func save() {
        let previous = readConfig()
        var config: [String: Any]
        switch previous {
        case .loaded(let value):
            config = value
        case .missing:
            config = [:]
        case .unreadable:
            followCodexLifecycle.isEnabled = false
            status.stringValue = "Settings were not saved because the existing file cannot be read. No file was overwritten."
            return
        case .malformed:
            followCodexLifecycle.isEnabled = false
            status.stringValue = "Settings were not saved because the existing file is malformed. No file was overwritten."
            return
        }
        config["schema"] = "sks.sks-menubar-config.v2"
        config["codex_bundle_id"] = AppRuntime.codexBundleId as Any
        config["follow_codex_lifecycle"] = followCodexLifecycle.state == .on
        config.removeValue(forKey: "quit_with_codex")
        guard JSONSerialization.isValidJSONObject(config), let data = try? JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted]) else {
            status.stringValue = "Settings could not be encoded."
            return
        }
        let target = URL(fileURLWithPath: AppRuntime.configPath)
        let directory = target.deletingLastPathComponent()
        let temporary = directory.appendingPathComponent(".config.\(UUID().uuidString).tmp")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: temporary, options: .atomic)
            if FileManager.default.fileExists(atPath: target.path) {
                _ = try FileManager.default.replaceItemAt(target, withItemAt: temporary)
            } else {
                try FileManager.default.moveItem(at: temporary, to: target)
            }
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
            status.stringValue = followCodexLifecycle.state == .on
                ? "Saved. The observer stays running; the icon follows Codex without quitting."
                : "Saved. SKS Menu stays visible whether Codex is open or closed."
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            status.stringValue = "Settings could not be saved. Confirm \(directory.path) is writable."
        }
    }

    private func readConfig() -> ConfigReadResult {
        let manager = FileManager.default
        guard manager.fileExists(atPath: AppRuntime.configPath) else { return .missing }
        guard let data = manager.contents(atPath: AppRuntime.configPath) else { return .unreadable }
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let config = object as? [String: Any] else { return .malformed }
        return .loaded(config)
    }

    private func openSystemSettings() -> Bool {
        guard let settings = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.systempreferences") else {
            return false
        }
        return NSWorkspace.shared.open(settings)
    }
}
