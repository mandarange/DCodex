import Foundation

struct TelegramStoredConfirmation: Sendable, Equatable {
    let request: TelegramTypedCommandRequest
}

protocol TelegramAccessStoring: Sendable {
    func loadToken() throws -> String?
    func consumePairing(code: String, chatID: Int64, senderID: Int64, chatType: String) throws -> Bool
    func isAuthorized(chatID: Int64, senderID: Int64) throws -> Bool
    func authorizedCount() throws -> Int
    func issueConfirmation(
        chatID: Int64,
        senderID: Int64,
        request: TelegramTypedCommandRequest,
        expiresAt: Date
    ) throws -> String
    func consumeConfirmation(nonce: String, chatID: Int64, senderID: Int64) throws -> TelegramStoredConfirmation?
}

final class TelegramPrivateFileStore: TelegramAccessStoring, @unchecked Sendable {
    static let stateSchema = "sks.telegram-state.v1"
    static let pairingSchema = "sks.telegram-pairing.v1"
    static let tokenEnvironmentNames = ["TELEGRAM_BOT_TOKEN", "SKS_TELEGRAM_BOT_TOKEN"]

    private struct PairingState {
        let schema: String
        let code: String
        let expiresAt: String
        var used: Bool
        var raw: [String: Any]
    }

    private struct AuthorizedChat {
        let chatID: Int64
        let senderID: Int64
        let pairedAt: String
        var raw: [String: Any]
    }

    private struct ConfirmationState {
        let nonce: String
        let chatID: Int64
        let senderID: Int64
        let command: String
        let inputJSON: String
        let expiresAt: String
        var raw: [String: Any]
    }

    private struct State {
        let schema: String
        var pairing: PairingState?
        var chats: [AuthorizedChat]
        var confirmations: [ConfirmationState]
        var raw: [String: Any]

        init(
            schema: String = TelegramPrivateFileStore.stateSchema,
            pairing: PairingState? = nil,
            chats: [AuthorizedChat] = [],
            confirmations: [ConfirmationState] = [],
            raw: [String: Any] = [:]
        ) {
            self.schema = schema
            self.pairing = pairing
            self.chats = chats
            self.confirmations = confirmations
            self.raw = raw
        }
    }

    private let environment: [String: String]
    private let files: TelegramPrivateFileSupport
    private let now: @Sendable () -> Date

    init(
        homeDirectory: URL? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.environment = environment
        self.files = TelegramPrivateFileSupport(homeDirectory: homeDirectory, environment: environment)
        self.now = now
    }

    func loadToken() throws -> String? {
        for name in Self.tokenEnvironmentNames {
            let value = (environment[name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { return try validatedToken(value) }
        }
        guard let data = try files.readTokenData() else { return nil }
        guard let value = String(data: data, encoding: .utf8) else {
            throw TelegramPrivateFileError.invalidStoredValue
        }
        return try validatedToken(value.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    func consumePairing(code: String, chatID: Int64, senderID: Int64, chatType: String) throws -> Bool {
        guard chatType == "private" else { return false }
        return try files.withStateTransaction {
            var state = try loadStateUnlocked()
            guard var pairing = state.pairing,
                  pairing.code == code,
                  !pairing.used,
                  let expiration = parseTelegramDate(pairing.expiresAt),
                  expiration > now() else { return false }
            pairing.used = true
            state.pairing = pairing
            state.chats.removeAll { $0.chatID == chatID }
            state.chats.append(AuthorizedChat(
                chatID: chatID,
                senderID: senderID,
                pairedAt: telegramPrivateStoreDate(now()),
                raw: [:]
            ))
            try writeStateUnlocked(state)
            return true
        }
    }

    func isAuthorized(chatID: Int64, senderID: Int64) throws -> Bool {
        try files.withStateTransaction {
            try loadStateUnlocked().chats.contains { $0.chatID == chatID && $0.senderID == senderID }
        }
    }

    func authorizedCount() throws -> Int {
        try files.withStateTransaction { try loadStateUnlocked().chats.count }
    }

    func issueConfirmation(
        chatID: Int64,
        senderID: Int64,
        request: TelegramTypedCommandRequest,
        expiresAt: Date
    ) throws -> String {
        try files.withStateTransaction {
            var state = try loadStateUnlocked()
            removeExpiredConfirmations(from: &state)
            guard state.confirmations.count < 64 else {
                throw TelegramPrivateFileError.tooManyConfirmations
            }
            let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "")
            state.confirmations.append(ConfirmationState(
                nonce: nonce,
                chatID: chatID,
                senderID: senderID,
                command: request.name,
                inputJSON: request.inputJSON,
                expiresAt: telegramPrivateStoreDate(expiresAt),
                raw: [:]
            ))
            try writeStateUnlocked(state)
            return nonce
        }
    }

    func consumeConfirmation(nonce: String, chatID: Int64, senderID: Int64) throws -> TelegramStoredConfirmation? {
        try files.withStateTransaction {
            var state = try loadStateUnlocked()
            let countBeforeExpiration = state.confirmations.count
            removeExpiredConfirmations(from: &state)
            guard let index = state.confirmations.firstIndex(where: {
                $0.nonce == nonce && $0.chatID == chatID && $0.senderID == senderID
            }) else {
                if state.confirmations.count != countBeforeExpiration { try writeStateUnlocked(state) }
                return nil
            }
            let confirmation = state.confirmations.remove(at: index)
            try writeStateUnlocked(state)
            return TelegramStoredConfirmation(request: TelegramTypedCommandRequest(
                name: confirmation.command,
                inputJSON: confirmation.inputJSON
            ))
        }
    }

    private func validatedToken(_ value: String) throws -> String {
        guard value.range(
            of: #"^\d{5,20}:[A-Za-z0-9_-]{20,128}$"#,
            options: .regularExpression
        ) != nil else { throw TelegramPrivateFileError.invalidStoredValue }
        return value
    }

    private func removeExpiredConfirmations(from state: inout State) {
        let current = now()
        state.confirmations.removeAll {
            guard let expiration = parseTelegramDate($0.expiresAt) else { return true }
            return expiration <= current
        }
    }

    private func loadStateUnlocked() throws -> State {
        guard let data = try files.readStateData() else { return State() }
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              root["schema"] as? String == Self.stateSchema,
              root.keys.contains("pairing"),
              let chatRows = root["chats"] as? [[String: Any]],
              let confirmationRows = root["confirmations"] as? [[String: Any]] else {
            throw TelegramPrivateFileError.invalidStoredValue
        }
        let pairing: PairingState?
        if root["pairing"] is NSNull {
            pairing = nil
        } else if let row = root["pairing"] as? [String: Any] {
            pairing = try decodePairing(row)
        } else {
            throw TelegramPrivateFileError.invalidStoredValue
        }
        let chats = try chatRows.map(decodeChat)
        let confirmations = try confirmationRows.map(decodeConfirmation)
        return State(
            pairing: pairing,
            chats: chats,
            confirmations: confirmations,
            raw: root
        )
    }

    private func writeStateUnlocked(_ state: State) throws {
        var root = state.raw
        root["schema"] = Self.stateSchema
        root["pairing"] = state.pairing.map(encodePairing) ?? NSNull()
        root["chats"] = state.chats.map(encodeChat)
        root["confirmations"] = state.confirmations.map(encodeConfirmation)
        guard JSONSerialization.isValidJSONObject(root) else {
            throw TelegramPrivateFileError.invalidStoredValue
        }
        var data = try JSONSerialization.data(withJSONObject: root, options: [.sortedKeys])
        data.append(0x0A)
        try files.writeStateData(data)
    }

    private func decodePairing(_ row: [String: Any]) throws -> PairingState {
        guard let schema = row["schema"] as? String, schema == Self.pairingSchema,
              let code = row["code"] as? String,
              let expiresAt = row["expires_at"] as? String,
              let used = row["used"] as? Bool else {
            throw TelegramPrivateFileError.invalidStoredValue
        }
        return PairingState(schema: schema, code: code, expiresAt: expiresAt, used: used, raw: row)
    }

    private func decodeChat(_ row: [String: Any]) throws -> AuthorizedChat {
        guard let chatID = telegramInt64(row["chat_id"]),
              let senderID = telegramInt64(row["sender_id"]),
              let pairedAt = row["paired_at"] as? String else {
            throw TelegramPrivateFileError.invalidStoredValue
        }
        return AuthorizedChat(chatID: chatID, senderID: senderID, pairedAt: pairedAt, raw: row)
    }

    private func decodeConfirmation(_ row: [String: Any]) throws -> ConfirmationState {
        guard let nonce = row["nonce"] as? String,
              let chatID = telegramInt64(row["chat_id"]),
              let senderID = telegramInt64(row["sender_id"]),
              let command = row["command"] as? String,
              let inputJSON = row["input_json"] as? String,
              let expiresAt = row["expires_at"] as? String else {
            throw TelegramPrivateFileError.invalidStoredValue
        }
        return ConfirmationState(
            nonce: nonce,
            chatID: chatID,
            senderID: senderID,
            command: command,
            inputJSON: inputJSON,
            expiresAt: expiresAt,
            raw: row
        )
    }

    private func encodePairing(_ pairing: PairingState) -> [String: Any] {
        var row = pairing.raw
        row["schema"] = Self.pairingSchema
        row["code"] = pairing.code
        row["expires_at"] = pairing.expiresAt
        row["used"] = pairing.used
        return row
    }

    private func encodeChat(_ chat: AuthorizedChat) -> [String: Any] {
        var row = chat.raw
        row["chat_id"] = chat.chatID
        row["sender_id"] = chat.senderID
        row["paired_at"] = chat.pairedAt
        return row
    }

    private func encodeConfirmation(_ confirmation: ConfirmationState) -> [String: Any] {
        var row = confirmation.raw
        row["nonce"] = confirmation.nonce
        row["chat_id"] = confirmation.chatID
        row["sender_id"] = confirmation.senderID
        row["command"] = confirmation.command
        row["input_json"] = confirmation.inputJSON
        row["expires_at"] = confirmation.expiresAt
        return row
    }
}

private func telegramInt64(_ value: Any?) -> Int64? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    return Int64(number.stringValue)
}

private func parseTelegramDate(_ value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}

private func telegramPrivateStoreDate(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}
