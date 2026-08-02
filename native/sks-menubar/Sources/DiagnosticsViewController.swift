import Cocoa

final class DiagnosticsViewController: NSViewController, ControlCenterPage {
    private let processClient: ProcessClient
    private let operations: OperationCoordinator
    private let status = NativeView.detail("Diagnostics are idle.")
    private let codexGuidance = NativeView.detail("Codex CLI: prefer the latest channel. Use Updates → Update Codex CLI when status reports an update.")
    private var busy = false

    init(processClient: ProcessClient, operations: OperationCoordinator) {
        self.processClient = processClient
        self.operations = operations
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { nil }

    override func loadView() {
        let healthCard = NativeView.card(
            title: "Health checks",
            subtitle: "Doctor verifies and repairs the local SKS, Codex, and provider configuration.",
            views: [status, NativeView.row([
                ControlKit.primaryButton("Run Doctor", target: self, action: #selector(doctor), isDefault: true),
                NativeView.button("Open Last Log", target: self, action: #selector(openLog))
            ])]
        )
        let codexCard = NativeView.card(
            title: "Codex CLI",
            subtitle: "SKS stays version-agnostic; features capability-gate on the installed Codex.",
            views: [codexGuidance, NativeView.row([
                NativeView.button("Update Codex CLI", target: self, action: #selector(updateCodexCLI))
            ])]
        )
        let menuBarCard = NativeView.card(
            title: "Menu Bar app",
            subtitle: "Restart the Control Center process itself when it looks stale.",
            views: [NativeView.row([NativeView.button("Restart Menu Bar", target: self, action: #selector(restart))])]
        )
        view = NativeView.page([
            ControlKit.header("Diagnostics", "Diagnostic output is bounded, redacted, and written with owner-only permissions. Use this page when another Center action reports a blocker. Feature routes that need newer Codex fail with an update CTA instead of locking all of SKS."),
            healthCard, codexCard, menuBarCard
        ])
    }

    func refreshOnAppear() {
        guard !busy else { return }
        if let latest = operations.latestSnapshot() {
            status.stringValue = "Last operation: \(latest.kind) · \(latest.state.rawValue) · \(latest.publicSummary)"
        } else if FileManager.default.fileExists(atPath: AppRuntime.lastActionLogPath) {
            status.stringValue = "Diagnostics idle. A previous action log is available via Open Last Log."
        } else {
            status.stringValue = "Diagnostics are idle. No operation log exists yet."
        }
        refreshCodexGuidance()
    }

    private func refreshCodexGuidance() {
        let update = readJson(path: FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".sneakoscope-global/cache/update-status.json").path)
        let codex = update?["codex_cli"] as? [String: Any]
        if codex?["update_available"] as? Bool == true {
            let current = codex?["current"] as? String ?? "installed"
            let latest = codex?["latest"] as? String ?? "preferred latest"
            codexGuidance.stringValue = "Codex CLI update available: \(current) → \(latest). Prefer latest via Update Codex CLI, or run sks codex update."
        } else if let current = codex?["current"] as? String {
            codexGuidance.stringValue = "Codex CLI \(current) looks current in the shared snapshot. Prefer latest continuously; Naruto and other capability routes still probe features before use."
        } else {
            codexGuidance.stringValue = "Codex CLI: prefer the latest channel. Use Updates → Update Codex CLI when status reports an update, or run sks codex update."
        }
    }

    @objc private func doctor() {
        busy = true
        status.stringValue = "Doctor is running…"
        processClient.run(["doctor", "--json"], timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.busy = false
            if result.code == 0 {
                self.status.stringValue = "Doctor completed with no blocking issue."
                self.refreshCodexGuidance()
                return
            }
            if let json = self.json(result.output) {
                let ok = json["ok"] as? Bool
                let blockers = (json["blockers"] as? [String])?.count ?? (json["issues"] as? [Any])?.count
                if let blockers = blockers {
                    self.status.stringValue = "Doctor reported \(blockers) issue\(blockers == 1 ? "" : "s"). Open Last Log for redacted detail."
                    self.refreshCodexGuidance()
                    return
                }
                if ok == false {
                    self.status.stringValue = "Doctor reported a blocker. Open Last Log for redacted detail."
                    self.refreshCodexGuidance()
                    return
                }
            }
            self.status.stringValue = "Doctor reported a blocker · \(NativeView.redactPreview(result.output))"
            self.refreshCodexGuidance()
        }
    }

    @objc private func updateCodexCLI() {
        guard let operation = operations.begin(kind: "codex-cli-update", mutationGroup: "update", summary: "Update Codex CLI") else {
            status.stringValue = "Another update or MCP mutation is already running."
            return
        }
        busy = true
        status.stringValue = "Updating Codex CLI…"
        _ = operations.update(operation, state: .running, stage: "running", progress: nil, summary: status.stringValue)
        processClient.run(["codex", "update", "--json"], timeout: NativeView.longMutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.busy = false
            let payload = self.json(result.output)
            let ok = result.code == 0
                && !result.truncated
                && payload?["schema"] as? String == "sks.codex-cli-update-result.v1"
                && payload?["ok"] as? Bool == true
            _ = self.operations.update(
                operation,
                state: ok ? .succeeded : .failed,
                stage: "complete",
                progress: 1,
                summary: ok ? "Codex CLI update completed" : "Codex CLI update failed"
            )
            if ok {
                self.status.stringValue = "Codex CLI update completed. Shared update status will refresh on the next Overview/Updates load."
            } else {
                self.status.stringValue = "Codex CLI update needs attention. Open Updates for structured guidance, or run sks codex update."
            }
            self.refreshCodexGuidance()
        }
    }

    @objc private func openLog() {
        if FileManager.default.fileExists(atPath: AppRuntime.lastActionLogPath) {
            NSWorkspace.shared.open(URL(fileURLWithPath: AppRuntime.lastActionLogPath))
            status.stringValue = "Opened the latest redacted action log."
        } else {
            status.stringValue = "No operation log exists yet. Run Doctor or another Center action first."
        }
    }

    @objc private func restart() {
        busy = true
        status.stringValue = "Restarting Menu Bar…"
        processClient.run(["menubar", "restart", "--json"], timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.busy = false
            self.status.stringValue = result.code == 0
                ? "Restart requested. Control Center will reopen after the Menu Bar process returns."
                : "Restart failed · \(NativeView.redactPreview(result.output))"
        }
    }

    private func json(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func readJson(path: String) -> [String: Any]? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}
