#if canImport(XCTest)
import Darwin
import Foundation

final class TelegramFakeAccess: TelegramAccessStoring, @unchecked Sendable {
    private struct Pending {
        let chatID: Int64
        let senderID: Int64
        let request: TelegramTypedCommandRequest
        let expiresAt: Date
    }

    var authorizedActors: Set<String> = []
    var pendingActors: Set<String> = []
    var pairedCode = "123456-ABCD"
    var botID: Int64? = 1
    var pollOffset: Int64 = 0
    var resolvedToken = "123456:abcdefghijklmnopqrstuvwxyzABCDE"
    private var confirmations: [String: Pending] = [:]

    func resolveToken() throws -> TelegramResolvedAccessToken {
        TelegramResolvedAccessToken(
            token: resolvedToken,
            source: .userSecretFile
        )
    }
    func bindBotIdentity(_ botID: Int64) throws -> TelegramBotBinding {
        let previous = self.botID
        let reset = previous != botID
        if reset {
            authorizedActors = []
            pendingActors = []
            confirmations = [:]
            pollOffset = 0
        }
        self.botID = botID
        return TelegramBotBinding(
            botID: botID,
            previousBotID: previous,
            pollOffset: pollOffset,
            stateReset: reset
        )
    }
    func persistPollOffset(_ offset: Int64, botID: Int64) throws {
        guard self.botID == botID else { throw TelegramPrivateFileError.invalidStoredValue }
        pollOffset = offset
    }
    func consumePairing(code: String, chatID: Int64, senderID: Int64, chatType: String) throws -> Bool {
        guard code == pairedCode, chatType == "private" else { return false }
        authorizedActors = ["\(chatID):\(senderID)"]
        confirmations = [:]
        pairedCode = ""
        return true
    }
    func stagePairing(code: String, chatID: Int64, senderID: Int64, chatType: String) throws -> Bool {
        guard code == pairedCode, chatType == "private" else { return false }
        authorizedActors = []
        pendingActors = ["\(chatID):\(senderID)"]
        confirmations = [:]
        pairedCode = ""
        return true
    }
    func activatePairing(chatID: Int64, senderID: Int64) throws -> Bool {
        let actor = "\(chatID):\(senderID)"
        guard pendingActors.remove(actor) != nil else { return false }
        authorizedActors = [actor]
        return true
    }
    func abandonPendingPairing(chatID: Int64, senderID: Int64) throws {
        pendingActors.remove("\(chatID):\(senderID)")
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

actor TelegramFakeAPI: TelegramBotAPI {
    var pending: [TelegramNativeUpdate] = []
    var offsets: [Int64] = []
    var sent: [(Int64, String)] = []
    var pollCalls = 0

    func getMe(token: String) async throws -> TelegramNativeUser {
        TelegramNativeUser(id: 1, is_bot: true, first_name: "SKS")
    }
    func getUpdates(token: String, offset: Int64, timeoutSeconds: Int) async throws -> [TelegramNativeUpdate] {
        pollCalls += 1
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
    func observedPollCalls() -> Int { pollCalls }
}

actor TelegramDelayedIdentityAPI: TelegramBotAPI {
    private struct PendingIdentity {
        let token: String
        let continuation: CheckedContinuation<TelegramNativeUser, Error>
    }

    private var pendingIdentities: [PendingIdentity] = []
    private var identityTokens: [String] = []
    private var updateTokens: [String] = []

    func getMe(token: String) async throws -> TelegramNativeUser {
        identityTokens.append(token)
        return try await withCheckedThrowingContinuation { continuation in
            pendingIdentities.append(PendingIdentity(token: token, continuation: continuation))
        }
    }

    func getUpdates(token: String, offset: Int64, timeoutSeconds: Int) async throws -> [TelegramNativeUpdate] {
        updateTokens.append(token)
        try await Task.sleep(nanoseconds: 10_000_000)
        return []
    }

    func sendMessage(token: String, chatID: Int64, text: String) async throws { }

    func waitForIdentityCalls(_ count: Int) async {
        while pendingIdentities.count < count { await Task.yield() }
    }

    func resolveIdentity(at index: Int, botID: Int64) {
        let pending = pendingIdentities.remove(at: index)
        pending.continuation.resume(returning: TelegramNativeUser(id: botID, is_bot: true, first_name: "SKS"))
    }

    func observedIdentityTokens() -> [String] { identityTokens }
    func observedUpdateTokens() -> [String] { updateTokens }
}

actor TelegramFakeGateway: TelegramTypedCommandGateway {
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
#endif
