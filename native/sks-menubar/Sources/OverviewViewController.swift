import Cocoa

/// Pages that should reload local status whenever the Control Center section becomes visible.
protocol ControlCenterPage: AnyObject {
    func refreshOnAppear()
}

final class TopAlignedStackView: NSStackView {
    override var isFlipped: Bool { true }
}

enum NativeView {
    static let statusTimeout: TimeInterval = 8
    static let mutationTimeout: TimeInterval = 90
    static let longMutationTimeout: TimeInterval = 60 * 60

    static func title(_ value: String) -> NSTextField {
        let field = NSTextField(labelWithString: value)
        field.font = NSFont.systemFont(ofSize: 18, weight: .semibold)
        field.alignment = .left
        field.setAccessibilityLabel(value)
        field.setAccessibilityIdentifier("sks-center-heading-\(identifier(value))")
        return field
    }

    static func detail(_ value: String) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: value)
        field.font = NSFont.systemFont(ofSize: 12)
        field.textColor = .secondaryLabelColor
        field.alignment = .left
        // Long status and help copy must wrap inside the current window instead
        // of contributing an intrinsic minimum width while users change pages.
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }

    static func sectionTitle(_ value: String) -> NSTextField {
        let field = NSTextField(labelWithString: value)
        field.font = NSFont.systemFont(ofSize: 14, weight: .semibold)
        field.alignment = .left
        field.setAccessibilityLabel(value)
        return field
    }

    static func button(_ title: String, target: AnyObject, action: Selector) -> NSButton {
        let button = NSButton(title: title, target: target, action: action)
        button.bezelStyle = .rounded
        button.setAccessibilityLabel(title)
        button.setAccessibilityIdentifier("sks-center-button-\(identifier(title))")
        return button
    }

    static func stack(_ views: [NSView]) -> NSStackView {
        let stack = TopAlignedStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 22, left: 24, bottom: 22, right: 24)
        return stack
    }

    static func page(_ views: [NSView]) -> NSStackView {
        let stack = stack(views)
        stack.alignment = .width
        for view in stack.arrangedSubviews {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -48).isActive = true
        }
        return stack
    }

    static func row(_ views: [NSView], spacing: CGFloat = 8) -> NSStackView {
        let row = NSStackView(views: views)
        row.orientation = .horizontal; row.alignment = .centerY; row.spacing = spacing
        row.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return row
    }

    static func card(title: String, subtitle: String, views: [NSView], fullWidthLeadingContent: Bool = false) -> NSBox {
        let box = NSBox()
        box.boxType = .custom; box.titlePosition = .noTitle
        box.cornerRadius = 10; box.borderWidth = 1
        box.borderColor = .separatorColor; box.fillColor = .controlBackgroundColor
        box.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let heading = sectionTitle(title); let help = detail(subtitle)
        let content = NSStackView(views: [heading, help] + views)
        content.orientation = .vertical; content.alignment = .width
        content.spacing = 10; content.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        content.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for view in content.arrangedSubviews {
            view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            view.widthAnchor.constraint(equalTo: content.widthAnchor, constant: -32).isActive = true
        }
        content.translatesAutoresizingMaskIntoConstraints = false
        box.contentView?.addSubview(content)
        if let host = box.contentView {
            NSLayoutConstraint.activate([
                content.leadingAnchor.constraint(equalTo: host.leadingAnchor),
                content.trailingAnchor.constraint(equalTo: host.trailingAnchor),
                content.topAnchor.constraint(equalTo: host.topAnchor),
                content.bottomAnchor.constraint(equalTo: host.bottomAnchor)
            ])
        }
        box.setAccessibilityLabel(title)
        box.setAccessibilityHelp(subtitle)
        box.setAccessibilityRole(.group)
        box.setAccessibilityIdentifier("sks-center-card-\(identifier(title))")
        return box
    }

    static func badge(_ text: String, color: NSColor) -> NSView {
        let dot = NSTextField(labelWithString: "●")
        dot.font = NSFont.systemFont(ofSize: 10)
        dot.textColor = color
        dot.setAccessibilityHidden(true)
        let label = NSTextField(labelWithString: text)
        label.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        label.alignment = .left
        label.lineBreakMode = .byTruncatingTail
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        label.setAccessibilityLabel(text)
        let row = NSStackView(views: [dot, label])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 5
        return row
    }

    static func setBadge(_ view: NSView, text: String, color: NSColor) {
        guard let row = view as? NSStackView, row.arrangedSubviews.count >= 2,
              let dot = row.arrangedSubviews[0] as? NSTextField,
              let label = row.arrangedSubviews[1] as? NSTextField else { return }
        dot.textColor = color
        label.stringValue = text
        label.setAccessibilityLabel(text)
    }

    static func spinner(label: String) -> NSProgressIndicator {
        let indicator = NSProgressIndicator()
        indicator.style = .spinning
        indicator.controlSize = .small
        indicator.isDisplayedWhenStopped = false
        indicator.setAccessibilityLabel(label)
        return indicator
    }

    static func scrollable(_ document: NSView) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.scrollerStyle = .overlay
        scroll.borderType = .noBorder
        scroll.autohidesScrollers = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        document.translatesAutoresizingMaskIntoConstraints = false
        document.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        scroll.documentView = document
        if let content = scroll.contentView.documentView {
            NSLayoutConstraint.activate([
                content.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
                content.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
                content.topAnchor.constraint(equalTo: scroll.contentView.topAnchor)
            ])
        }
        return scroll
    }

    static func redactPreview(_ output: String, limit: Int = 160) -> String {
        let compact = output.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !compact.isEmpty else { return "No public detail was returned." }
        if compact.count <= limit { return compact }
        return String(compact.prefix(limit)) + "…"
    }

    private static func identifier(_ value: String) -> String {
        value.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .joined(separator: "-")
    }
}

final class OverviewViewController: NSViewController, ControlCenterPage {
    private let processClient: ProcessClient
    private let operations: OperationCoordinator
    private let status = NativeView.detail("Loading local SKS status…")
    private let notificationInbox = NativeView.detail("Notifications: checking authorization…")
    private let recoveryStatus = NativeView.detail("Progress recovery: no operation state loaded yet.")
    private let healthBadge = NativeView.badge("Checking local status", color: .systemBlue)
    private let statusSpinner = NativeView.spinner(label: "Checking SKS Center status")
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
            NativeView.button("Providers…", target: self, action: #selector(openProviders)),
            NativeView.button("Updates…", target: self, action: #selector(openUpdates)),
            NativeView.button("Diagnostics…", target: self, action: #selector(openDiagnostics))
        ])
        shortcuts.setAccessibilityLabel("Open Control Center sections")
        let healthCard = NativeView.card(
            title: "System health",
            subtitle: "A bounded local snapshot of versions, services, and the latest operation.",
            views: [NativeView.row([healthBadge, statusSpinner]), status, buttons]
        )
        let nextStepsCard = NativeView.card(
            title: "Notifications & next steps",
            subtitle: "Results remain available here even when macOS notifications are disabled.",
            views: [notificationInbox, shortcuts]
        )
        let recoveryCard = NativeView.card(
            title: "Progress, pause & recovery",
            subtitle: "Time budgets are warnings, never automatic termination. Only transient network failures can auto-resume, at most twice. Authentication, mode, account binding, and external configuration always wait for explicit review.",
            views: [recoveryStatus, NativeView.row([reviewAndResumeButton])]
        )
        view = NativeView.page([
            NativeView.title("Overview"),
            NativeView.detail("Menu Bar build \(AppRuntime.packageVersion) · Local health for SKS, Codex CLI, MCP, and operations. Prefer the latest Codex CLI; SKS stays version-agnostic and capability-gates features."),
            healthCard,
            recoveryCard,
            nextStepsCard
        ])
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
        processClient.run(["doctor", "--json"], timeout: NativeView.mutationTimeout) { [weak self] result in
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
        status.stringValue = rendered
        renderRecoveryStatus(operations.latestSnapshot())
        if partial {
            NativeView.setBadge(healthBadge, text: "Partial status · still checking", color: .systemBlue)
        } else if rendered.localizedCaseInsensitiveContains("unavailable")
                    || rendered.localizedCaseInsensitiveContains("needs attention") {
            NativeView.setBadge(healthBadge, text: "Status refreshed · attention needed", color: .systemOrange)
        } else {
            NativeView.setBadge(healthBadge, text: "Status refreshed", color: .systemGreen)
        }
    }

    private func renderRecoveryStatus(_ operation: OperationSnapshot?) {
        guard let operation = operation else {
            recoveryStatus.stringValue = "Progress recovery: no operation recorded · automatic resume inactive."
            reviewAndResumeButton.isEnabled = false
            return
        }
        guard let recovery = operation.recovery else {
            recoveryStatus.stringValue = "Progress recovery: no pause/retry decision recorded for \(operation.kind) · critical path \(operation.stage ?? "unknown") · cache evidence not reported."
            reviewAndResumeButton.isEnabled = false
            return
        }
        let cause = recovery.cause?.rawValue ?? "none"
        let automatic = recovery.automaticResume ? "yes" : "no"
        let mode = recovery.pinnedMode ?? "not reported"
        let model = recovery.pinnedModel ?? "not reported"
        let stall = recovery.stallReason.map { " · stop reason: \($0)" } ?? ""
        let attempt = recovery.recoveryAttempt.map { " · recovery: \($0)" } ?? ""
        recoveryStatus.stringValue = "State \(recovery.state.rawValue) · progress \(recovery.lastProgressSignal.rawValue) at \(recovery.lastProgressAt) · cause \(cause) · auto resume \(automatic) · retry \(recovery.retryCount)/\(recovery.maxAutomaticRetries) · critical path \(operation.stage ?? "unknown") · mode \(mode) · model \(model) · account \(recovery.accountBinding) · evidence \(recovery.evidenceIntegrity)\(stall)\(attempt) · next: \(recovery.nextAction)"
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
