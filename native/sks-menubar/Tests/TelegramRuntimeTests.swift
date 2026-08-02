#if canImport(XCTest)
import Darwin
import Foundation
import XCTest

final class TelegramRuntimeTests: XCTestCase {
    func testAuditLedgerRetainsOwnerOnlySegmentsAndRateLimitsUnauthorizedPressure() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sks-telegram-audit-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let auditURL = directory.appendingPathComponent("logs/telegram-audit.jsonl")
        let ledger = TelegramAuditLedger(url: auditURL, maximumBytes: 64 * 1024)
        try ledger.record(TelegramNativeAuditEvent(
            actor: "system", action: "important_start", command: nil,
            outcome: "allowed", detail: "retain-me"
        ))
        for index in 0..<180 {
            try ledger.record(TelegramNativeAuditEvent(
                actor: "actor:trusted", action: "execute", command: "status-\(index)",
                outcome: "allowed", detail: String(repeating: "x", count: 512)
            ))
        }
        let logs = auditURL.deletingLastPathComponent()
        let files = try FileManager.default.contentsOfDirectory(at: logs, includingPropertiesForKeys: nil)
        let segments = files.filter { $0.lastPathComponent.hasSuffix(".segment") }
        XCTAssertFalse(segments.isEmpty)
        let retained = try (segments + [auditURL]).map { try String(contentsOf: $0, encoding: .utf8) }.joined()
        XCTAssertTrue(retained.contains("retain-me"))
        XCTAssertTrue(retained.contains("status-179"))
        for file in segments + [auditURL] {
            let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
            XCTAssertEqual((attributes[.ownerAccountID] as? NSNumber)?.uint32Value, getuid())
            XCTAssertEqual(((attributes[.posixPermissions] as? NSNumber)?.intValue ?? -1) & 0o077, 0)
        }
        for index in 180..<800 {
            try ledger.record(TelegramNativeAuditEvent(
                actor: "actor:trusted", action: "execute", command: "status-\(index)",
                outcome: "allowed", detail: String(repeating: "y", count: 512)
            ))
        }
        let boundedFiles = try FileManager.default.contentsOfDirectory(at: logs, includingPropertiesForKeys: nil)
        let boundedSegments = boundedFiles.filter { $0.lastPathComponent.hasSuffix(".segment") }
        let boundedBytes = try boundedSegments.reduce(Int64(0)) { total, file in
            let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
            return total + Int64((attributes[.size] as? NSNumber)?.int64Value ?? -1)
        }
        XCTAssertLessThanOrEqual(boundedSegments.count, 4)
        XCTAssertLessThanOrEqual(boundedBytes, 4 * 64 * 1024)
        XCTAssertTrue(try String(contentsOf: auditURL, encoding: .utf8).contains("status-799"))

        let limitedURL = directory.appendingPathComponent("limited/telegram-audit.jsonl")
        let limited = TelegramAuditLedger(url: limitedURL, maximumBytes: 64 * 1024)
        try limited.record(TelegramNativeAuditEvent(
            actor: "system", action: "important_history", command: nil,
            outcome: "allowed", detail: "must-survive"
        ))
        for _ in 0..<200 {
            try limited.record(TelegramNativeAuditEvent(
                actor: "actor:attacker", action: "unauthorized_chat", command: nil,
                outcome: "denied", detail: nil
            ))
        }
        for _ in 0..<200 {
            try limited.record(TelegramNativeAuditEvent(
                actor: "actor:paired", action: "invalid_command", command: nil,
                outcome: "denied", detail: nil
            ))
        }
        for index in 0..<200 {
            try limited.record(TelegramNativeAuditEvent(
                actor: "actor:\(index)", action: "pair_attempt", command: nil,
                outcome: "allowed", detail: nil
            ))
        }
        let limitedText = try String(contentsOf: limitedURL, encoding: .utf8)
        let rows = limitedText.split(separator: "\n").compactMap {
            try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]
        }
        let noise = rows.filter {
            guard let action = $0["action"] as? String else { return false }
            return ["unauthorized_chat", "pair_attempt", "invalid_command"].contains(action)
        }
        XCTAssertEqual(noise.count, 64)
        XCTAssertEqual(noise.filter { ($0["actor"] as? String) == "actor:attacker" }.count, 4)
        XCTAssertEqual(noise.filter { ($0["actor"] as? String) == "actor:paired" }.count, 4)
        XCTAssertTrue(limitedText.contains("must-survive"))
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(
            at: limitedURL.deletingLastPathComponent(), includingPropertiesForKeys: nil
        ).contains { $0.lastPathComponent.hasSuffix(".segment") })
    }

    func testAuditLedgerRejectsSymlinkWithoutChangingTarget() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sks-telegram-audit-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let logs = directory.appendingPathComponent("logs")
        try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let target = directory.appendingPathComponent("target")
        try Data("unchanged".utf8).write(to: target)
        let auditURL = logs.appendingPathComponent("telegram-audit.jsonl")
        try FileManager.default.createSymbolicLink(at: auditURL, withDestinationURL: target)
        let ledger = TelegramAuditLedger(url: auditURL)
        XCTAssertThrowsError(try ledger.record(TelegramNativeAuditEvent(
            actor: "system", action: "poller_start", command: nil,
            outcome: "allowed", detail: nil
        ))) { error in
            XCTAssertEqual(error as? TelegramProcessGatewayError, .auditLedgerUnsafe)
        }
        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "unchanged")
    }

    func testPrivatePairingRemainsInactiveUntilAuditCommitAndPendingRecoversFailClosed() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sks-telegram-pair-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        try writePairingFixture(home: directory)
        let store = TelegramPrivateFileStore(homeDirectory: directory, environment: [:])
        XCTAssertTrue(try store.stagePairing(code: "123456-ABCD", chatID: 20, senderID: 30, chatType: "private"))
        XCTAssertFalse(try store.isAuthorized(chatID: 20, senderID: 30))
        XCTAssertEqual(try store.authorizedCount(), 0)
        XCTAssertTrue(try store.activatePairing(chatID: 20, senderID: 30))
        XCTAssertTrue(try store.isAuthorized(chatID: 20, senderID: 30))
        XCTAssertEqual(try store.authorizedCount(), 1)

        try writePairingFixture(home: directory)
        let restarted = TelegramPrivateFileStore(homeDirectory: directory, environment: [:])
        XCTAssertTrue(try restarted.stagePairing(code: "123456-ABCD", chatID: 40, senderID: 50, chatType: "private"))
        let binding = try restarted.bindBotIdentity(1)
        XCTAssertTrue(binding.stateReset)
        XCTAssertFalse(try restarted.isAuthorized(chatID: 40, senderID: 50))
        XCTAssertEqual(try restarted.authorizedCount(), 0)
    }

    func testProcessGatewayUsesOnlyFixedArgvAndBoundedJSONStdin() async throws {
        final class Capture: @unchecked Sendable {
            var calls: [([String], String)] = []
        }
        let capture = Capture()
        let gateway = TelegramProcessCommandGateway(canonicalProjectRoot: "/trusted/project") { arguments, stdin, _, completion in
            capture.calls.append((arguments, stdin))
            let output = arguments.contains("prepare")
                ? #"{"allowed":true,"confirmation_required":false,"public_error":null}"#
                : #"{"ok":true,"output":{"status":"ready"}}"#
            completion(ProcessResult(code: 0, output: output, truncated: false, timedOut: false, emptyOutput: false))
        }
        let request = TelegramTypedCommandRequest(name: "status", inputJSON: #"{"json":true}"#)
        let decision = await gateway.prepare(request)
        let output = try await gateway.execute(request)
        XCTAssertTrue(decision.allowed)
        XCTAssertTrue(output.contains(#""status""#))
        XCTAssertEqual(capture.calls[0].0, [
            "telegram", "prepare", "--stdin-json", "--json",
            "--project-root", "/trusted/project"
        ])
        XCTAssertEqual(capture.calls[1].0, [
            "telegram", "execute", "--stdin-json", "--confirmed", "--json",
            "--project-root", "/trusted/project"
        ])
        XCTAssertFalse(capture.calls.map(\.0).joined().contains("status"))
        XCTAssertTrue(capture.calls.allSatisfy { $0.1.contains(#""name":"status""#) })
    }

    func testSinglePollerUsesMonotonicCheckpointAndStopsCleanly() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sks-telegram-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let api = TelegramFakeAPI()
        let access = TelegramFakeAccess()
        access.authorizedActors = ["10:20"]
        let gateway = TelegramFakeGateway()
        await api.enqueue([
            update(id: 8, chat: 10, sender: 20, text: "/sks status {}"),
            update(id: 7, chat: 10, sender: 20, text: "/sks status {}")
        ])
        let runtime = TelegramMenuBarRuntime(
            api: api, access: access, gateway: gateway,
            receiptURL: directory.appendingPathComponent("liveness.json"), audit: { _ in }
        )
        _ = try await runtime.start()
        do {
            _ = try await runtime.start()
            XCTFail("a second resident poller must be rejected")
        } catch { }
        try await Task.sleep(nanoseconds: 100_000_000)
        await runtime.stop()
        let executionCount = await gateway.executionCount()
        let observedOffsets = await api.observedOffsets()
        XCTAssertEqual(executionCount, 2)
        XCTAssertTrue(observedOffsets.contains(9))
        XCTAssertEqual(access.pollOffset, 9)
        let receipt = TelegramLivenessWriter(url: directory.appendingPathComponent("liveness.json")).read()
        XCTAssertEqual(receipt?.poller.offset, 9)
        XCTAssertEqual(receipt?.token_source, .userSecretFile)
        XCTAssertEqual(receipt?.bot_id, 1)
        XCTAssertEqual(receipt?.running, false)
    }

    func testStopAndRestartSupersedePendingStartupAndUseNewestToken() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sks-telegram-start-race-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let api = TelegramDelayedIdentityAPI()
        let access = TelegramFakeAccess()
        let runtime = TelegramMenuBarRuntime(
            api: api, access: access, gateway: TelegramFakeGateway(),
            receiptURL: directory.appendingPathComponent("liveness.json"), audit: { _ in }
        )

        let firstStart = Task { try await runtime.start() }
        await api.waitForIdentityCalls(1)
        await runtime.stop()
        let stoppedReceipt = await runtime.liveness()
        XCTAssertFalse(stoppedReceipt.running)

        access.resolvedToken = "222222:abcdefghijklmnopqrstuvwxyzABCDE"
        let restarted = Task { try await runtime.restart() }
        await api.waitForIdentityCalls(2)
        await api.resolveIdentity(at: 1, botID: 2)
        let restartedReceipt = try await restarted.value
        XCTAssertTrue(restartedReceipt.running)
        XCTAssertEqual(restartedReceipt.bot_id, 2)

        await api.resolveIdentity(at: 0, botID: 1)
        do {
            _ = try await firstStart.value
            XCTFail("the superseded startup must not commit after Stop/Restart")
        } catch {
            XCTAssertEqual(
                error as? TelegramTransportError,
                .apiFailure(nil, "telegram_poller_start_cancelled")
            )
        }

        try await Task.sleep(nanoseconds: 30_000_000)
        let runningReceipt = await runtime.liveness()
        let identityTokens = await api.observedIdentityTokens()
        let updateTokens = await api.observedUpdateTokens()
        XCTAssertTrue(runningReceipt.running)
        XCTAssertEqual(runningReceipt.bot_id, 2)
        XCTAssertEqual(identityTokens, [
            "123456:abcdefghijklmnopqrstuvwxyzABCDE",
            "222222:abcdefghijklmnopqrstuvwxyzABCDE"
        ])
        XCTAssertFalse(updateTokens.isEmpty)
        XCTAssertTrue(updateTokens.allSatisfy { $0 == "222222:abcdefghijklmnopqrstuvwxyzABCDE" })
        await runtime.stop()
    }

    func testPairSuccessAuditPrecedesDurableAuthorization() async throws {
        final class Observation: @unchecked Sendable { var wasInactiveDuringSuccessAudit = false }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sks-telegram-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let api = TelegramFakeAPI()
        let access = TelegramFakeAccess()
        let observation = Observation()
        await api.enqueue([update(id: 1, chat: 10, sender: 20, text: "/start 123456-ABCD")])
        let runtime = TelegramMenuBarRuntime(
            api: api, access: access, gateway: TelegramFakeGateway(),
            receiptURL: directory.appendingPathComponent("liveness.json"),
            audit: { event in
                if event.action == "pair", event.outcome == "allowed" {
                    observation.wasInactiveDuringSuccessAudit =
                        (try? access.isAuthorized(chatID: 10, senderID: 20)) == false
                }
            }
        )
        _ = try await runtime.start()
        try await Task.sleep(nanoseconds: 100_000_000)
        await runtime.stop()
        let messages = await api.messages()
        XCTAssertTrue(observation.wasInactiveDuringSuccessAudit)
        XCTAssertTrue(try access.isAuthorized(chatID: 10, senderID: 20))
        XCTAssertTrue(messages.contains { $0.0 == 10 && $0.1.contains("control paired") })
    }

    func testUnauthorizedChatIsSilentAndDestructiveConfirmationIsActorBound() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sks-telegram-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let api = TelegramFakeAPI()
        let access = TelegramFakeAccess()
        access.authorizedActors = ["10:20", "10:21"]
        let gateway = TelegramFakeGateway()
        await api.enqueue([
            update(id: 1, chat: 99, sender: 99, text: "/sks status {}"),
            update(id: 2, chat: 10, sender: 20, text: "/sks gates {}")
        ])
        let runtime = TelegramMenuBarRuntime(
            api: api, access: access, gateway: gateway,
            receiptURL: directory.appendingPathComponent("liveness.json"), audit: { _ in }
        )
        _ = try await runtime.start()
        try await Task.sleep(nanoseconds: 100_000_000)
        let initialMessages = await api.messages()
        let confirmation = try XCTUnwrap(initialMessages.first(where: { $0.0 == 10 })?.1)
        let nonce = try XCTUnwrap(confirmation.split(separator: " ").dropFirst(4).first.map(String.init))
        await api.enqueue([
            update(id: 3, chat: 10, sender: 21, text: "/confirm \(nonce)"),
            update(id: 4, chat: 10, sender: 20, text: "/confirm \(nonce)")
        ])
        try await Task.sleep(nanoseconds: 100_000_000)
        await runtime.stop()
        let executionCount = await gateway.executionCount()
        let finalMessages = await api.messages()
        XCTAssertEqual(executionCount, 1)
        XCTAssertFalse(finalMessages.contains(where: { $0.0 == 99 }))
    }

    func testAuditFailurePreventsPollerStartAndPersistsBlocker() async throws {
        enum AuditError: Error { case unavailable }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sks-telegram-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let receiptURL = directory.appendingPathComponent("liveness.json")
        let gateway = TelegramFakeGateway()
        let runtime = TelegramMenuBarRuntime(
            api: TelegramFakeAPI(), access: TelegramFakeAccess(), gateway: gateway,
            receiptURL: receiptURL, audit: { _ in throw AuditError.unavailable }
        )
        do {
            _ = try await runtime.start()
            XCTFail("audit failure must prevent poller start")
        } catch TelegramTransportError.auditUnavailable { }
        let receipt = try XCTUnwrap(TelegramLivenessWriter(url: receiptURL).read())
        XCTAssertFalse(receipt.running)
        XCTAssertFalse(receipt.poller.running)
        XCTAssertEqual(receipt.audit_healthy, false)
        XCTAssertEqual(receipt.audit_last_error, "telegram_audit_unavailable")
        XCTAssertEqual(telegramSelfHealAction(receipt), .operatorRepairAudit)
        let executionCount = await gateway.executionCount()
        XCTAssertEqual(executionCount, 0)
    }

    func testAuditFailureDuringPollingStopsBeforeLaterAuthorizedEffects() async throws {
        enum AuditError: Error { case unavailable }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sks-telegram-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let api = TelegramFakeAPI()
        let access = TelegramFakeAccess()
        access.authorizedActors = ["10:20"]
        let gateway = TelegramFakeGateway()
        await api.enqueue([
            update(id: 1, chat: 99, sender: 99, text: "/sks status {}"),
            update(id: 2, chat: 10, sender: 20, text: "/sks status {}")
        ])
        let runtime = TelegramMenuBarRuntime(
            api: api, access: access, gateway: gateway,
            receiptURL: directory.appendingPathComponent("liveness.json"),
            audit: { event in
                if event.action == "unauthorized_chat" { throw AuditError.unavailable }
            }
        )
        _ = try await runtime.start()
        try await Task.sleep(nanoseconds: 150_000_000)
        let liveness = await runtime.liveness()
        let executionCount = await gateway.executionCount()
        let messages = await api.messages()
        XCTAssertFalse(liveness.running)
        XCTAssertFalse(liveness.poller.running)
        XCTAssertEqual(liveness.audit_healthy, false)
        XCTAssertEqual(executionCount, 0)
        XCTAssertFalse(messages.contains { $0.0 == 99 })
    }

    func testInitialLivenessWriteFailureNeverStartsPollTask() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sks-telegram-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        let blocker = directory.appendingPathComponent("not-a-directory")
        try Data("block".utf8).write(to: blocker)
        let api = TelegramFakeAPI()
        let runtime = TelegramMenuBarRuntime(
            api: api, access: TelegramFakeAccess(), gateway: TelegramFakeGateway(),
            receiptURL: blocker.appendingPathComponent("liveness.json"), audit: { _ in }
        )
        do {
            _ = try await runtime.start()
            XCTFail("liveness persistence failure must reject poller start")
        } catch { }
        try await Task.sleep(nanoseconds: 50_000_000)
        let liveness = await runtime.liveness()
        let pollCalls = await api.observedPollCalls()
        XCTAssertFalse(liveness.running)
        XCTAssertFalse(liveness.poller.running)
        XCTAssertEqual(pollCalls, 0)
    }

    func testMenuBarServiceBoundedStopPersistsStoppedReceipt() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sks-telegram-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let receiptURL = directory.appendingPathComponent("liveness.json")
        let runtime = TelegramMenuBarRuntime(
            api: TelegramFakeAPI(), access: TelegramFakeAccess(), gateway: TelegramFakeGateway(),
            receiptURL: receiptURL, audit: { _ in }
        )
        let service = TelegramMenuBarService(runtime: runtime)
        _ = try await service.start().value
        XCTAssertTrue(service.stopAndWait(timeout: 2))
        let receipt = try XCTUnwrap(TelegramLivenessWriter(url: receiptURL).read())
        XCTAssertFalse(receipt.running)
        XCTAssertFalse(receipt.poller.running)
    }
}

private func update(id: Int64, chat: Int64, sender: Int64, text: String) -> TelegramNativeUpdate {
    TelegramNativeUpdate(
        update_id: id,
        message: TelegramNativeMessage(
            message_id: id, date: 1, chat: TelegramNativeChat(id: chat, type: "private"),
            from: TelegramNativeUser(id: sender, is_bot: false, first_name: "Operator"), text: text
        )
    )
}

private func writePairingFixture(home: URL) throws {
    let root = home.appendingPathComponent(".sneakoscope", isDirectory: true)
    let stateDirectory = root.appendingPathComponent("state", isDirectory: true)
    try FileManager.default.createDirectory(
        at: stateDirectory, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: stateDirectory.path)
    let fixture: [String: Any] = [
        "schema": TelegramPrivateFileStore.stateSchema,
        "bot_id": 1,
        "poll_offset": 8,
        "pairing": [
            "schema": TelegramPrivateFileStore.pairingSchema,
            "code": "123456-ABCD",
            "expires_at": "2099-01-01T00:00:00.000Z",
            "used": false
        ],
        "chats": [[
            "chat_id": 7,
            "sender_id": 8,
            "paired_at": "2026-01-01T00:00:00.000Z"
        ]],
        "confirmations": [[
            "nonce": "old-confirmation",
            "chat_id": 7,
            "sender_id": 8,
            "command": "status",
            "input_json": "{}",
            "expires_at": "2099-01-01T00:00:00.000Z"
        ]]
    ]
    var data = try JSONSerialization.data(withJSONObject: fixture, options: [.sortedKeys])
    data.append(0x0a)
    let stateURL = stateDirectory.appendingPathComponent("telegram.json")
    try data.write(to: stateURL)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stateURL.path)
}
#endif
