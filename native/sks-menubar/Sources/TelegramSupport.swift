import Foundation

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
