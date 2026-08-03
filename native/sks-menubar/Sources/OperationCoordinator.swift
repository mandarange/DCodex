import Foundation

final class OperationCoordinator {
    static let updateStageOrder = [
        "preflight", "download_or_registry_check", "temporary_install_smoke", "global_install",
        "resolve_new_binary", "version_probe", "new_version_doctor", "hook_trust_repair",
        "project_receipt", "global_skills_reconcile", "native_capability_setup", "menubar_rebuild",
        "menubar_signature_verify", "menubar_version_probe", "update_finalize_doctor",
        "final_self_verification", "snapshot_refresh"
    ]
    static let postUpdateReconciliationStages = [
        "hook_trust_repair", "project_receipt", "global_skills_reconcile",
        "native_capability_setup", "menubar_version_probe", "update_finalize_doctor", "final_self_verification",
        "snapshot_refresh"
    ]
    private let directory: URL
    private let queue = DispatchQueue(label: "com.sneakoscope.sks-menubar.operations")
    private var activeMutation: (id: String, group: String)?
    private var cancelled = Set<String>()

    init(directory: String) {
        self.directory = URL(fileURLWithPath: directory, isDirectory: true)
        try? FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
    }

    func begin(
        kind: String,
        mutationGroup: String?,
        summary: String,
        targetVersion: String? = nil,
        projectRoot: String? = nil,
        registry: String? = nil,
        providerApply: ProviderApplyProjection? = nil
    ) -> OperationSnapshot? {
        queue.sync {
            if mutationGroup != nil, activeMutation != nil { return nil }
            let now = ISO8601DateFormatter().string(from: Date())
            let snapshot = OperationSnapshot(
                schema: "sks.operation.v1", id: UUID().uuidString, kind: kind,
                state: .queued, stage: "queued", progress: 0, startedAt: now,
                updatedAt: now, publicSummary: summary, logPath: AppRuntime.lastActionLogPath,
                retryable: true, targetVersion: targetVersion, projectRoot: projectRoot,
                registry: registry, recovery: nil, providerApply: providerApply
            )
            if let group = mutationGroup { activeMutation = (snapshot.id, group) }
            write(snapshot)
            return snapshot
        }
    }

    func update(
        _ snapshot: OperationSnapshot,
        state: OperationState,
        stage: String?,
        progress: Double?,
        summary: String,
        retryable: Bool = true,
        releaseMutationGuard: Bool = true
    ) -> OperationSnapshot {
        queue.sync {
            let next = OperationSnapshot(
                schema: snapshot.schema, id: snapshot.id, kind: snapshot.kind, state: state,
                stage: stage, progress: progress, startedAt: snapshot.startedAt,
                updatedAt: ISO8601DateFormatter().string(from: Date()),
                publicSummary: summary, logPath: snapshot.logPath, retryable: retryable,
                targetVersion: snapshot.targetVersion, projectRoot: snapshot.projectRoot,
                registry: snapshot.registry, recovery: snapshot.recovery,
                providerApply: snapshot.providerApply
            )
            write(next)
            if releaseMutationGuard, [.succeeded, .failed, .cancelled, .terminalUncertain].contains(state) {
                if activeMutation?.id == snapshot.id { activeMutation = nil }
                cancelled.remove(snapshot.id)
            }
            return next
        }
    }

    func cancel(_ operationId: String) { _ = queue.sync { cancelled.insert(operationId) } }
    func isCancelled(_ operationId: String) -> Bool { queue.sync { cancelled.contains(operationId) } }

    func latestSnapshot() -> OperationSnapshot? {
        queue.sync {
            let files = (try? FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
            )) ?? []
            let decoder = JSONDecoder()
            return files.compactMap { url -> OperationSnapshot? in
                guard url.pathExtension == "json", let data = try? Data(contentsOf: url) else { return nil }
                return try? decoder.decode(OperationSnapshot.self, from: data)
            }.max { $0.updatedAt < $1.updatedAt }
        }
    }

    /// Records the public recovery decision in the existing private operation
    /// receipt. No request body, credential, account identifier, or secret-derived
    /// fingerprint is accepted by this API.
    func recordRecovery(
        _ snapshot: OperationSnapshot,
        status: OperationRecoveryStatus,
        summary: String
    ) -> OperationSnapshot {
        queue.sync {
            let nextState: OperationState
            switch status.state {
            case .autoResumePending: nextState = .running
            case .pausedResumable: nextState = .waitingForConfirmation
            default: nextState = snapshot.state
            }
            let next = OperationSnapshot(
                schema: snapshot.schema, id: snapshot.id, kind: snapshot.kind,
                state: nextState, stage: snapshot.stage, progress: snapshot.progress,
                startedAt: snapshot.startedAt,
                updatedAt: ISO8601DateFormatter().string(from: Date()),
                publicSummary: summary, logPath: snapshot.logPath,
                retryable: status.state == .autoResumePending || status.state == .pausedResumable,
                targetVersion: snapshot.targetVersion, projectRoot: snapshot.projectRoot,
                registry: snapshot.registry, recovery: status,
                providerApply: snapshot.providerApply
            )
            write(next)
            if status.state == .pausedResumable, activeMutation?.id == snapshot.id {
                activeMutation = nil
            }
            return next
        }
    }

    func recordProviderApplyStage(
        _ snapshot: OperationSnapshot,
        stage: ProviderApplyStageName,
        status: ProviderApplyStageState,
        reasonCode: String? = nil
    ) throws -> OperationSnapshot {
        try queue.sync {
            guard let current = snapshot.providerApply else {
                throw ProviderApplyProjectionError.invalidProjection
            }
            let projection = try current.transitioning(stage: stage, to: status, reasonCode: reasonCode)
            let nextState: OperationState
            if projection.failedStage != nil { nextState = .waitingForConfirmation }
            else if projection.allSucceeded { nextState = .succeeded }
            else { nextState = .running }
            let next = OperationSnapshot(
                schema: snapshot.schema, id: snapshot.id, kind: snapshot.kind,
                state: nextState, stage: stage.rawValue,
                progress: Double(projection.stages.filter { $0.status == .succeeded }.count) / Double(ProviderApplyStageName.allCases.count),
                startedAt: snapshot.startedAt,
                updatedAt: ISO8601DateFormatter().string(from: Date()),
                publicSummary: providerApplySummary(projection), logPath: snapshot.logPath,
                retryable: projection.failedStage != nil,
                targetVersion: snapshot.targetVersion, projectRoot: snapshot.projectRoot,
                registry: snapshot.registry, recovery: snapshot.recovery,
                providerApply: projection
            )
            write(next)
            if (nextState == .waitingForConfirmation || nextState == .succeeded)
                && activeMutation?.id == snapshot.id {
                activeMutation = nil
            }
            return next
        }
    }

    /// Executes one caller-declared retry-safe operation. The exact same closure
    /// may be re-entered only for a transient network classification and at most
    /// twice. Authentication, provider mode, account binding, external settings,
    /// and unknown causes are preserved as a manual resumable pause.
    func executeWithRecovery(
        _ snapshot: OperationSnapshot,
        pinnedMode: String?,
        pinnedModel: String?,
        retryDelay: TimeInterval = 0.25,
        attempt: @escaping (_ attemptNumber: Int, _ finish: @escaping (OperationRecoveryAttemptOutcome) -> Void) -> Void,
        onStatus: @escaping (OperationSnapshot) -> Void,
        completion: @escaping (_ succeeded: Bool, _ snapshot: OperationSnapshot) -> Void
    ) {
        var sameNetworkCauseRetries = 0
        var currentSnapshot = snapshot
        var runAttempt: (() -> Void)!
        runAttempt = { [weak self] in
            guard let self = self else { return }
            attempt(sameNetworkCauseRetries) { outcome in
                DispatchQueue.main.async {
                    if outcome.succeeded {
                        let active = OperationRecoveryPolicy.evaluate(
                            cause: nil,
                            sameCauseRetryCount: sameNetworkCauseRetries,
                            progressSignal: outcome.progressSignal,
                            progressObserved: true,
                            secondsWithoutProgress: 0,
                            warningAfter: 1,
                            pinnedMode: pinnedMode,
                            pinnedModel: pinnedModel
                        )
                        currentSnapshot = self.recordRecovery(
                            currentSnapshot,
                            status: active,
                            summary: "Progress observed · \(outcome.progressSignal.rawValue)"
                        )
                        onStatus(currentSnapshot)
                        completion(true, currentSnapshot)
                        return
                    }
                    let cause = outcome.cause ?? .unknown
                    let decision = OperationRecoveryPolicy.evaluate(
                        cause: cause,
                        sameCauseRetryCount: sameNetworkCauseRetries,
                        progressSignal: outcome.progressSignal,
                        progressObserved: false,
                        secondsWithoutProgress: 0,
                        warningAfter: 1,
                        pinnedMode: pinnedMode,
                        pinnedModel: pinnedModel
                    )
                    currentSnapshot = self.recordRecovery(
                        currentSnapshot,
                        status: decision,
                        summary: decision.nextAction
                    )
                    onStatus(currentSnapshot)
                    guard decision.state == .autoResumePending else {
                        completion(false, currentSnapshot)
                        return
                    }
                    sameNetworkCauseRetries = decision.retryCount
                    DispatchQueue.main.asyncAfter(deadline: .now() + max(0, retryDelay)) {
                        runAttempt()
                    }
                }
            }
        }
        runAttempt()
    }

    func latestUpdateReceipt() -> UpdateOperationReceiptSnapshot? {
        queue.sync { readUpdateReceipt(directory.appendingPathComponent("update-latest.json")) }
    }

    func updateReceipt(fromProcessOutput output: String) -> UpdateOperationReceiptSnapshot? {
        queue.sync {
            guard let data = output.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let rawPath = json["operation_receipt_path"] as? String else { return nil }
            let candidate = URL(fileURLWithPath: rawPath).standardizedFileURL
            let root = directory.standardizedFileURL.path
            let relative = candidate.path.replacingOccurrences(of: root + "/", with: "")
            guard candidate.path.hasPrefix(root + "/"), !relative.contains("../") else { return nil }
            return readUpdateReceipt(candidate)
        }
    }

    static func authoritativeState(
        for receipt: UpdateOperationReceiptSnapshot,
        processCompleted: Bool = false,
        expectedProjectRoot: String? = nil
    ) -> OperationState {
        let state: OperationState
        switch receipt.state {
        case "queued": state = processCompleted ? .terminalUncertain : .queued
        case "running": state = processCompleted ? .terminalUncertain : .running
        case "succeeded":
            switch receipt.resultStatus {
            case "terminal_uncertain": state = .terminalUncertain
            case "failed", "updated_with_issues": state = .failed
            default:
                let failed = receipt.stages.contains { !$0.ok }
                state = failed
                    ? .failed
                    : completionContractIssues(for: receipt, expectedProjectRoot: expectedProjectRoot).isEmpty
                        ? .succeeded
                        : .terminalUncertain
            }
        case "rolled_back":
            state = receipt.kind == "rollback"
                && completionContractIssues(for: receipt, expectedProjectRoot: expectedProjectRoot).isEmpty
                ? .succeeded
                : receipt.kind == "rollback" ? .terminalUncertain : .failed
        case "terminal_uncertain": state = .terminalUncertain
        case "failed": state = .failed
        case "cancelled": state = .cancelled
        default: state = .terminalUncertain
        }
        return state
    }

    static func completionContractIssues(
        for receipt: UpdateOperationReceiptSnapshot,
        expectedProjectRoot: String? = nil
    ) -> [String] {
        let ids = receipt.stages.map(\.id)
        let known = Set(updateStageOrder)
        let present = Set(ids)
        let missing = updateStageOrder.filter { !present.contains($0) }
        let unexpected = ids.filter { !known.contains($0) }
        let duplicates = Dictionary(grouping: ids, by: { $0 })
            .filter { $0.value.count > 1 }
            .map(\.key)
            .sorted()
        let failedReconciliation = receipt.stages
            .filter { postUpdateReconciliationStages.contains($0.id) && !$0.ok }
            .map(\.id)
        var issues: [String] = []
        if !missing.isEmpty { issues.append("missing stages: \(missing.joined(separator: ", "))") }
        if !unexpected.isEmpty { issues.append("unexpected stages: \(unexpected.joined(separator: ", "))") }
        if !duplicates.isEmpty { issues.append("duplicate stages: \(duplicates.joined(separator: ", "))") }
        if ids != updateStageOrder { issues.append("stage order mismatch") }
        if !failedReconciliation.isEmpty {
            issues.append("failed reconciliation: \(failedReconciliation.joined(separator: ", "))")
        }
        if let root = expectedProjectRoot {
            if receipt.projectRoot != root { issues.append("receipt project root mismatch") }
        }
        return issues
    }

    static func canonicalRegistry(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              ["http", "https"].contains(components.scheme?.lowercased() ?? ""),
              components.host != nil,
              components.user == nil,
              components.password == nil,
              components.query == nil else { return nil }
        components.fragment = nil
        if components.path.isEmpty { components.path = "/" }
        return components.url?.absoluteString
    }

    static func receiptMatchesLaunchedUpdate(
        _ receipt: UpdateOperationReceiptSnapshot,
        operation: OperationSnapshot
    ) -> Bool {
        guard operation.kind == "update",
              receipt.kind == "update",
              receipt.id == operation.id,
              receipt.targetVersion == operation.targetVersion,
              receipt.projectRoot == operation.projectRoot,
              let expectedRegistry = operation.registry,
              expectedRegistry == canonicalRegistry(expectedRegistry),
              let receiptRegistry = receipt.registry,
              receiptRegistry == expectedRegistry,
              receiptRegistry == canonicalRegistry(receiptRegistry) else { return false }
        return true
    }

    static func receiptRequiresAction(_ receipt: UpdateOperationReceiptSnapshot, processCompleted: Bool = false) -> Bool {
        let state = authoritativeState(for: receipt, processCompleted: processCompleted)
        return state == .failed || state == .terminalUncertain || state == .cancelled
    }

    func synchronize(
        _ snapshot: OperationSnapshot,
        with receipt: UpdateOperationReceiptSnapshot,
        processCompleted: Bool = false,
        expectedProjectRoot: String? = nil
    ) -> OperationSnapshot {
        let state = OperationCoordinator.authoritativeState(
            for: receipt,
            processCompleted: processCompleted,
            expectedProjectRoot: expectedProjectRoot
        )
        let completed = Set(receipt.stages.map(\.id)).intersection(Set(OperationCoordinator.updateStageOrder)).count
        let progress = min(1, Double(completed) / Double(OperationCoordinator.updateStageOrder.count))
        let result = receipt.resultStatus ?? receipt.state
        let stage = receipt.currentStage ?? receipt.stages.last?.id
        return update(
            snapshot,
            state: state,
            stage: stage,
            progress: progress,
            summary: "\(result.replacingOccurrences(of: "_", with: " ")) · stage \(completed)/\(OperationCoordinator.updateStageOrder.count)",
            retryable: state == .failed || state == .terminalUncertain
        )
    }

    private func write(_ snapshot: OperationSnapshot) {
        let target = directory.appendingPathComponent("\(snapshot.id).json")
        let temporary = directory.appendingPathComponent(".\(snapshot.id).\(UUID().uuidString).tmp")
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        do {
            try data.write(to: temporary, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
            _ = try FileManager.default.replaceItemAt(target, withItemAt: temporary)
        } catch {
            try? FileManager.default.removeItem(at: target)
            try? FileManager.default.moveItem(at: temporary, to: target)
        }
    }

    private func providerApplySummary(_ projection: ProviderApplyProjection) -> String {
        if let failed = projection.failedStage {
            return "Provider apply paused at \(failed.stage.rawValue) · \(failed.reasonCode ?? "provider_apply_failed")"
        }
        let completed = projection.stages.filter { $0.status == .succeeded }.count
        return projection.allSucceeded
            ? "Provider apply complete · new sessions use \(projection.newSessionDefault.mode) / \(projection.newSessionDefault.model)"
            : "Provider apply stage \(completed)/\(ProviderApplyStageName.allCases.count)"
    }

    private func readUpdateReceipt(_ url: URL) -> UpdateOperationReceiptSnapshot? {
        let permissions = (try? FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true,
              values.isSymbolicLink != true,
              (values.fileSize ?? 0) <= 1024 * 1024,
              permissions.map({ $0 & 0o077 == 0 }) != false,
              let data = try? Data(contentsOf: url),
              let receipt = try? JSONDecoder().decode(UpdateOperationReceiptSnapshot.self, from: data),
              receipt.schema == "sks.update-operation.v1",
              receiptPathIsAllowed(receipt.receiptPath, for: url),
              receipt.stages.count <= OperationCoordinator.updateStageOrder.count,
              Set(receipt.stages.map(\.id)).count == receipt.stages.count,
              receipt.stages.allSatisfy({ OperationCoordinator.updateStageOrder.contains($0.id) }) else { return nil }
        return receipt
    }

    private func receiptPathIsAllowed(_ claimedPath: String, for loadedURL: URL) -> Bool {
        let claimed = URL(fileURLWithPath: claimedPath).standardizedFileURL
        let loaded = loadedURL.standardizedFileURL
        if claimed == loaded { return true }
        return loaded.lastPathComponent == "update-latest.json"
            && claimed.deletingLastPathComponent() == directory.standardizedFileURL
            && claimed.pathExtension == "json"
    }
}
