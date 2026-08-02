#if TELEGRAM_STANDALONE_TEST
import Darwin
import Foundation

private enum TelegramSmokeError: Error { case auditUnavailable }

private final class TelegramSmokeAccess: TelegramAccessStoring, @unchecked Sendable {
    private var botID: Int64? = 1
    private var pollOffset: Int64 = 0
    var resolvedToken = "123456:abcdefghijklmnopqrstuvwxyzABCDE"
    func resolveToken() throws -> TelegramResolvedAccessToken {
        TelegramResolvedAccessToken(
            token: resolvedToken,
            source: .userSecretFile
        )
    }
    func bindBotIdentity(_ botID: Int64) throws -> TelegramBotBinding {
        let previous = self.botID
        let reset = previous != botID
        if reset { pollOffset = 0 }
        self.botID = botID
        return TelegramBotBinding(
            botID: botID, previousBotID: previous,
            pollOffset: pollOffset, stateReset: reset
        )
    }
    func persistPollOffset(_ offset: Int64, botID: Int64) throws {
        guard self.botID == botID else { throw TelegramPrivateFileError.invalidStoredValue }
        pollOffset = offset
    }
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

private actor TelegramDelayedSmokeAPI: TelegramBotAPI {
    private var pending: [CheckedContinuation<TelegramNativeUser, Error>] = []
    private var identityTokens: [String] = []
    private var updateTokens: [String] = []

    func getMe(token: String) async throws -> TelegramNativeUser {
        identityTokens.append(token)
        return try await withCheckedThrowingContinuation { pending.append($0) }
    }

    func getUpdates(token: String, offset: Int64, timeoutSeconds: Int) async throws -> [TelegramNativeUpdate] {
        updateTokens.append(token)
        try await Task.sleep(nanoseconds: 10_000_000)
        return []
    }

    func sendMessage(token: String, chatID: Int64, text: String) async throws { }
    func waitForIdentityCalls(_ count: Int) async {
        while pending.count < count { await Task.yield() }
    }
    func resolveIdentity(at index: Int, botID: Int64) {
        pending.remove(at: index).resume(returning: TelegramNativeUser(id: botID, is_bot: true, first_name: "SKS"))
    }
    func observedIdentityTokens() -> [String] { identityTokens }
    func observedUpdateTokens() -> [String] { updateTokens }
}

private actor TelegramSmokeAPI: TelegramBotAPI {
    var first = true
    var offsets: [Int64] = []
    var replies: [String] = []
    var identityResults: [Bool] = []
    var events: [String] = []
    func getMe(token: String) async throws -> TelegramNativeUser {
        events.append("getMe")
        if !identityResults.isEmpty, !identityResults.removeFirst() {
            throw TelegramTransportError.apiFailure(503, "identity_unavailable")
        }
        return TelegramNativeUser(id: 1, is_bot: true, first_name: "SKS")
    }
    func getUpdates(token: String, offset: Int64, timeoutSeconds: Int) async throws -> [TelegramNativeUpdate] {
        events.append("getUpdates")
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
    func enqueueIdentityResults(_ results: [Bool]) { identityResults.append(contentsOf: results) }
    func eventLog() -> [String] { events }
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

        let refreshAPI = TelegramSmokeAPI()
        await refreshAPI.enqueueIdentityResults([true, false, true])
        let refreshRuntime = TelegramMenuBarRuntime(
            api: refreshAPI, access: TelegramSmokeAccess(), gateway: TelegramSmokeGateway(),
            receiptURL: directory.appendingPathComponent("identity-refresh-liveness.json"),
            identityRefreshIntervalSeconds: 0, audit: { _ in }
        )
        _ = try await refreshRuntime.start()
        for _ in 0..<40 {
            if await refreshAPI.eventLog().contains("getUpdates") { break }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        await refreshRuntime.stop()
        let refreshEvents = await refreshAPI.eventLog()
        guard let firstPoll = refreshEvents.firstIndex(of: "getUpdates") else {
            fatalError("polling did not resume after identity recovery")
        }
        precondition(
            Array(refreshEvents[..<firstPoll]) == ["getMe", "getMe", "getMe"],
            "polling resumed before failed identity refresh was revalidated"
        )

        let raceAPI = TelegramDelayedSmokeAPI()
        let raceAccess = TelegramSmokeAccess()
        let raceRuntime = TelegramMenuBarRuntime(
            api: raceAPI, access: raceAccess, gateway: TelegramSmokeGateway(),
            receiptURL: directory.appendingPathComponent("start-race-liveness.json"), audit: { _ in }
        )
        let firstStart = Task { try await raceRuntime.start() }
        await raceAPI.waitForIdentityCalls(1)
        await raceRuntime.stop()
        let stoppedRaceReceipt = await raceRuntime.liveness()
        precondition(!stoppedRaceReceipt.running, "Stop lost to pending startup")
        raceAccess.resolvedToken = "222222:abcdefghijklmnopqrstuvwxyzABCDE"
        let restarted = Task { try await raceRuntime.restart() }
        await raceAPI.waitForIdentityCalls(2)
        await raceAPI.resolveIdentity(at: 1, botID: 2)
        let restartedReceipt = try await restarted.value
        precondition(restartedReceipt.running && restartedReceipt.bot_id == 2)
        await raceAPI.resolveIdentity(at: 0, botID: 1)
        do {
            _ = try await firstStart.value
            fatalError("superseded startup committed after Stop/Restart")
        } catch TelegramTransportError.apiFailure(nil, "telegram_poller_start_cancelled") { }
        try await Task.sleep(nanoseconds: 30_000_000)
        let raceReceipt = await raceRuntime.liveness()
        let identityTokens = await raceAPI.observedIdentityTokens()
        let updateTokens = await raceAPI.observedUpdateTokens()
        precondition(raceReceipt.running && raceReceipt.bot_id == 2)
        precondition(identityTokens == [
            "123456:abcdefghijklmnopqrstuvwxyzABCDE",
            "222222:abcdefghijklmnopqrstuvwxyzABCDE"
        ])
        precondition(!updateTokens.isEmpty && updateTokens.allSatisfy {
            $0 == "222222:abcdefghijklmnopqrstuvwxyzABCDE"
        })
        await raceRuntime.stop()
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
        let primarySource = try primary.resolveToken().source
        precondition(primarySource == .environment, "environment token source was not reported")
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
        let fileSource = try store.resolveToken().source
        precondition(fileSource == .userSecretFile, "file token source was not reported")

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
        let invalidChat = try store.consumePairing(code: "123456-ABCD", chatID: 0, senderID: 20, chatType: "private")
        precondition(!invalidChat, "non-positive private chat ID was accepted")
        let invalidSender = try store.consumePairing(code: "123456-ABCD", chatID: 10, senderID: -1, chatType: "private")
        precondition(!invalidSender, "non-positive private sender ID was accepted")
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
        precondition(root?["bot_id"] is NSNull)
        precondition((root?["poll_offset"] as? NSNumber)?.int64Value == 0)
        let stateMode = try FileManager.default.attributesOfItem(atPath: stateURL.path)[.posixPermissions] as? NSNumber
        precondition(stateMode?.intValue == 0o600, "state mode was not 0600")
        let sksMode = try FileManager.default.attributesOfItem(atPath: sks.path)[.posixPermissions] as? NSNumber
        precondition(sksMode?.intValue == 0o755, "shared SKS root mode was mutated")
        for privateDirectory in [secrets, stateDirectory] {
            let mode = try FileManager.default.attributesOfItem(atPath: privateDirectory.path)[.posixPermissions] as? NSNumber
            precondition(mode?.intValue == 0o700, "private directory mode was not 0700")
        }

        let multiChatFixture = #"{"schema":"sks.telegram-state.v1","bot_id":101,"poll_offset":44,"pairing":{"schema":"sks.telegram-pairing.v1","code":"654321-DCBA","expires_at":"2030-01-01T00:00:00.000Z","used":false},"chats":[{"chat_id":10,"sender_id":20,"paired_at":"2026-01-01T00:00:00.000Z"},{"chat_id":11,"sender_id":21,"paired_at":"2026-01-01T00:00:00.000Z"}],"confirmations":[{"nonce":"old","chat_id":10,"sender_id":20,"command":"status","input_json":"{}","expires_at":"2030-01-01T00:00:00.000Z"}]}"#
        try Data("\(multiChatFixture)\n".utf8).write(to: stateURL)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stateURL.path)
        let recovered = try store.bindBotIdentity(101)
        precondition(recovered.stateReset && recovered.pollOffset == 0, "multi-chat state was not reset before polling")
        try store.persistPollOffset(9, botID: 101)
        let resumed = try store.bindBotIdentity(101)
        precondition(!resumed.stateReset && resumed.pollOffset == 9, "bot-bound poll offset did not resume")
        let rotated = try store.bindBotIdentity(202)
        precondition(rotated.stateReset && rotated.pollOffset == 0, "rotated bot reused prior poll state")

        let replacementFixture = #"{"schema":"sks.telegram-state.v1","bot_id":202,"poll_offset":0,"pairing":{"schema":"sks.telegram-pairing.v1","code":"999999-AAAA","expires_at":"2030-01-01T00:00:00.000Z","used":false},"chats":[{"chat_id":50,"sender_id":60,"paired_at":"2026-01-01T00:00:00.000Z"}],"confirmations":[{"nonce":"stale","chat_id":50,"sender_id":60,"command":"status","input_json":"{}","expires_at":"2030-01-01T00:00:00.000Z"}]}"#
        try Data("\(replacementFixture)\n".utf8).write(to: stateURL)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stateURL.path)
        let replacementPaired = try store.consumePairing(
            code: "999999-AAAA", chatID: 70, senderID: 80, chatType: "private"
        )
        precondition(replacementPaired)
        let replacementData = try Data(contentsOf: stateURL)
        let replacement = try JSONSerialization.jsonObject(with: replacementData) as? [String: Any]
        let replacementChats = replacement?["chats"] as? [[String: Any]]
        precondition(replacementChats?.count == 1)
        precondition((replacementChats?.first?["chat_id"] as? NSNumber)?.int64Value == 70)
        precondition((replacement?["confirmations"] as? [[String: Any]])?.isEmpty == true)

        let stateLockURL = stateDirectory.appendingPathComponent(".telegram.lock")
        try writeStateLockFixture(
            at: stateLockURL,
            pid: Int32.max,
            token: "22222222-2222-4222-8222-222222222222"
        )
        _ = try store.bindBotIdentity(202)
        precondition(!FileManager.default.fileExists(atPath: stateLockURL.path), "dead state lock was not recovered")

        try writeStateLockFixture(
            at: stateLockURL,
            pid: getpid(),
            token: "11111111-1111-4111-8111-111111111111"
        )
        do {
            _ = try store.bindBotIdentity(202)
            preconditionFailure("live same-process state lock was reaped")
        } catch TelegramPrivateFileError.systemCall(let operation, let code) {
            precondition(operation == "lock_timeout" && code == EBUSY, "live lock did not fail closed")
        }
        precondition(FileManager.default.fileExists(atPath: stateLockURL.path), "live lock was removed")
        try FileManager.default.removeItem(at: stateLockURL)

        try writeStateLockFixture(
            at: stateLockURL,
            pid: Int32.max,
            token: "33333333-3333-4333-8333-333333333333",
            mode: 0o644
        )
        do {
            _ = try store.bindBotIdentity(202)
            preconditionFailure("insecure-mode state lock was accepted")
        } catch TelegramPrivateFileError.insecurePath { }
        let unsafeMode = try FileManager.default.attributesOfItem(atPath: stateLockURL.path)[.posixPermissions] as? NSNumber
        precondition(unsafeMode?.intValue == 0o644, "unsafe lock was replaced")
        try FileManager.default.removeItem(at: stateLockURL)

        try Data("{}\n".utf8).write(to: stateLockURL)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stateLockURL.path)
        do {
            _ = try store.bindBotIdentity(202)
            preconditionFailure("malformed state lock owner was accepted")
        } catch TelegramPrivateFileError.invalidStoredValue { }
        precondition(FileManager.default.fileExists(atPath: stateLockURL.path), "malformed lock was replaced")
        try FileManager.default.removeItem(at: stateLockURL)

        let lockDecoy = home.appendingPathComponent("state-lock-decoy")
        try Data("{}\n".utf8).write(to: lockDecoy)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: lockDecoy.path)
        try FileManager.default.createSymbolicLink(at: stateLockURL, withDestinationURL: lockDecoy)
        do {
            _ = try store.bindBotIdentity(202)
            preconditionFailure("state lock symlink was accepted")
        } catch TelegramPrivateFileError.insecurePath { }
        let lockValues = try stateLockURL.resourceValues(forKeys: [.isSymbolicLinkKey])
        precondition(lockValues.isSymbolicLink == true, "state lock symlink was replaced")
        try FileManager.default.removeItem(at: stateLockURL)

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

    private static func writeStateLockFixture(
        at url: URL,
        pid: pid_t,
        token: String,
        mode: NSNumber = 0o600
    ) throws {
        var data = try JSONSerialization.data(
            withJSONObject: ["schema": "sks.telegram-lock.v1", "pid": pid, "token": token],
            options: [.sortedKeys]
        )
        data.append(0x0A)
        try data.write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: url.path)
    }
}
#endif
