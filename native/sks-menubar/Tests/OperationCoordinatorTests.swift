#if canImport(XCTest)
import Foundation
import XCTest

final class OperationCoordinatorTests: XCTestCase {
    func testCompletedSeventeenStageUpdateReceiptIsAcceptedAndReleasesMutationGuard() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("sks-operation-coordinator-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let registry = "https://registry.npmjs.org/"
        let coordinator = OperationCoordinator(directory: directory.path)
        let operation = try XCTUnwrap(
            coordinator.begin(
                kind: "update",
                mutationGroup: "update",
                summary: "Update SKS",
                targetVersion: "8.0.2",
                projectRoot: AppRuntime.canonicalProjectRoot,
                registry: registry
            )
        )
        let receiptURL = directory.appendingPathComponent("update-latest.json")
        let stages = OperationCoordinator.updateStageOrder.enumerated().map { index, id in
            [
                "id": id,
                "ok": true,
                "status": "completed",
                "updated_at": "2026-07-30T00:00:\(String(format: "%02d", index)).000Z"
            ] as [String: Any]
        }
        let receipt: [String: Any] = [
            "schema": "sks.update-operation.v1",
            "id": operation.id,
            "kind": "update",
            "state": "succeeded",
            "current_stage": "snapshot_refresh",
            "started_at": "2026-07-30T00:00:00.000Z",
            "updated_at": "2026-07-30T00:00:16.000Z",
            "from_version": "8.0.1",
            "target_version": "8.0.2",
            "previous_version": "8.0.1",
            "project_root": AppRuntime.canonicalProjectRoot,
            "registry": registry,
            "rollback_command": "sks update rollback --version 8.0.1 --project-root \(AppRuntime.canonicalProjectRoot) --json",
            "side_effects_started": true,
            "stages": stages,
            "result_status": "updated",
            "receipt_path": receiptURL.path
        ]
        let data = try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys])
        try data.write(to: receiptURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: receiptURL.path)

        XCTAssertEqual(OperationCoordinator.updateStageOrder.count, 17)
        XCTAssertTrue(OperationCoordinator.updateStageOrder.contains("update_finalize_doctor"))
        XCTAssertTrue(OperationCoordinator.updateStageOrder.contains("menubar_version_probe"))

        let loaded = try XCTUnwrap(coordinator.latestUpdateReceipt())
        XCTAssertEqual(loaded.stages.count, 17)
        XCTAssertEqual(loaded.registry, registry)
        XCTAssertTrue(OperationCoordinator.receiptMatchesLaunchedUpdate(loaded, operation: operation))
        XCTAssertNil(
            coordinator.begin(kind: "overlap", mutationGroup: "update", summary: "Overlapping update"),
            "Polling a receipt must not release the mutation guard before the process result is validated."
        )
        _ = coordinator.update(
            operation,
            state: .terminalUncertain,
            stage: "receipt",
            progress: nil,
            summary: "Unvalidated final output"
        )
        let retryAfterUncertain = try XCTUnwrap(
            coordinator.begin(kind: "unverified-retry", mutationGroup: "update", summary: "Unverified retry"),
            "Once the owned process has completed, an uncertain receipt must not permanently disable later Center mutations."
        )
        _ = coordinator.update(
            retryAfterUncertain,
            state: .cancelled,
            stage: "cancelled",
            progress: 1,
            summary: "Test cleanup"
        )

        let synchronized = coordinator.synchronize(operation, with: loaded, processCompleted: true)
        let projectBound = coordinator.synchronize(
            operation,
            with: loaded,
            processCompleted: true,
            expectedProjectRoot: AppRuntime.canonicalProjectRoot
        )
        XCTAssertEqual(projectBound.state, .succeeded)
        XCTAssertEqual(synchronized.progress, 1)
        XCTAssertTrue(
            OperationCoordinator.completionContractIssues(
                for: loaded,
                expectedProjectRoot: AppRuntime.canonicalProjectRoot
            ).isEmpty
        )
        XCTAssertNotNil(
            coordinator.begin(kind: "next-update", mutationGroup: "update", summary: "Retry update"),
            "A terminal authoritative receipt must release the mutation guard for later Center actions."
        )
    }

    func testUpdateReceiptBindingRejectsIdentityAndReviewContractMismatches() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("sks-operation-binding-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let coordinator = OperationCoordinator(directory: directory.path)
        let operation = try XCTUnwrap(
            coordinator.begin(
                kind: "update",
                mutationGroup: "update",
                summary: "Update SKS",
                targetVersion: "8.0.2",
                projectRoot: AppRuntime.canonicalProjectRoot,
                registry: "https://registry.npmjs.org/"
            )
        )
        func receipt(
            id: String? = nil,
            kind: String = "update",
            target: String? = "8.0.2",
            projectRoot: String? = AppRuntime.canonicalProjectRoot,
            registry: String? = "https://registry.npmjs.org/"
        ) -> UpdateOperationReceiptSnapshot {
            UpdateOperationReceiptSnapshot(
                schema: "sks.update-operation.v1",
                id: id ?? operation.id,
                kind: kind,
                state: "running",
                currentStage: "preflight",
                startedAt: operation.startedAt,
                updatedAt: operation.updatedAt,
                fromVersion: "8.0.1",
                targetVersion: target,
                previousVersion: "8.0.1",
                projectRoot: projectRoot,
                registry: registry,
                rollbackCommand: "sks update rollback --version 8.0.1 --json",
                sideEffectsStarted: false,
                stages: [],
                resultStatus: nil,
                publicError: nil,
                receiptPath: directory.appendingPathComponent("update-latest.json").path
            )
        }

        XCTAssertTrue(OperationCoordinator.receiptMatchesLaunchedUpdate(receipt(), operation: operation))
        XCTAssertFalse(OperationCoordinator.receiptMatchesLaunchedUpdate(receipt(id: "other-operation"), operation: operation))
        XCTAssertFalse(OperationCoordinator.receiptMatchesLaunchedUpdate(receipt(kind: "rollback"), operation: operation))
        XCTAssertFalse(OperationCoordinator.receiptMatchesLaunchedUpdate(receipt(target: "8.0.3"), operation: operation))
        XCTAssertFalse(OperationCoordinator.receiptMatchesLaunchedUpdate(receipt(projectRoot: "/different/project"), operation: operation))
        XCTAssertFalse(OperationCoordinator.receiptMatchesLaunchedUpdate(receipt(registry: "https://registry.example/"), operation: operation))
        XCTAssertFalse(OperationCoordinator.receiptMatchesLaunchedUpdate(receipt(registry: "https://registry.npmjs.org"), operation: operation))
    }

    func testRegistryCanonicalizationMatchesUpdateContract() {
        XCTAssertEqual(
            OperationCoordinator.canonicalRegistry("https://registry.npmjs.org"),
            "https://registry.npmjs.org/"
        )
        XCTAssertEqual(
            OperationCoordinator.canonicalRegistry("https://registry.npmjs.org/#ignored"),
            "https://registry.npmjs.org/"
        )
        XCTAssertNil(OperationCoordinator.canonicalRegistry("file:///tmp/registry"))
        XCTAssertNil(OperationCoordinator.canonicalRegistry("https://token@registry.npmjs.org/"))
        XCTAssertNil(OperationCoordinator.canonicalRegistry("https://registry.npmjs.org/?token=secret"))
    }

    func testProviderApplyStagesAreOrderedAndKeepExistingSessionSeparateFromNewDefault() throws {
        let existing = ProviderSessionCopy(mode: "codex-lb", model: "gpt-existing", catalogVersion: "catalog-v1")
        let nextDefault = ProviderSessionCopy(mode: "openrouter", model: "vendor/new", catalogVersion: "catalog-v2")
        var projection = ProviderApplyProjection.initial(
            existingSession: existing,
            newSessionDefault: nextDefault,
            now: Date(timeIntervalSince1970: 0)
        )
        for stage in ProviderApplyStageName.allCases {
            projection = try projection.transitioning(stage: stage, to: .running)
            projection = try projection.transitioning(stage: stage, to: .succeeded)
        }
        XCTAssertTrue(projection.allSucceeded)
        XCTAssertEqual(projection.existingSession, existing)
        XCTAssertEqual(projection.newSessionDefault, nextDefault)
    }

    func testProviderApplyPartialFailureCannotSkipAheadOrSilentlySucceed() throws {
        let nextDefault = ProviderSessionCopy(mode: "codex-lb", model: "gpt-new", catalogVersion: "catalog-v2")
        var projection = ProviderApplyProjection.initial(existingSession: nil, newSessionDefault: nextDefault)
        projection = try projection.transitioning(stage: .configSaved, to: .running)
        projection = try projection.transitioning(stage: .configSaved, to: .succeeded)
        projection = try projection.transitioning(stage: .proxyApplied, to: .running)
        projection = try projection.transitioning(stage: .proxyApplied, to: .failed, reasonCode: "provider_proxy_offline")
        XCTAssertEqual(projection.failedStage?.stage, .proxyApplied)
        XCTAssertFalse(projection.allSucceeded)
        XCTAssertThrowsError(try projection.transitioning(stage: .catalogRefreshed, to: .running))
    }

    func testProgressRecoveryOnlyAutoRetriesTransientNetworkTwice() {
        let first = OperationRecoveryPolicy.evaluate(
            cause: .transientNetwork,
            sameCauseRetryCount: 0,
            progressSignal: .none,
            progressObserved: false,
            secondsWithoutProgress: 5,
            warningAfter: 1
        )
        let second = OperationRecoveryPolicy.evaluate(
            cause: .transientNetwork,
            sameCauseRetryCount: first.retryCount,
            progressSignal: .none,
            progressObserved: false,
            secondsWithoutProgress: 5,
            warningAfter: 1
        )
        let exhausted = OperationRecoveryPolicy.evaluate(
            cause: .transientNetwork,
            sameCauseRetryCount: second.retryCount,
            progressSignal: .none,
            progressObserved: false,
            secondsWithoutProgress: 5,
            warningAfter: 1
        )
        let auth = OperationRecoveryPolicy.evaluate(
            cause: .authentication,
            sameCauseRetryCount: 0,
            progressSignal: .none,
            progressObserved: false,
            secondsWithoutProgress: 1,
            warningAfter: 1
        )
        XCTAssertEqual(first.state, .autoResumePending)
        XCTAssertEqual(second.retryCount, 2)
        XCTAssertEqual(exhausted.state, .pausedResumable)
        XCTAssertEqual(auth.state, .pausedResumable)
        XCTAssertFalse(auth.automaticResume)
        XCTAssertEqual(auth.evidenceIntegrity, "preserved")
    }
}
#endif
