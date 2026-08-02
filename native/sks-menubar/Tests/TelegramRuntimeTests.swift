#if canImport(XCTest)
import Foundation
import XCTest

private final class TelegramFakeAccess: TelegramAccessStoring, @unchecked Sendable {
    private struct Pending {
        let chatID: Int64
        let senderID: Int64
        let request: TelegramTypedCommandRequest
        let expiresAt: Date
    }

    var authorizedActors: Set<String> = []
    var pairedCode = "123456-ABCD"
    private var confirmations: [String: Pending] = [:]

    func loadToken() throws -> String? { "123456:abcdefghijklmnopqrstuvwxyzABCDE" }
    func consumePairing(code: String, chatID: Int64, senderID: Int64, chatType: String) throws -> Bool {
        guard code == pairedCode, chatType == "private" else { return false }
        authorizedActors.insert("\(chatID):\(senderID)")
        pairedCode = ""
        return true
    }
    func isAuthorized(chatID: Int64, senderID: Int64) throws -> Bool {
        authorizedActors.contains("\(chatID):\(senderID)")
    }
    func authorizedCount() throws -> Int { authorizedActors.count }
    func issueConfirmation(
        chatID: Int64,
        senderID: Int64,
        request: TelegramTypedCommandRequest,
        expiresAt: Date
    ) throws -> String {
        let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        confirmations[nonce] = Pending(
            chatID: chatID,
            senderID: senderID,
            request: request,
            expiresAt: expiresAt
        )
        return nonce
    }
    func consumeConfirmation(
        nonce: String,
        chatID: Int64,
        senderID: Int64
    ) throws -> TelegramStoredConfirmation? {
        guard let pending = confirmations[nonce],
              pending.chatID == chatID,
              pending.senderID == senderID,
              pending.expiresAt > Date() else { return nil }
        confirmations.removeValue(forKey: nonce)
        return TelegramStoredConfirmation(request: pending.request)
    }
}

private actor TelegramFakeAPI: TelegramBotAPI {
    var pending: [TelegramNativeUpdate] = []
    var offsets: [Int64] = []
    var sent: [(Int64, String)] = []

    func getMe(token: String) async throws -> TelegramNativeUser {
        TelegramNativeUser(id: 1, is_bot: true, first_name: "SKS")
    }
    func getUpdates(token: String, offset: Int64, timeoutSeconds: Int) async throws -> [TelegramNativeUpdate] {
        offsets.append(offset)
        if pending.isEmpty {
            try await Task.sleep(nanoseconds: 10_000_000)
            return []
        }
        let result = pending
        pending = []
        return result
    }
    func sendMessage(token: String, chatID: Int64, text: String) async throws { sent.append((chatID, text)) }
    func enqueue(_ updates: [TelegramNativeUpdate]) { pending.append(contentsOf: updates) }
    func messages() -> [(Int64, String)] { sent }
    func observedOffsets() -> [Int64] { offsets }
}

private actor TelegramFakeGateway: TelegramTypedCommandGateway {
    var executions: [TelegramTypedCommandRequest] = []
    func prepare(_ request: TelegramTypedCommandRequest) async -> TelegramTypedCommandDecision {
        TelegramTypedCommandDecision(allowed: true, confirmationRequired: request.name == "gates", publicError: nil)
    }
    func execute(_ request: TelegramTypedCommandRequest) async throws -> String {
        executions.append(request)
        return "ok"
    }
    func executionCount() -> Int { executions.count }
}

final class TelegramRuntimeTests: XCTestCase {
    func testProcessGatewayUsesOnlyFixedArgvAndBoundedJSONStdin() async throws {
        final class Capture: @unchecked Sendable {
            var calls: [([String], String)] = []
        }
        let capture = Capture()
        let gateway = TelegramProcessCommandGateway { arguments, stdin, _, completion in
            capture.calls.append((arguments, stdin))
            let output = arguments.contains("prepare")
                ? #"{"allowed":true,"confirmation_required":false,"public_error":null}"#
                : #"{"ok":true,"output":{"status":"ready"}}"#
            completion(ProcessResult(code: 0, output: output, truncated: false, timedOut: false, emptyOutput: false))
        }
        let request = TelegramTypedCommandRequest(name: "status", inputJSON: #"{"json":true}"#)
        XCTAssertTrue(await gateway.prepare(request).allowed)
        XCTAssertTrue(try await gateway.execute(request).contains(#""status""#))
        XCTAssertEqual(capture.calls[0].0, ["telegram", "prepare", "--stdin-json", "--json"])
        XCTAssertEqual(capture.calls[1].0, ["telegram", "execute", "--stdin-json", "--confirmed", "--json"])
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
        XCTAssertEqual(await gateway.executionCount(), 2)
        XCTAssertTrue(await api.observedOffsets().contains(9))
        let receipt = TelegramLivenessWriter(url: directory.appendingPathComponent("liveness.json")).read()
        XCTAssertEqual(receipt?.poller.offset, 9)
        XCTAssertEqual(receipt?.running, false)
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
        let confirmation = try XCTUnwrap(await api.messages().first(where: { $0.0 == 10 })?.1)
        let nonce = try XCTUnwrap(confirmation.split(separator: " ").dropFirst(4).first.map(String.init))
        await api.enqueue([
            update(id: 3, chat: 10, sender: 21, text: "/confirm \(nonce)"),
            update(id: 4, chat: 10, sender: 20, text: "/confirm \(nonce)")
        ])
        try await Task.sleep(nanoseconds: 100_000_000)
        await runtime.stop()
        XCTAssertEqual(await gateway.executionCount(), 1)
        XCTAssertFalse(await api.messages().contains(where: { $0.0 == 99 }))
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
        XCTAssertEqual(await gateway.executionCount(), 0)
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
#endif
