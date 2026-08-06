import Foundation

struct TelegramNativeUser: Codable, Sendable {
    let id: Int64
    let is_bot: Bool
    let first_name: String
}

struct TelegramNativeChat: Codable, Sendable {
    let id: Int64
    let type: String
}

struct TelegramNativeMessage: Codable, Sendable {
    let message_id: Int64
    let date: Int64
    let chat: TelegramNativeChat
    let from: TelegramNativeUser?
    let text: String?
}

struct TelegramNativeUpdate: Codable, Sendable {
    let update_id: Int64
    let message: TelegramNativeMessage?
}

struct TelegramTypedCommandRequest: Sendable, Equatable {
    let name: String
    let inputJSON: String
}

struct TelegramTypedCommandDecision: Sendable, Equatable {
    let allowed: Bool
    let confirmationRequired: Bool
    let publicError: String?
}

/// The AppDelegate adapter must delegate these calls to the TypeScript
/// createTelegramCommandDispatcher boundary. It must execute argv directly;
/// no shell command string is accepted by this protocol.
protocol TelegramTypedCommandGateway: Sendable {
    func prepare(_ request: TelegramTypedCommandRequest) async -> TelegramTypedCommandDecision
    func execute(_ request: TelegramTypedCommandRequest) async throws -> String
}

struct TelegramNativeAuditEvent: Sendable, Equatable {
    let actor: String
    let action: String
    let command: String?
    let outcome: String
    let detail: String?
}

struct TelegramPollerReceipt: Codable, Sendable, Equatable {
    let schema: String
    let running: Bool
    let offset: Int64
    let consecutive_failures: Int
    let last_poll_at: String?
    let last_success_at: String?
    let last_update_at: String?
    let last_error: String?

    private enum CodingKeys: String, CodingKey {
        case schema, running, offset, consecutive_failures
        case last_poll_at, last_success_at, last_update_at, last_error
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schema, forKey: .schema)
        try container.encode(running, forKey: .running)
        try container.encode(offset, forKey: .offset)
        try container.encode(consecutive_failures, forKey: .consecutive_failures)
        if let last_poll_at { try container.encode(last_poll_at, forKey: .last_poll_at) }
        else { try container.encodeNil(forKey: .last_poll_at) }
        if let last_success_at { try container.encode(last_success_at, forKey: .last_success_at) }
        else { try container.encodeNil(forKey: .last_success_at) }
        if let last_update_at { try container.encode(last_update_at, forKey: .last_update_at) }
        else { try container.encodeNil(forKey: .last_update_at) }
        if let last_error { try container.encode(last_error, forKey: .last_error) }
        else { try container.encodeNil(forKey: .last_error) }
    }
}

struct TelegramLivenessReceipt: Codable, Sendable, Equatable {
    let schema: String
    let generation: String
    let pid: Int32
    let running: Bool
    let token_configured: Bool
    let token_source: TelegramTokenSource
    let bot_id: Int64?
    let bot_identity_valid: Bool
    let getme_checked_at: String?
    let getme_latency_ms: Int?
    let paired_chat_count: Int
    let started_at: String
    let heartbeat_at: String
    let stale_after_seconds: Int
    let audit_healthy: Bool?
    let audit_last_error: String?
    let poller: TelegramPollerReceipt

    private enum CodingKeys: String, CodingKey {
        case schema, generation, pid, running, token_configured, token_source
        case bot_id, bot_identity_valid, getme_checked_at, getme_latency_ms
        case paired_chat_count, started_at, heartbeat_at, stale_after_seconds
        case audit_healthy, audit_last_error, poller
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schema, forKey: .schema)
        try container.encode(generation, forKey: .generation)
        try container.encode(pid, forKey: .pid)
        try container.encode(running, forKey: .running)
        try container.encode(token_configured, forKey: .token_configured)
        try container.encode(token_source, forKey: .token_source)
        if let bot_id { try container.encode(bot_id, forKey: .bot_id) }
        else { try container.encodeNil(forKey: .bot_id) }
        try container.encode(bot_identity_valid, forKey: .bot_identity_valid)
        if let getme_checked_at { try container.encode(getme_checked_at, forKey: .getme_checked_at) }
        else { try container.encodeNil(forKey: .getme_checked_at) }
        if let getme_latency_ms { try container.encode(getme_latency_ms, forKey: .getme_latency_ms) }
        else { try container.encodeNil(forKey: .getme_latency_ms) }
        try container.encode(paired_chat_count, forKey: .paired_chat_count)
        try container.encode(started_at, forKey: .started_at)
        try container.encode(heartbeat_at, forKey: .heartbeat_at)
        try container.encode(stale_after_seconds, forKey: .stale_after_seconds)
        if let audit_healthy { try container.encode(audit_healthy, forKey: .audit_healthy) }
        else { try container.encodeNil(forKey: .audit_healthy) }
        if let audit_last_error { try container.encode(audit_last_error, forKey: .audit_last_error) }
        else { try container.encodeNil(forKey: .audit_last_error) }
        try container.encode(poller, forKey: .poller)
    }
}

struct TelegramCenterSetupResponse: Decodable {
    struct Recovery: Decodable {
        let action: String?
        let note: String?
    }

    let ok: Bool
    let getme_verified: Bool?
    let token_stored: Bool?
    let error: String?
    let partial_success: Bool?
    let token_source: String?
    let storage_attempted: Bool?
    let webhook_removed: Bool?
    let pending_updates_dropped: Bool?
    let bot_state_reset: Bool?
    let bot_id: Int64?
    let bot_username: String?
    let operator_action: String?
    let recovery: Recovery?
}

struct TelegramCenterPairResponse: Decodable {
    let ok: Bool
    let code: String?
    let expires_at: String?
    let instruction: String?
    let post_pair_command: String?
    let confirmation_grammar: String?
    let error: String?
}

struct TelegramCenterDoctorResponse: Decodable {
    struct Poller: Decodable {
        let running: Bool
        let consecutive_failures: Int
        let last_error: String?
    }

    let ok: Bool
    let status: String
    let token_configured: Bool
    let token_source: String
    let bot_identity_valid: Bool
    let paired_chat_count: Int
    let audit_healthy: Bool
    let poller: Poller
    let blockers: [String]
    let self_heal_action: String?
}

func telegramCommandRequest(_ text: String) -> TelegramTypedCommandRequest? {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let pattern = #"^/sks\s+([a-z][a-z0-9-]{0,63})(?:\s+([\s\S]+))?$"#
    guard let expression = try? NSRegularExpression(pattern: pattern),
          let match = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
          let nameRange = Range(match.range(at: 1), in: text) else { return nil }
    let name = String(text[nameRange])
    guard match.range(at: 2).location != NSNotFound,
          let inputRange = Range(match.range(at: 2), in: text) else {
        return TelegramTypedCommandRequest(name: name, inputJSON: "{}")
    }
    let raw = String(text[inputRange])
    guard raw.utf8.count <= 16 * 1024,
          let data = raw.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data),
          object is [String: Any],
          let normalized = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let json = String(data: normalized, encoding: .utf8) else { return nil }
    return TelegramTypedCommandRequest(name: name, inputJSON: json)
}

func telegramPairingCode(text: String, chatType: String) -> String? {
    guard chatType == "private" else { return nil }
    return telegramFirstCapture(#"^/start\s+([A-Za-z0-9_-]{6,64})$"#, text)
}

func telegramConfirmationNonce(_ text: String) -> String? {
    telegramFirstCapture(#"^/confirm\s+([A-Za-z0-9_-]{16,64})$"#, text)
}

private func telegramFirstCapture(_ pattern: String, _ text: String) -> String? {
    guard let expression = try? NSRegularExpression(pattern: pattern),
          let match = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
          let range = Range(match.range(at: 1), in: text) else { return nil }
    return String(text[range])
}

func telegramISODate(_ date: Date = Date()) -> String {
    ISO8601DateFormatter().string(from: date)
}

func telegramPublicError(_ value: String?, secret: String? = nil) -> String {
    var raw = value ?? "telegram_error"
    if let secret, !secret.isEmpty { raw = raw.replacingOccurrences(of: secret, with: "[redacted]") }
    let botPattern = try? NSRegularExpression(pattern: #"/bot[^/\s]+/"#, options: [.caseInsensitive])
    let redacted = botPattern?.stringByReplacingMatches(in: raw, range: NSRange(raw.startIndex..., in: raw), withTemplate: "/bot[redacted]/") ?? raw
    return String(redacted.prefix(512))
}

func telegramRedactedActor(chatID: Int64, senderID: Int64) -> String {
    var hash: UInt64 = 1469598103934665603
    for byte in "\(chatID):\(senderID)".utf8 { hash = (hash ^ UInt64(byte)) &* 1099511628211 }
    return String(format: "actor:%012llx", hash & 0xffffffffffff)
}
