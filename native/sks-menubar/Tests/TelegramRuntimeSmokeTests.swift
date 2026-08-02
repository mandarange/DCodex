#if TELEGRAM_STANDALONE_TEST
import Foundation

private enum TelegramSmokeError: Error { case auditUnavailable }

private final class TelegramSmokeAccess: TelegramAccessStoring, @unchecked Sendable {
    func loadToken() throws -> String? { "123456:abcdefghijklmnopqrstuvwxyzABCDE" }
    func consumePairing(code: String, chatID: Int64, senderID: Int64, chatType: String) throws -> Bool { false }
    func isAuthorized(chatID: Int64, senderID: Int64) throws -> Bool { chatID == 10 && senderID == 20 }
    func authorizedCount() throws -> Int { 1 }
    func issueConfirmation(
        chatID: Int64,
        senderID: Int64,
        request: TelegramTypedCommandRequest,
        expiresAt: Date
    ) throws -> String { "unused-confirmation" }
    func consumeConfirmation(
        nonce: String,
        chatID: Int64,
        senderID: Int64
    ) throws -> TelegramStoredConfirmation? { nil }
}

private actor TelegramSmokeAPI: TelegramBotAPI {
    var first = true
    var offsets: [Int64] = []
    var replies: [String] = []
    func getMe(token: String) async throws -> TelegramNativeUser {
        TelegramNativeUser(id: 1, is_bot: true, first_name: "SKS")
    }
    func getUpdates(token: String, offset: Int64, timeoutSeconds: Int) async throws -> [TelegramNativeUpdate] {
        offsets.append(offset)
        guard first else {
            try await Task.sleep(nanoseconds: 10_000_000)
            return []
        }
        first = false
        return [
            TelegramNativeUpdate(update_id: 4, message: TelegramNativeMessage(
                message_id: 1, date: 1, chat: TelegramNativeChat(id: 99, type: "private"),
                from: TelegramNativeUser(id: 99, is_bot: false, first_name: "No"), text: "/sks status {}"
            )),
            TelegramNativeUpdate(update_id: 5, message: TelegramNativeMessage(
                message_id: 2, date: 1, chat: TelegramNativeChat(id: 10, type: "private"),
                from: TelegramNativeUser(id: 20, is_bot: false, first_name: "Yes"), text: "/sks status {}"
            ))
        ]
    }
    func sendMessage(token: String, chatID: Int64, text: String) async throws { replies.append("\(chatID):\(text)") }
    func state() -> ([Int64], [String]) { (offsets, replies) }
}

private actor TelegramSmokeGateway: TelegramTypedCommandGateway {
    var executions = 0
    func prepare(_ request: TelegramTypedCommandRequest) async -> TelegramTypedCommandDecision {
        TelegramTypedCommandDecision(allowed: request.name == "status", confirmationRequired: false, publicError: nil)
    }
    func execute(_ request: TelegramTypedCommandRequest) async throws -> String {
        executions += 1
        return "ok"
    }
    func count() -> Int { executions }
}

@main
private enum TelegramRuntimeSmokeTests {
    static func main() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sks-telegram-smoke-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        try verifyPrivateFileStore(in: directory)
        let api = TelegramSmokeAPI()
        let gateway = TelegramSmokeGateway()
        let receiptURL = directory.appendingPathComponent("liveness.json")
        let runtime = TelegramMenuBarRuntime(
            api: api, access: TelegramSmokeAccess(), gateway: gateway,
            receiptURL: receiptURL, audit: { _ in }
        )
        let service = TelegramMenuBarService(runtime: runtime)
        _ = try await service.start().value
        do {
            _ = try await runtime.start()
            fatalError("duplicate poller start was accepted")
        } catch { }
        try await Task.sleep(nanoseconds: 100_000_000)
        precondition(service.stopAndWait(timeout: 2), "bounded menu-bar stop timed out")
        let receipt = TelegramLivenessWriter(url: receiptURL).read()
        let executionCount = await gateway.count()
        precondition(receipt?.poller.offset == 6)
        precondition(receipt?.running == false)
        precondition(receipt?.getme_checked_at != nil)
        precondition(receipt?.getme_latency_ms != nil)
        precondition(receipt?.audit_healthy == true)
        precondition(executionCount == 1)
        let (_, replies) = await api.state()
        precondition(replies == ["10:ok"], "unauthorized chat received a response")
        let auditURL = directory.appendingPathComponent("audit.jsonl")
        let ledger = TelegramAuditLedger(url: auditURL, maximumBytes: 64 * 1024)
        try ledger.record(TelegramNativeAuditEvent(
            actor: "chat:redacted", action: "unauthorized_chat", command: nil,
            outcome: "denied", detail: nil
        ))
        let audit = try String(contentsOf: auditURL, encoding: .utf8)
        let mode = try FileManager.default.attributesOfItem(atPath: auditURL.path)[.posixPermissions] as? NSNumber
        precondition(mode?.intValue == 0o600)
        precondition(audit.contains("chat:redacted") && !audit.contains("123456:abcdefghijklmnopqrstuvwxyzABCDE"))

        let firstActor = telegramRedactedActor(chatID: 10, senderID: 20)
        let secondActor = telegramRedactedActor(chatID: 10, senderID: 21)
        precondition(firstActor.hasPrefix("actor:") && firstActor != secondActor)
        precondition(firstActor != "10:20")

        let failedAuditReceiptURL = directory.appendingPathComponent("audit-failure-liveness.json")
        let failedAuditRuntime = TelegramMenuBarRuntime(
            api: TelegramSmokeAPI(), access: TelegramSmokeAccess(), gateway: TelegramSmokeGateway(),
            receiptURL: failedAuditReceiptURL,
            audit: { _ in throw TelegramSmokeError.auditUnavailable }
        )
        do {
            _ = try await failedAuditRuntime.start()
            fatalError("poller started without a writable audit ledger")
        } catch TelegramTransportError.auditUnavailable { }
        let failedAuditReceipt = TelegramLivenessWriter(url: failedAuditReceiptURL).read()
        precondition(failedAuditReceipt?.running == false)
        precondition(failedAuditReceipt?.poller.running == false)
        precondition(failedAuditReceipt?.audit_healthy == false)
        precondition(failedAuditReceipt?.audit_last_error == "telegram_audit_unavailable")
        precondition(telegramSelfHealAction(failedAuditReceipt!) == .operatorRepairAudit)
        print("telegram swift runtime smoke: ok")
    }

    private static func verifyPrivateFileStore(in directory: URL) throws {
        let home = directory.appendingPathComponent("home", isDirectory: true)
        let sks = home.appendingPathComponent(".sneakoscope", isDirectory: true)
        let secrets = sks.appendingPathComponent("secrets", isDirectory: true)
        let stateDirectory = sks.appendingPathComponent("state", isDirectory: true)
        let tokenURL = secrets.appendingPathComponent("telegram-bot-token")
        let stateURL = stateDirectory.appendingPathComponent("telegram.json")
        for privateDirectory in [home, sks, secrets, stateDirectory] {
            try FileManager.default.createDirectory(
                at: privateDirectory,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700]
            )
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: privateDirectory.path)
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: sks.path)

        let fileToken = "11111:abcdefghijklmnopqrstuvwxyzAB"
        try Data("\(fileToken)\n".utf8).write(to: tokenURL)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tokenURL.path)
        let primaryToken = "22222:abcdefghijklmnopqrstuvwxyzCD"
        let secondaryToken = "33333:abcdefghijklmnopqrstuvwxyzEF"
        let primary = TelegramPrivateFileStore(
            homeDirectory: home,
            environment: [
                "TELEGRAM_BOT_TOKEN": primaryToken,
                "SKS_TELEGRAM_BOT_TOKEN": secondaryToken
            ]
        )
        let resolvedPrimaryToken = try primary.loadToken()
        precondition(resolvedPrimaryToken == primaryToken, "primary token environment precedence failed")
        let secondary = TelegramPrivateFileStore(
            homeDirectory: home,
            environment: [
                "TELEGRAM_BOT_TOKEN": "  ",
                "SKS_TELEGRAM_BOT_TOKEN": secondaryToken
            ]
        )
        let resolvedSecondaryToken = try secondary.loadToken()
        precondition(resolvedSecondaryToken == secondaryToken, "secondary token environment fallback failed")
        let fixedNow = Date(timeIntervalSince1970: 1_800_000_000)
        let store = TelegramPrivateFileStore(
            homeDirectory: home,
            environment: [:],
            now: { fixedNow }
        )
        let resolvedFileToken = try store.loadToken()
        precondition(resolvedFileToken == fileToken, "private token file fallback failed")

        let configuredRoot = directory.appendingPathComponent("configured-sks-home", isDirectory: true)
        let configuredSecrets = configuredRoot.appendingPathComponent("secrets", isDirectory: true)
        try FileManager.default.createDirectory(
            at: configuredRoot,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o755]
        )
        try FileManager.default.createDirectory(
            at: configuredSecrets,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: configuredRoot.path)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: configuredSecrets.path)
        let configuredTokenURL = configuredSecrets.appendingPathComponent("telegram-bot-token")
        try Data("\(secondaryToken)\n".utf8).write(to: configuredTokenURL)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configuredTokenURL.path)
        let configured = TelegramPrivateFileStore(environment: ["SKS_HOME": configuredRoot.path])
        let configuredToken = try configured.loadToken()
        precondition(configuredToken == secondaryToken, "SKS_HOME root was not honored")
        let factoryEquivalent = TelegramPrivateFileStore(
            homeDirectory: home,
            environment: ["SKS_HOME": configuredRoot.path]
        )
        let factoryEquivalentToken = try factoryEquivalent.loadToken()
        precondition(
            factoryEquivalentToken == secondaryToken,
            "SKS_HOME root was ignored when the runtime factory supplied HOME"
        )

        let stateFixture = #"{"schema":"sks.telegram-state.v1","pairing":{"schema":"sks.telegram-pairing.v1","code":"123456-ABCD","expires_at":"2030-01-01T00:00:00.000Z","used":false,"future_pairing":"kept"},"chats":[],"confirmations":[],"future_root":{"kept":true}}"#
        try Data("\(stateFixture)\n".utf8).write(to: stateURL)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stateURL.path)
        let paired = try store.consumePairing(code: "123456-ABCD", chatID: 10, senderID: 20, chatType: "private")
        precondition(paired, "pairing consume failed")
        let authorized = try store.isAuthorized(chatID: 10, senderID: 20)
        precondition(authorized, "paired chat was not persisted")
        let reusedPairing = try store.consumePairing(code: "123456-ABCD", chatID: 11, senderID: 21, chatType: "private")
        precondition(!reusedPairing, "pairing code was reusable")

        let request = TelegramTypedCommandRequest(name: "gates", inputJSON: #"{"target":"affected"}"#)
        let nonce = try store.issueConfirmation(
            chatID: 10,
            senderID: 20,
            request: request,
            expiresAt: fixedNow.addingTimeInterval(120)
        )
        let reopened = TelegramPrivateFileStore(homeDirectory: home, environment: [:], now: { fixedNow })
        let wrongActor = try reopened.consumeConfirmation(nonce: nonce, chatID: 10, senderID: 21)
        precondition(wrongActor == nil, "confirmation was not actor-bound")
        let consumed = try reopened.consumeConfirmation(nonce: nonce, chatID: 10, senderID: 20)
        precondition(consumed?.request == request, "persisted confirmation did not round-trip")
        let reusedConfirmation = try reopened.consumeConfirmation(nonce: nonce, chatID: 10, senderID: 20)
        precondition(reusedConfirmation == nil, "confirmation was reusable")

        let rawState = try Data(contentsOf: stateURL)
        let root = try JSONSerialization.jsonObject(with: rawState) as? [String: Any]
        let pairing = root?["pairing"] as? [String: Any]
        let chats = root?["chats"] as? [[String: Any]]
        let confirmations = root?["confirmations"] as? [[String: Any]]
        precondition(root?["schema"] as? String == "sks.telegram-state.v1")
        precondition(pairing?["schema"] as? String == "sks.telegram-pairing.v1")
        precondition(pairing?["used"] as? Bool == true)
        precondition(pairing?["future_pairing"] as? String == "kept")
        precondition((root?["future_root"] as? [String: Any])?["kept"] as? Bool == true)
        precondition(chats?.count == 1 && confirmations?.isEmpty == true)
        let stateMode = try FileManager.default.attributesOfItem(atPath: stateURL.path)[.posixPermissions] as? NSNumber
        precondition(stateMode?.intValue == 0o600, "state mode was not 0600")
        let sksMode = try FileManager.default.attributesOfItem(atPath: sks.path)[.posixPermissions] as? NSNumber
        precondition(sksMode?.intValue == 0o755, "shared SKS root mode was mutated")
        for privateDirectory in [secrets, stateDirectory] {
            let mode = try FileManager.default.attributesOfItem(atPath: privateDirectory.path)[.posixPermissions] as? NSNumber
            precondition(mode?.intValue == 0o700, "private directory mode was not 0700")
        }

        let decoy = home.appendingPathComponent("decoy-token")
        try Data("\(fileToken)\n".utf8).write(to: decoy)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: decoy.path)
        try FileManager.default.removeItem(at: tokenURL)
        try FileManager.default.createSymbolicLink(at: tokenURL, withDestinationURL: decoy)
        do {
            _ = try store.loadToken()
            preconditionFailure("token symlink was accepted")
        } catch TelegramPrivateFileError.insecurePath { }
    }
}
#endif
