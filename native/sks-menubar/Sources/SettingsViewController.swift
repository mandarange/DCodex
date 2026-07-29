import Cocoa

final class SettingsViewController: NSViewController, ControlCenterPage {
    private enum ConfigReadResult {
        case loaded([String: Any])
        case missing
        case unreadable
        case malformed
    }

    private let notifications: NotificationCoordinator
    private let quitWithCodex = NSButton(checkboxWithTitle: "Quit SKS Menu when Codex quits", target: nil, action: nil)
    private let status = NativeView.detail("Settings use the native app configuration file.")
    private var notificationButton: NSButton!
    init(notifications: NotificationCoordinator) { self.notifications = notifications; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { nil }

    override func loadView() {
        quitWithCodex.target = self; quitWithCodex.action = #selector(save)
        quitWithCodex.setAccessibilityLabel("Quit SKS Menu when Codex quits")
        notificationButton = NativeView.button("Enable Notifications", target: self, action: #selector(enableNotifications))
        let lifecycleCard = NativeView.card(
            title: "Codex lifecycle",
            subtitle: "Off keeps the menu icon available on cold start and hides it only after a Codex session ends.",
            views: [quitWithCodex]
        )
        let notificationsCard = NativeView.card(
            title: "Notifications",
            subtitle: "Operation results always stay available in Control Center, even when notifications are denied.",
            views: [NativeView.row([notificationButton]), status]
        )
        view = NativeView.page([
            ControlKit.header("Settings", "These options stay on this Mac. Notification permission and Codex lifecycle behavior never leave the machine."),
            lifecycleCard, notificationsCard
        ])
    }

    func refreshOnAppear() {
        let configResult = readConfig()
        switch configResult {
        case .loaded(let config):
            quitWithCodex.isEnabled = true
            quitWithCodex.state = config["quit_with_codex"] as? Bool == true ? .on : .off
        case .missing:
            quitWithCodex.isEnabled = true
            quitWithCodex.state = .off
        case .unreadable, .malformed:
            quitWithCodex.isEnabled = false
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
            quitWithCodex.isEnabled = false
            status.stringValue = "Settings were not saved because the existing file cannot be read. No file was overwritten."
            return
        case .malformed:
            quitWithCodex.isEnabled = false
            status.stringValue = "Settings were not saved because the existing file is malformed. No file was overwritten."
            return
        }
        config["schema"] = "sks.sks-menubar-config.v1"
        config["codex_bundle_id"] = AppRuntime.codexBundleId as Any
        config["quit_with_codex"] = quitWithCodex.state == .on
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
            status.stringValue = quitWithCodex.state == .on
                ? "Saved. SKS Menu will quit when Codex quits."
                : "Saved. SKS Menu stays available on cold start; after a Codex session ends it hides until Codex returns."
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
