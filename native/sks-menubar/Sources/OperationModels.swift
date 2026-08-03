import Foundation

// SKS CLI timestamps come from JavaScript Date.toISOString() and carry
// fractional seconds ("2026-07-24T00:00:00.000Z"), which the default
// ISO8601DateFormatter options cannot parse. Try fractional first, then plain.
enum SKSTimestamp {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let plain = ISO8601DateFormatter()

    static func date(from value: String) -> Date? {
        fractional.date(from: value) ?? plain.date(from: value)
    }
}

enum OperationState: String, Codable {
    case queued, running, waitingForConfirmation, succeeded, failed, cancelled, terminalUncertain
}

enum OperationProgressSignal: String, Codable, CaseIterable {
    case evidence, fileChange, testResult, modelResponse, toolResponse, none
}

enum OperationRecoveryCause: String, Codable, CaseIterable {
    case transientNetwork
    case authentication
    case providerMode
    case accountBinding
    case externalConfiguration
    case unknown
}

enum OperationRecoveryState: String, Codable {
    case active
    case warning
    case autoResumePending
    case pausedResumable
}

enum ProviderApplyStageName: String, Codable, CaseIterable {
    case configSaved = "config_saved"
    case proxyApplied = "proxy_applied"
    case catalogRefreshed = "catalog_refreshed"
    case newSessionReady = "new_session_ready"
}

enum ProviderApplyStageState: String, Codable {
    case pending, running, succeeded, failed
}

struct ProviderApplyStageReceipt: Codable, Equatable {
    let stage: ProviderApplyStageName
    let status: ProviderApplyStageState
    let reasonCode: String?
    let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case stage, status
        case reasonCode = "reason_code"
        case updatedAt = "updated_at"
    }
}

struct ProviderSessionCopy: Codable, Equatable {
    let mode: String
    let model: String
    let catalogVersion: String

    enum CodingKeys: String, CodingKey {
        case mode, model
        case catalogVersion = "catalog_version"
    }
}

struct ProviderApplyProjection: Codable, Equatable {
    let schema: String
    let stages: [ProviderApplyStageReceipt]
    let existingSession: ProviderSessionCopy?
    let newSessionDefault: ProviderSessionCopy

    enum CodingKeys: String, CodingKey {
        case schema, stages
        case existingSession = "existing_session"
        case newSessionDefault = "new_session_default"
    }

    static func initial(
        existingSession: ProviderSessionCopy?,
        newSessionDefault: ProviderSessionCopy,
        now: Date = Date()
    ) -> ProviderApplyProjection {
        let timestamp = ISO8601DateFormatter().string(from: now)
        return ProviderApplyProjection(
            schema: "sks.provider-apply-projection.v1",
            stages: ProviderApplyStageName.allCases.map {
                ProviderApplyStageReceipt(stage: $0, status: .pending, reasonCode: nil, updatedAt: timestamp)
            },
            existingSession: existingSession,
            newSessionDefault: newSessionDefault
        )
    }

    func transitioning(
        stage: ProviderApplyStageName,
        to status: ProviderApplyStageState,
        reasonCode: String? = nil,
        now: Date = Date()
    ) throws -> ProviderApplyProjection {
        guard schema == "sks.provider-apply-projection.v1",
              stages.map(\.stage) == ProviderApplyStageName.allCases,
              let index = stages.firstIndex(where: { $0.stage == stage }) else {
            throw ProviderApplyProjectionError.invalidProjection
        }
        if status == .failed, reasonCode == nil { throw ProviderApplyProjectionError.failureReasonRequired }
        if status != .failed, reasonCode != nil { throw ProviderApplyProjectionError.unexpectedReason }
        let current = stages[index].status
        let validTransition = current == status
            || current == .pending && status == .running
            || current == .running && (status == .succeeded || status == .failed)
            || current == .failed && status == .running
        guard validTransition else { throw ProviderApplyProjectionError.invalidTransition }
        if status != .pending, index > 0, stages[index - 1].status != .succeeded {
            throw ProviderApplyProjectionError.previousStageIncomplete
        }
        var next = stages
        next[index] = ProviderApplyStageReceipt(
            stage: stage,
            status: status,
            reasonCode: reasonCode,
            updatedAt: ISO8601DateFormatter().string(from: now)
        )
        return ProviderApplyProjection(
            schema: schema,
            stages: next,
            existingSession: existingSession,
            newSessionDefault: newSessionDefault
        )
    }

    var allSucceeded: Bool { stages.allSatisfy { $0.status == .succeeded } }
    var failedStage: ProviderApplyStageReceipt? { stages.first { $0.status == .failed } }
}

enum ProviderApplyProjectionError: Error {
    case invalidProjection
    case failureReasonRequired
    case unexpectedReason
    case invalidTransition
    case previousStageIncomplete
}

struct OperationRecoveryStatus: Codable, Equatable {
    let schema: String
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

    enum CodingKeys: String, CodingKey {
        case schema, state, cause
        case automaticResume = "automatic_resume"
        case retryCount = "retry_count"
        case maxAutomaticRetries = "max_automatic_retries"
        case lastProgressSignal = "last_progress_signal"
        case lastProgressAt = "last_progress_at"
        case stallReason = "stall_reason"
        case recoveryAttempt = "recovery_attempt"
        case nextAction = "next_action"
        case pinnedMode = "pinned_mode"
        case pinnedModel = "pinned_model"
        case accountBinding = "account_binding"
        case evidenceIntegrity = "evidence_integrity"
    }
}

struct OperationRecoveryAttemptOutcome {
    let succeeded: Bool
    let cause: OperationRecoveryCause?
    let progressSignal: OperationProgressSignal

    static func success(_ signal: OperationProgressSignal) -> OperationRecoveryAttemptOutcome {
        OperationRecoveryAttemptOutcome(succeeded: true, cause: nil, progressSignal: signal)
    }

    static func failure(_ cause: OperationRecoveryCause) -> OperationRecoveryAttemptOutcome {
        OperationRecoveryAttemptOutcome(succeeded: false, cause: cause, progressSignal: .none)
    }
}

enum OperationRecoveryPolicy {
    static let maxAutomaticNetworkRetries = 2

    /// Time is diagnostic only. A fresh progress signal always keeps the work
    /// active, even after a warning threshold. Only a classified cause may choose
    /// automatic or manual recovery, and only transient network causes auto-resume.
    static func evaluate(
        cause: OperationRecoveryCause?,
        sameCauseRetryCount: Int,
        progressSignal: OperationProgressSignal,
        progressObserved: Bool,
        secondsWithoutProgress: TimeInterval,
        warningAfter: TimeInterval,
        pinnedMode: String? = nil,
        pinnedModel: String? = nil,
        now: Date = Date()
    ) -> OperationRecoveryStatus {
        let retryCount = max(0, sameCauseRetryCount)
        let timestamp = ISO8601DateFormatter().string(from: now)
        let shared = (
            schema: "sks.operation-recovery.v1",
            signal: progressSignal,
            timestamp: timestamp,
            mode: pinnedMode,
            model: pinnedModel
        )
        if progressObserved {
            return OperationRecoveryStatus(
                schema: shared.schema, state: .active, cause: nil,
                automaticResume: false, retryCount: retryCount,
                maxAutomaticRetries: maxAutomaticNetworkRetries,
                lastProgressSignal: shared.signal, lastProgressAt: shared.timestamp,
                stallReason: nil, recoveryAttempt: nil,
                nextAction: "Work is progressing; keep running.",
                pinnedMode: shared.mode, pinnedModel: shared.model,
                accountBinding: "pinned_unchanged", evidenceIntegrity: "preserved"
            )
        }
        guard let cause = cause else {
            let warning = secondsWithoutProgress >= max(1, warningAfter)
            return OperationRecoveryStatus(
                schema: shared.schema, state: warning ? .warning : .active, cause: nil,
                automaticResume: false, retryCount: retryCount,
                maxAutomaticRetries: maxAutomaticNetworkRetries,
                lastProgressSignal: shared.signal, lastProgressAt: shared.timestamp,
                stallReason: warning ? "No progress signal observed; time budget is warning-only." : nil,
                recoveryAttempt: warning ? "Inspect runner health without terminating the operation." : nil,
                nextAction: warning ? "Keep state resumable and inspect the stalled stage." : "Keep running.",
                pinnedMode: shared.mode, pinnedModel: shared.model,
                accountBinding: "pinned_unchanged", evidenceIntegrity: "preserved"
            )
        }
        if cause == .transientNetwork, retryCount < maxAutomaticNetworkRetries {
            let nextRetry = retryCount + 1
            return OperationRecoveryStatus(
                schema: shared.schema, state: .autoResumePending, cause: cause,
                automaticResume: true, retryCount: nextRetry,
                maxAutomaticRetries: maxAutomaticNetworkRetries,
                lastProgressSignal: shared.signal, lastProgressAt: shared.timestamp,
                stallReason: "Transient network interruption.",
                recoveryAttempt: "Bounded automatic resume \(nextRetry)/\(maxAutomaticNetworkRetries).",
                nextAction: "Retry the same request with the same pinned mode, model, and account binding.",
                pinnedMode: shared.mode, pinnedModel: shared.model,
                accountBinding: "pinned_unchanged", evidenceIntegrity: "preserved"
            )
        }
        let reason = cause == .transientNetwork
            ? "Transient network retry limit reached."
            : "\(cause.rawValue) requires explicit user review."
        return OperationRecoveryStatus(
            schema: shared.schema, state: .pausedResumable, cause: cause,
            automaticResume: false, retryCount: min(retryCount, maxAutomaticNetworkRetries),
            maxAutomaticRetries: maxAutomaticNetworkRetries,
            lastProgressSignal: shared.signal, lastProgressAt: shared.timestamp,
            stallReason: reason, recoveryAttempt: nil,
            nextAction: "Review the cause in SKS Center, then resume explicitly from the owning section.",
            pinnedMode: shared.mode, pinnedModel: shared.model,
            accountBinding: "pinned_unchanged", evidenceIntegrity: "preserved"
        )
    }
}

struct OperationSnapshot: Codable {
    let schema: String
    let id: String
    let kind: String
    let state: OperationState
    let stage: String?
    let progress: Double?
    let startedAt: String
    let updatedAt: String
    let publicSummary: String
    let logPath: String?
    let retryable: Bool
    let targetVersion: String?
    let projectRoot: String?
    let registry: String?
    let recovery: OperationRecoveryStatus?
    let providerApply: ProviderApplyProjection?

    init(
        schema: String,
        id: String,
        kind: String,
        state: OperationState,
        stage: String?,
        progress: Double?,
        startedAt: String,
        updatedAt: String,
        publicSummary: String,
        logPath: String?,
        retryable: Bool,
        targetVersion: String?,
        projectRoot: String?,
        registry: String?,
        recovery: OperationRecoveryStatus? = nil,
        providerApply: ProviderApplyProjection? = nil
    ) {
        self.schema = schema
        self.id = id
        self.kind = kind
        self.state = state
        self.stage = stage
        self.progress = progress
        self.startedAt = startedAt
        self.updatedAt = updatedAt
        self.publicSummary = publicSummary
        self.logPath = logPath
        self.retryable = retryable
        self.targetVersion = targetVersion
        self.projectRoot = projectRoot
        self.registry = registry
        self.recovery = recovery
        self.providerApply = providerApply
    }
}

struct UpdateOperationStageSnapshot: Codable {
    let id: String
    let ok: Bool
    let status: String
    let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, ok, status
        case updatedAt = "updated_at"
    }
}

struct UpdateOperationReceiptSnapshot: Codable {
    let schema: String
    let id: String
    let kind: String
    let state: String
    let currentStage: String?
    let startedAt: String
    let updatedAt: String
    let fromVersion: String
    let targetVersion: String?
    let previousVersion: String
    let projectRoot: String?
    let registry: String?
    let rollbackCommand: String
    let sideEffectsStarted: Bool
    let stages: [UpdateOperationStageSnapshot]
    let resultStatus: String?
    let publicError: String?
    let receiptPath: String

    enum CodingKeys: String, CodingKey {
        case schema, id, kind, state, stages
        case currentStage = "current_stage"
        case startedAt = "started_at"
        case updatedAt = "updated_at"
        case fromVersion = "from_version"
        case targetVersion = "target_version"
        case previousVersion = "previous_version"
        case projectRoot = "project_root"
        case registry
        case rollbackCommand = "rollback_command"
        case sideEffectsStarted = "side_effects_started"
        case resultStatus = "result_status"
        case publicError = "public_error"
        case receiptPath = "receipt_path"
    }
}

