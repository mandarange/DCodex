import Cocoa

final class OverviewViewController: NSViewController, ControlCenterPage {
    private let processClient: ProcessClient
    private let operations: OperationCoordinator
    private let status = NativeView.detail("Loading local SKS status…")
    private let notificationInbox = NativeView.detail("Notifications: checking authorization…")
    private let recoveryStatus = NativeView.detail("Progress recovery: no operation state loaded yet.")
    private let healthBadge = NativeView.badge("Checking local status", color: .systemBlue)
    private let statusSpinner = NativeView.spinner(label: "Checking SKS Center status")
    private let snapshotDetails = NativeView.detail("")
    private let components = NSStackView()
    private var recoveryCard: NSBox!
    private var generation = 0
    private var completedGeneration = 0
    private var doctorButton: NSButton!
    private var refreshButton: NSButton!
    private var updateCodexButton: NSButton!
    private var reviewAndResumeButton: NSButton!
    /// Section navigation by sidebar title, wired by ControlCenterWindowController.
    var openSection: ((String) -> Void)?

    init(processClient: ProcessClient, operations: OperationCoordinator) {
        self.processClient = processClient
        self.operations = operations
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { nil }

    override func loadView() {
        doctorButton = NativeView.button("Run Doctor", target: self, action: #selector(doctor))
        refreshButton = NativeView.button("Refresh", target: self, action: #selector(refreshStatus))
        updateCodexButton = NativeView.button("Update Codex CLI", target: self, action: #selector(updateCodexCLI))
        reviewAndResumeButton = NativeView.button("Review & Resume…", target: self, action: #selector(reviewAndResume))
        reviewAndResumeButton.isEnabled = false
        updateCodexButton.setAccessibilityHelp("Update the operator Codex CLI to the preferred latest channel.")
        let buttons = NativeView.row([refreshButton, doctorButton, updateCodexButton])
        let shortcuts = NativeView.row([
            NativeView.button("Remote Coding…", target: self, action: #selector(openRemoteCoding)),
            connectionsShortcut(),
            NativeView.button("Updates…", target: self, action: #selector(openUpdates)),
            NativeView.button("Diagnostics…", target: self, action: #selector(openDiagnostics))
        ])
        shortcuts.setAccessibilityLabel("Open Control Center sections")
        components.orientation = .vertical
        components.alignment = .width
        components.spacing = 9
        components.setAccessibilityIdentifier("sks-overview-components")
        status.setAccessibilityIdentifier("sks-overview-next-action")
        let healthCard = NativeView.card(
            title: "System health", subtitle: "",
            views: [NativeView.row([healthBadge, statusSpinner]), status, components, buttons]
        )
        recoveryCard = NativeView.card(
            title: "Progress, pause & recovery", subtitle: "Review the current operation before retrying.",
            views: [recoveryStatus, NativeView.row([reviewAndResumeButton])]
        )
        recoveryCard.isHidden = true
        view = NativeView.page([
            NativeView.title("Overview"),
            NativeView.detail("Your local workspace at a glance."),
            healthCard,
            recoveryCard,
            NativeView.card(title: "Quick access", subtitle: "", views: [shortcuts]),
            NativeDisclosure("Snapshot details", views: [snapshotDetails, notificationInbox])
        ])
    }
    private func connectionsShortcut() -> NSButton {
        let button = NativeView.button("Connections…", target: self, action: #selector(openProviders))
        button.setAccessibilityIdentifier("sks-center-button-providers")
        return button
    }

    @objc private func openRemoteCoding() { openSection?("Remote Coding") }
    @objc private func openProviders() { openSection?("Providers") }
    @objc private func openUpdates() { openSection?("Updates") }
    @objc private func openDiagnostics() { openSection?("Diagnostics") }

    @objc private func reviewAndResume() {
        guard let operation = operations.latestSnapshot(),
              let recovery = operation.recovery,
              recovery.state == .pausedResumable || recovery.state == .warning else {
            recoveryStatus.stringValue = "No resumable pause is available. Refresh status to inspect the latest progress signal."
            reviewAndResumeButton.isEnabled = false
            return
        }
        let section: String
        if operation.kind.localizedCaseInsensitiveContains("provider")
            || operation.kind.localizedCaseInsensitiveContains("openrouter")
            || operation.kind.localizedCaseInsensitiveContains("codex-lb") {
            section = "Providers"
        } else if operation.kind.localizedCaseInsensitiveContains("update") {
            section = "Updates"
        } else {
            section = "Diagnostics"
        }
        recoveryStatus.stringValue = "Review opened for \(operation.kind). Confirm the unchanged mode/model/account binding, then retry from \(section). Nothing resumed automatically."
        openSection?(section)
    }

    func refreshOnAppear() {
        loadStatus(forceUpdateRefresh: false)
    }

    func setNotificationAuthorizationDenied(_ denied: Bool) {
        notificationInbox.stringValue = denied
            ? "Notifications: permission denied — operation results remain available in this Control Center inbox."
            : "Notifications: authorized or not yet requested."
    }

    @objc private func refreshStatus() {
        loadStatus(forceUpdateRefresh: true)
    }

    @objc private func updateCodexCLI() {
        guard let operation = operations.begin(kind: "codex-cli-update", mutationGroup: "update", summary: "Update Codex CLI") else {
            status.stringValue = "Another update or MCP mutation is already running. Open Updates to review it."
            return
        }
        generation += 1
        setActionBusy(true)
        NativeView.setBadge(healthBadge, text: "Updating Codex CLI", color: .systemBlue)
        statusSpinner.startAnimation(nil)
        status.stringValue = "Updating Codex CLI to the preferred latest…"
        _ = operations.update(operation, state: .running, stage: "running", progress: nil, summary: status.stringValue)
        processClient.run(["codex", "update", "--json"], timeout: NativeView.longMutationTimeout) { [weak self] result in
            guard let self = self else { return }
            let ok = result.code == 0
                && !result.truncated
                && (self.json(result.output)?["ok"] as? Bool == true)
                && (self.json(result.output)?["schema"] as? String == "sks.codex-cli-update-result.v1")
            _ = self.operations.update(
                operation,
                state: ok ? .succeeded : .failed,
                stage: "complete",
                progress: 1,
                summary: ok ? "Codex CLI update completed" : "Codex CLI update failed"
            )
            self.setActionBusy(false)
            self.statusSpinner.stopAnimation(nil)
            self.status.stringValue = ok
                ? "Codex CLI update completed. Refreshing shared update status…"
                : "Codex CLI update needs attention. Open Updates or Diagnostics for structured guidance."
            self.loadStatus(forceUpdateRefresh: true)
        }
    }

    private func loadStatus(forceUpdateRefresh: Bool) {
        generation += 1
        let requestGeneration = generation
        refreshButton?.isEnabled = false
        NativeView.setBadge(healthBadge, text: "Checking local status", color: .systemBlue)
        statusSpinner.startAnimation(nil)
        status.stringValue = "Checking versions, MCP servers, and operations…"
        var update: [String: Any]?
        var mcp: [String: Any]?
        let group = DispatchGroup()
        group.enter()
        var updateArguments = ["update", "status"]
        if forceUpdateRefresh { updateArguments.append("--refresh") }
        updateArguments.append(contentsOf: ["--project-root", AppRuntime.canonicalProjectRoot])
        updateArguments.append("--json")
        processClient.run(updateArguments, timeout: NativeView.statusTimeout) { [weak self] result in
            guard let self = self else { group.leave(); return }
            let initial = self.json(result.output)
            guard !forceUpdateRefresh, self.updateSnapshotNeedsRefresh(initial) else {
                update = initial
                group.leave()
                return
            }
            self.processClient.run(
                ["update", "status", "--refresh", "--project-root", AppRuntime.canonicalProjectRoot, "--json"],
                timeout: NativeView.statusTimeout
            ) { [weak self] refreshed in
                update = self?.json(refreshed.output) ?? initial
                group.leave()
            }
        }
        group.enter()
        processClient.run([
            "mcp", "config", "list", "--scope", "effective",
            "--project-root", AppRuntime.projectRoot, "--trusted-project", "--json"
        ], timeout: 3) { [weak self] result in
            mcp = self?.json(result.output)
            group.leave()
        }
        group.notify(queue: .main) { [weak self] in
            guard let self = self, self.generation == requestGeneration else { return }
            self.completedGeneration = requestGeneration
            self.refreshButton?.isEnabled = true
            self.statusSpinner.stopAnimation(nil)
            self.renderStatus(update: update, mcp: mcp, partial: false)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self = self,
                  self.generation == requestGeneration,
                  self.completedGeneration != requestGeneration else { return }
            self.refreshButton?.isEnabled = true
            self.renderStatus(update: update, mcp: mcp, partial: true)
        }
    }

    @objc private func doctor() {
        guard let operation = operations.begin(kind: "doctor", mutationGroup: nil, summary: "Run Doctor") else {
            status.stringValue = "Another guarded operation is already running. Open Diagnostics to review it."
            return
        }
        generation += 1
        setActionBusy(true)
        NativeView.setBadge(healthBadge, text: "Doctor is running", color: .systemBlue)
        statusSpinner.startAnimation(nil)
        status.stringValue = "Doctor is running…"
        _ = operations.update(operation, state: .running, stage: "running", progress: nil, summary: status.stringValue)
        // `doctor --json` alone selects the fast-readonly profile, which skips every deep diagnostic.
        processClient.run(["doctor", "--full", "--json"], timeout: NativeView.longMutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.setActionBusy(false)
            self.statusSpinner.stopAnimation(nil)
            _ = self.operations.update(
                operation,
                state: result.code == 0 ? .succeeded : .failed,
                stage: "complete",
                progress: 1,
                summary: result.code == 0 ? "Doctor completed" : "Doctor found an issue"
            )
            if result.code == 0 {
                NativeView.setBadge(self.healthBadge, text: "Doctor completed", color: .systemGreen)
                self.status.stringValue = "Doctor completed. No blocking issue was reported."
            } else {
                NativeView.setBadge(self.healthBadge, text: "Doctor needs attention", color: .systemOrange)
                self.status.stringValue = "Doctor found an issue. Open Diagnostics · \(NativeView.redactPreview(result.output))"
            }
        }
    }

    private func setActionBusy(_ busy: Bool) {
        updateCodexButton?.isEnabled = !busy
        doctorButton?.isEnabled = !busy
        refreshButton?.isEnabled = !busy
    }

    private func renderStatus(update: [String: Any]?, mcp: [String: Any]?, partial: Bool) {
        let rendered = summary(update: update, mcp: mcp)
        snapshotDetails.stringValue = rendered
        components.arrangedSubviews.forEach { components.removeArrangedSubview($0); $0.removeFromSuperview() }
        for line in rendered.components(separatedBy: "\n") where !line.hasPrefix("Action:") && !line.hasPrefix("Last operation:") {
            guard let separator = line.range(of: ": ") else { continue }
            let key = NSTextField(labelWithString: String(line[..<separator.lowerBound]))
            key.font = .systemFont(ofSize: 12, weight: .medium)
            key.widthAnchor.constraint(equalToConstant: 88).isActive = true
            let value = String(line[separator.upperBound...]).components(separatedBy: " · ").prefix(line.hasPrefix("MCP:") ? 2 : 1).joined(separator: " · ")
            let valueField = NativeView.detail(value)
            valueField.alignment = .right
            valueField.setContentHuggingPriority(.defaultLow, for: .horizontal)
            let row = NativeView.row([key, valueField])
            components.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: components.widthAnchor).isActive = true
        }
        let needsAttention = rendered.localizedCaseInsensitiveContains("unavailable") || rendered.localizedCaseInsensitiveContains("needs attention") || ((mcp?["failed_count"] as? Int ?? 0) > 0)
        let updatesAvailable = (update?["update_count"] as? Int ?? 0) > 0
        status.stringValue = partial ? "Some checks are still running. You can keep working."
            : needsAttention ? "Some checks need attention. Open Diagnostics to review them."
            : updatesAvailable ? "Updates are available. Open Updates to review and install."
            : "Local checks are current. Choose a connection or continue in Codex."
        renderRecoveryStatus(operations.latestSnapshot())
        if partial {
            NativeView.setBadge(healthBadge, text: "Partial status · still checking", color: .systemBlue)
        } else if needsAttention {
            NativeView.setBadge(healthBadge, text: "Status refreshed · attention needed", color: .systemOrange)
        } else {
            NativeView.setBadge(healthBadge, text: "Local checks complete", color: .systemGreen)
        }
    }

    private func renderRecoveryStatus(_ operation: OperationSnapshot?) {
        let active = operation.map { ["queued", "running", "waitingForConfirmation", "pausedResumable", "warning"].contains($0.state.rawValue) } ?? false
        let needsReview = operation?.recovery.map { $0.state == .pausedResumable || $0.state == .warning } ?? false
        recoveryCard.isHidden = !active && !needsReview
        guard let operation = operation else {
            recoveryStatus.stringValue = "Progress recovery: no operation recorded · automatic resume inactive."
            reviewAndResumeButton.isEnabled = false
            return
        }
        guard let recovery = operation.recovery else {
            recoveryStatus.stringValue = "\(operation.publicSummary) · \(operation.stage ?? operation.state.rawValue)"
            reviewAndResumeButton.isEnabled = false
            return
        }
        recoveryStatus.stringValue = "\(operation.publicSummary)\n\(recovery.nextAction)"
        reviewAndResumeButton.isEnabled = recovery.state == .pausedResumable || recovery.state == .warning
        reviewAndResumeButton.toolTip = reviewAndResumeButton.isEnabled
            ? "Open the owning section for explicit review; this button never changes authentication, mode, account, or evidence."
            : "No manual resume action is required for the current state."
    }

    private func summary(update: [String: Any]?, mcp: [String: Any]?) -> String {
        let codexRunning = AppRuntime.codexBundleId.map { bundle in
            NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == bundle }
        }
        let operation = operations.latestSnapshot()
        let operationSummary = recentOperationSummary(operation)
        return OverviewSummary.render(
            update: update,
            mcp: mcp,
            menuBarBuild: AppRuntime.packageVersion,
            codexRunning: codexRunning,
            operationSummary: operationSummary
        )
    }

    private func updateSnapshotNeedsRefresh(_ update: [String: Any]?) -> Bool {
        guard let update = update,
              let sks = update["sks"] as? [String: Any],
              let menu = update["menubar"] as? [String: Any] else { return true }
        let installed = sks["current"] as? String
        let expected = menu["expected_version"] as? String
        return installed != AppRuntime.packageVersion || expected != AppRuntime.packageVersion
    }

    private func recentOperationSummary(_ operation: OperationSnapshot?) -> String {
        guard let operation = operation else { return "None recorded" }
        guard let updatedAt = SKSTimestamp.date(from: operation.updatedAt) else {
            return "\(operation.kind) · \(operation.state.rawValue) · \(operation.publicSummary)"
        }
        let age = Date().timeIntervalSince(updatedAt)
        if age > 24 * 60 * 60 { return "None in the last 24 hours" }
        let activeStates = ["queued", "running", "waitingForConfirmation"]
        if age > 15 * 60, activeStates.contains(operation.state.rawValue) {
            return "\(operation.kind) · stale \(operation.state.rawValue) record · review operation log"
        }
        return "\(operation.kind) · \(operation.state.rawValue) · \(operation.publicSummary)"
    }

    private func json(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8) else { return nil }
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { return object }
        // Child processes may print banner lines before JSON (for example a
        // migration gate message). Prefer the last top-level object payload.
        guard let start = text.range(of: "{", options: [.backwards])?.lowerBound else { return nil }
        let slice = String(text[start...])
        guard let sliced = slice.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: sliced) as? [String: Any]
    }
}
