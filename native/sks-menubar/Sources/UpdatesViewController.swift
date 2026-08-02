import Cocoa

final class UpdatesViewController: NSViewController, ControlCenterPage {
    private struct ReviewedUpdate {
        let target: String
        let registry: String
        let projectRoot: String
    }

    private static let controlCenterUpdateEnvironment = [
        "SKS_UPDATE_DEFER_MENUBAR_RESTART": "1",
        "SKS_SKIP_SKS_MENUBAR_LAUNCH": "1"
    ]
    private let processClient: ProcessClient
    private let operations: OperationCoordinator
    private let notifications: NotificationCoordinator
    private let status = NativeView.detail("Update status has not been checked yet.")
    private let codexUpdateStatus = NativeView.detail("Codex CLI update has not been run yet.")
    private let stageStatus = NativeView.detail("Update stages: no update receipt recorded yet.")
    private let remediation = NativeView.detail("Remediation and rollback guidance will appear here when needed.")
    private let progress = NSProgressIndicator()
    private var receiptTimer: Timer?
    private var activeReceiptId: String?
    private var activeReceiptUpdatedAt: String?
    private var checkButton: NSButton!
    private var codexUpdateButton: NSButton!
    private var reviewButton: NSButton!
    private var refreshSharedSnapshotOnNextReload = false
    private var busy = false
    private static let projectContext = ["--project-root", AppRuntime.canonicalProjectRoot]

    init(processClient: ProcessClient, operations: OperationCoordinator, notifications: NotificationCoordinator) {
        self.processClient = processClient; self.operations = operations; self.notifications = notifications
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { nil }

    override func loadView() {
        progress.isIndeterminate = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        progress.controlSize = .small
        progress.isHidden = true
        checkButton = NativeView.button("Check Now", target: self, action: #selector(checkNow))
        codexUpdateButton = NativeView.button("Update Codex CLI", target: self, action: #selector(updateCodexCLI))
        codexUpdateButton.setAccessibilityHelp("Update the operator Codex CLI using its verified installation method.")
        reviewButton = ControlKit.primaryButton("Review and Update", target: self, action: #selector(reviewAndUpdate), isDefault: true)
        reviewButton.setAccessibilityHelp("Review the staged update first, then confirm before anything is installed.")
        codexUpdateStatus.setAccessibilityLabel("Codex CLI update result")
        let buttons = NSStackView(views: [checkButton, codexUpdateButton, reviewButton, progress])
        buttons.orientation = .horizontal; buttons.spacing = 8
        view = NativeView.page([
            ControlKit.header("Updates", "SKS, Codex CLI, and Menu Bar status share one local snapshot. Prefer the latest Codex CLI; SKS stays version-agnostic and capability-gates features. Network refresh only runs on demand or after expiry."),
            buttons,
            NativeView.card(title: "Status", subtitle: "Versions from the shared local snapshot.", views: [status, codexUpdateStatus]),
            NativeView.card(title: "Progress", subtitle: "Authoritative stage checklist from the update receipt.", views: [stageStatus]),
            NativeView.card(title: "Recovery", subtitle: "Rollback guidance and the previous Menu Bar app remain available if final verification fails. The update receipt records the exact recovery command and stage state.", views: [remediation])
        ])
    }

    deinit { receiptTimer?.invalidate() }

    func refreshOnAppear() { reloadSnapshot() }

    private func setBusy(_ value: Bool) {
        busy = value
        checkButton?.isEnabled = !value
        codexUpdateButton?.isEnabled = !value
        reviewButton?.isEnabled = !value
    }

    @objc private func checkNow() {
        run(["update", "status", "--refresh"] + Self.projectContext + ["--json"], kind: "update-status", group: nil)
    }

    @objc private func updateCodexCLI() {
        run(["codex", "update", "--json"], kind: "codex-cli-update", group: "update") { [weak self] result in
            guard let self = self else { return }
            self.renderCodexUpdate(result: result)
            self.refreshSharedSnapshotOnNextReload = true
            self.reloadSnapshot()
        }
    }

    @objc private func reviewAndUpdate() {
        run(["update", "review"] + Self.projectContext + ["--json"], kind: "update-review", group: nil) { [weak self] result in
            guard let self = self else { return }
            guard result.code == 0,
                  let reviewed = self.reviewedUpdate(from: result),
                  let window = self.view.window else {
                if let pending = self.operations.latestSnapshot(), pending.kind == "update-review" {
                    _ = self.operations.update(
                        pending,
                        state: .failed,
                        stage: "review-contract",
                        progress: 1,
                        summary: "Update review did not return a target and registry bound to this project"
                    )
                }
                self.status.stringValue = "Update review failed. Open Diagnostics for the redacted log."
                return
            }
            let pending = self.operations.latestSnapshot()
            AlertFactory.confirmSheet(window: window, title: "Update SKS?", message: "Review completed. Continue with the verified staged update?", destructive: false) { approved in
                if approved {
                    self.run(
                        ["update", "now", "--version", reviewed.target, "--registry", reviewed.registry]
                            + Self.projectContext + ["--json"],
                        kind: "update",
                        group: "update",
                        reviewedUpdate: reviewed
                    )
                } else if let pending = pending, pending.kind == "update-review" {
                    _ = self.operations.update(pending, state: .cancelled, stage: "confirmation", progress: 1, summary: "Update review cancelled")
                    self.status.stringValue = "Update review cancelled. No staged update was applied."
                    self.reloadSnapshot()
                }
            }
        }
    }

    private func run(
        _ args: [String],
        kind: String,
        group: String?,
        reviewedUpdate: ReviewedUpdate? = nil,
        completion: ((ProcessResult) -> Void)? = nil
    ) {
        if kind == "update", reviewedUpdate == nil {
            status.stringValue = "Update review binding is unavailable. No update was started."
            return
        }
        guard let operation = operations.begin(
            kind: kind,
            mutationGroup: group,
            summary: kind,
            targetVersion: reviewedUpdate?.target,
            projectRoot: reviewedUpdate?.projectRoot,
            registry: reviewedUpdate?.registry
        ) else {
            status.stringValue = "Another update or MCP mutation is already running."
            notifications.send(PublicNotificationEvent(
                category: "SKS_ACTION_REQUIRED",
                title: "SKS update is waiting",
                body: "Another guarded mutation is already running. Open Control Center to review it before retrying."
            ))
            return
        }
        setBusy(true)
        progress.isHidden = false
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            progress.isIndeterminate = false
            progress.minValue = 0
            progress.maxValue = 1
            progress.doubleValue = 0
        } else {
            progress.isIndeterminate = true
            progress.startAnimation(nil)
        }
        status.stringValue = "\(kind.replacingOccurrences(of: "-", with: " ").capitalized)…"
        _ = operations.update(operation, state: .running, stage: "running", progress: nil, summary: status.stringValue)
        if kind == "update" { startReceiptPolling(for: operation) }
        var environment = kind == "update" ? Self.controlCenterUpdateEnvironment : [:]
        if kind == "update" {
            environment["SKS_UPDATE_OPERATION_ID"] = operation.id
        }
        let timeout = kind == "update" || kind == "codex-cli-update"
            ? NativeView.longMutationTimeout
            : NativeView.mutationTimeout
        processClient.run(args, environment: environment, timeout: timeout) { [weak self] result in
            guard let self = self else { return }
            self.stopReceiptPolling()
            self.progress.stopAnimation(nil); self.progress.isHidden = true
            self.setBusy(false)
            let codexUpdateSucceeded = kind == "codex-cli-update" && self.codexUpdateResultIsSuccessful(result)
            var authoritativeState: OperationState?
            var restartMenuBarAfterCompletion = false
            if kind == "update" {
                if let receipt = self.operations.updateReceipt(fromProcessOutput: result.output)
                    ?? self.operations.latestUpdateReceipt(),
                   OperationCoordinator.receiptMatchesLaunchedUpdate(receipt, operation: operation) {
                    authoritativeState = OperationCoordinator.authoritativeState(
                        for: receipt,
                        processCompleted: true,
                        expectedProjectRoot: AppRuntime.canonicalProjectRoot
                    )
                    _ = self.operations.synchronize(
                        operation,
                        with: receipt,
                        processCompleted: true,
                        expectedProjectRoot: AppRuntime.canonicalProjectRoot
                    )
                    self.render(receipt: receipt)
                    restartMenuBarAfterCompletion = authoritativeState == .succeeded
                        && receipt.stages.contains { $0.id == "menubar_rebuild" && $0.status == "installed_launch_skipped" }
                } else {
                    authoritativeState = .terminalUncertain
                    _ = self.operations.update(
                        operation,
                        state: .terminalUncertain,
                        stage: "receipt",
                        progress: nil,
                        summary: "Update process ended without a readable update receipt",
                        retryable: true
                    )
                    self.stageStatus.stringValue = "Update stages: receipt unavailable; completion cannot be assumed."
                    self.remediation.stringValue = "Remediation: open the last operation log, then use Check Now for the selected project before retrying or rolling back."
                }
            } else {
                let state: OperationState
                if kind == "update-review" && result.code == 0 { state = .waitingForConfirmation }
                else if kind == "codex-cli-update" { state = codexUpdateSucceeded ? .succeeded : .failed }
                else { state = result.code == 0 ? .succeeded : .failed }
                let summary = state == .waitingForConfirmation
                    ? "Update review is waiting for confirmation"
                    : state == .succeeded ? "Update operation completed" : "Update operation failed"
                _ = self.operations.update(operation, state: state, stage: state == .waitingForConfirmation ? "confirmation" : "complete", progress: 1, summary: summary)
                if result.code != 0 {
                    self.status.stringValue = kind == "codex-cli-update"
                        ? "Codex CLI update failed. Structured guidance is shown below."
                        : "\(kind.replacingOccurrences(of: "-", with: " ").capitalized) failed · \(NativeView.redactPreview(result.output))"
                } else if kind == "codex-cli-update" && !codexUpdateSucceeded {
                    self.status.stringValue = "Codex CLI update returned an unreadable or unsuccessful result. No success state was assumed."
                } else if state == .waitingForConfirmation {
                    self.status.stringValue = "Review ready. Confirm to continue, or cancel to leave the current install unchanged."
                }
            }
            let updateOutput = kind == "update-status" ? result.output : nil
            let approvalRequired = kind == "update-review" && result.code == 0
            let updateAvailable = updateOutput != nil && NotificationCoordinator.updateIsAvailable(in: result.output)
            let authoritativeFailure = kind == "update"
                ? authoritativeState != .succeeded
                : kind == "codex-cli-update" ? !codexUpdateSucceeded : result.code != 0
            let terminalUncertain = kind == "update" && authoritativeState == .terminalUncertain
            let notificationTitle: String
            let notificationBody: String
            if updateAvailable {
                notificationTitle = "SKS update available"
                notificationBody = "A verified SKS, Codex CLI, or Menu Bar update is ready for review."
            } else if approvalRequired {
                notificationTitle = "SKS update approval required"
                notificationBody = "Review completed. Return to Control Center to approve or cancel the staged update."
            } else if terminalUncertain {
                notificationTitle = "SKS update outcome is uncertain"
                notificationBody = "The authoritative update receipt could not confirm completion. Open Control Center before retrying or rolling back."
            } else if authoritativeFailure {
                notificationTitle = kind == "codex-cli-update" ? "Codex CLI update needs attention" : "SKS update needs attention"
                notificationBody = kind == "codex-cli-update"
                    ? "The Codex CLI update did not complete successfully. Open Control Center for structured guidance."
                    : "The authoritative update state did not complete successfully. Open Control Center for redacted remediation."
            } else {
                notificationTitle = kind == "codex-cli-update" ? "Codex CLI update completed" : "SKS update operation completed"
                notificationBody = kind == "codex-cli-update"
                    ? "The operator Codex CLI update completed and its shared update status is refreshing."
                    : "The authoritative update receipt confirmed completion."
            }
            self.notifications.send(PublicNotificationEvent(
                category: NotificationCoordinator.categoryIdentifier(updateStatusOutput: updateOutput, failed: authoritativeFailure, actionRequired: approvalRequired),
                title: notificationTitle,
                body: notificationBody
            ))
            if kind == "update-status" { self.render(statusResult: result) }
            else if kind == "update" {
                if restartMenuBarAfterCompletion {
                    self.status.stringValue = "Update completed. Restarting Control Center…"
                    self.restartMenuBarAfterUpdateCompletion()
                } else {
                    self.reloadSnapshot()
                }
            }
            completion?(result)
        }
    }

    private func restartMenuBarAfterUpdateCompletion() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self = self else { return }
            do {
                try self.processClient.runDetached(["menubar", "restart", "--json"])
            } catch {
                self.status.stringValue = "Update completed, but Control Center restart could not be started."
                self.remediation.stringValue = "Remediation: run sks menubar restart, then reopen Control Center."
                self.reloadSnapshot()
            }
        }
    }

    private func reloadSnapshot() {
        let args = refreshSharedSnapshotOnNextReload
            ? ["update", "status", "--refresh"] + Self.projectContext + ["--json"]
            : ["update", "status"] + Self.projectContext + ["--json"]
        refreshSharedSnapshotOnNextReload = false
        let timeout = args.contains("--refresh") ? NativeView.mutationTimeout : NativeView.statusTimeout
        processClient.run(args, timeout: timeout) { [weak self] result in self?.render(statusResult: result) }
    }

    private func codexUpdateResultIsSuccessful(_ result: ProcessResult) -> Bool {
        guard result.code == 0,
              !result.truncated,
              let data = result.output.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["schema"] as? String == "sks.codex-cli-update-result.v1" else { return false }
        return json["ok"] as? Bool == true
    }

    private func reviewedUpdate(from result: ProcessResult) -> ReviewedUpdate? {
        guard !result.truncated,
              let data = result.output.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["schema"] as? String == "sks.update-review.v1",
              json["ok"] as? Bool == true,
              let projectRoot = json["project_root"] as? String,
              projectRoot == AppRuntime.canonicalProjectRoot,
              let target = json["target"] as? String,
              !target.isEmpty,
              target.count <= 64,
              let registry = json["registry"] as? String,
              !registry.isEmpty,
              registry.count <= 2_048,
              let canonicalRegistry = OperationCoordinator.canonicalRegistry(registry),
              canonicalRegistry == registry else { return nil }
        return ReviewedUpdate(target: target, registry: canonicalRegistry, projectRoot: projectRoot)
    }

    private func renderCodexUpdate(result: ProcessResult) {
        guard !result.truncated,
              let data = result.output.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["schema"] as? String == "sks.codex-cli-update-result.v1" else {
            codexUpdateStatus.stringValue = result.code == 0
                ? "Codex CLI update returned invalid structured output. No success state was assumed."
                : "Codex CLI update failed without readable structured guidance. Open Diagnostics for the redacted log."
            return
        }

        let ok = result.code == 0 && json["ok"] as? Bool == true
        let resultStatus = (json["status"] as? String ?? "unknown").replacingOccurrences(of: "_", with: " ")
        let method = (json["update_method"] as? String ?? "unknown").replacingOccurrences(of: "-", with: " ")
        let before = json["before_version"] as? String
        let after = json["after_version"] as? String
        let blockers = json["blockers"] as? [String] ?? []
        let guidance = json["guidance"] as? [String] ?? []
        var lines: [String] = []

        if ok {
            let version: String
            if let before = before, let after = after, before != after { version = "\(before) → \(after)" }
            else { version = after ?? before ?? "version unavailable" }
            lines.append("Codex CLI update: \(resultStatus) · \(version) · method \(method).")
            if !guidance.isEmpty { lines.append("Follow-up: \(guidance.joined(separator: " "))") }
        } else {
            lines.append("Codex CLI update: \(resultStatus) · no success state was assumed.")
            if !blockers.isEmpty { lines.append("Blockers: \(blockers.joined(separator: "; "))") }
            lines.append(guidance.isEmpty
                ? "Next step: open Diagnostics for the redacted log before retrying."
                : "Next steps: \(guidance.joined(separator: " "))")
        }
        codexUpdateStatus.stringValue = lines.joined(separator: "\n")
    }

    private func render(statusResult result: ProcessResult) {
        let receipt = operations.latestUpdateReceipt()
        if result.code != 0 {
            status.stringValue = "Update status unavailable. No success state was assumed."
            if let receipt = receipt { render(receipt: receipt) }
            return
        }
        guard let data = result.output.data(using: .utf8), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            status.stringValue = "Update status output was not valid JSON."
            if let receipt = receipt { render(receipt: receipt) }
            return
        }
        let sks = json["sks"] as? [String: Any]
        let codex = json["codex_cli"] as? [String: Any]
        let menu = json["menubar"] as? [String: Any]
        let generatedAt = json["generated_at"] as? String ?? "unknown"
        let expiresAt = json["expires_at"] as? String ?? "unknown"
        let expired = SKSTimestamp.date(from: expiresAt).map { $0 <= Date() } ?? true
        status.stringValue = [
            "SKS \(sks?["current"] as? String ?? "unknown") → \(sks?["latest"] as? String ?? "unknown") · Codex CLI \(codex?["current"] as? String ?? "unknown") → \(codex?["latest"] as? String ?? "unknown")",
            "Menu Bar expected \(menu?["expected_version"] as? String ?? AppRuntime.packageVersion) · installed \(menu?["installed_version"] as? String ?? "unknown") · rebuild \(menu?["rebuild_required"] as? Bool == true ? "required" : "not required")",
            "Last checked \(formatTimestamp(generatedAt)) · expires \(formatTimestamp(expiresAt))\(expired ? " (expired)" : "") · source \(json["source"] as? String ?? "unknown")"
        ].joined(separator: "\n")
        if let receipt = receipt { render(receipt: receipt) }
        else {
            stageStatus.stringValue = stageChecklist(receipt: nil)
            let publicError = json["public_error"] as? String
            remediation.stringValue = publicError.map { "Remediation: \($0)" } ?? "Rollback: no completed update receipt is available yet."
        }
    }

    private func startReceiptPolling(for operation: OperationSnapshot) {
        stopReceiptPolling()
        activeReceiptId = nil
        activeReceiptUpdatedAt = nil
        progress.isIndeterminate = false
        progress.minValue = 0
        progress.maxValue = Double(OperationCoordinator.updateStageOrder.count)
        progress.doubleValue = 0
        let timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self = self,
                  let receipt = self.operations.latestUpdateReceipt(),
                  OperationCoordinator.receiptMatchesLaunchedUpdate(receipt, operation: operation) else { return }
            if let active = self.activeReceiptId, active != receipt.id { return }
            if self.activeReceiptUpdatedAt == receipt.updatedAt { return }
            self.activeReceiptId = receipt.id
            self.activeReceiptUpdatedAt = receipt.updatedAt
            self.render(receipt: receipt)
        }
        timer.tolerance = 0.1
        receiptTimer = timer
    }

    private func stopReceiptPolling() {
        receiptTimer?.invalidate()
        receiptTimer = nil
        activeReceiptUpdatedAt = nil
    }

    private func render(receipt: UpdateOperationReceiptSnapshot) {
        let completed = Set(receipt.stages.map(\.id)).intersection(Set(OperationCoordinator.updateStageOrder)).count
        progress.isIndeterminate = false
        progress.minValue = 0
        progress.maxValue = Double(OperationCoordinator.updateStageOrder.count)
        progress.doubleValue = Double(completed)
        progress.isHidden = !["queued", "running"].contains(receipt.state)
        stageStatus.stringValue = stageChecklist(receipt: receipt)
        let state = receipt.state.replacingOccurrences(of: "_", with: " ")
        let current = receipt.currentStage ?? receipt.stages.last?.id ?? "not started"
        let rollbackState = receipt.sideEffectsStarted ? "available for \(receipt.previousVersion)" : "not armed before side effects"
        let publicError = receipt.publicError.map { " · \($0)" } ?? ""
        let contractIssues = OperationCoordinator.completionContractIssues(
            for: receipt,
            expectedProjectRoot: AppRuntime.canonicalProjectRoot
        )
        let reconciliation: String
        if ["succeeded", "rolled_back"].contains(receipt.state) {
            reconciliation = contractIssues.isEmpty
                ? "Post-update reconciliation: verified."
                : "Post-update reconciliation: incomplete — \(contractIssues.joined(separator: "; ")). No success state was assumed."
        } else {
            reconciliation = "Post-update reconciliation: pending or failed; review the stage checklist before retrying."
        }
        remediation.stringValue = "Receipt \(receipt.id) · \(state) · current stage \(current) · \(completed)/\(OperationCoordinator.updateStageOrder.count)\n\(reconciliation)\nRollback \(rollbackState): \(receipt.rollbackCommand)\(publicError)"
    }

    private func stageChecklist(receipt: UpdateOperationReceiptSnapshot?) -> String {
        let byId = Dictionary(uniqueKeysWithValues: (receipt?.stages ?? []).map { ($0.id, $0) })
        let current = receipt?.currentStage
        let rows = OperationCoordinator.updateStageOrder.map { id -> String in
            if let stage = byId[id] { return "\(stage.ok ? "✓" : "✕") \(id) — \(stage.status)" }
            if id == current { return "● \(id) — running" }
            return "○ \(id)"
        }
        return "Update stages (\(OperationCoordinator.updateStageOrder.count)):\n" + rows.joined(separator: "\n")
    }

    private func formatTimestamp(_ value: String) -> String {
        guard let date = SKSTimestamp.date(from: value) else { return value }
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .medium
        return formatter.string(from: date)
    }
}
