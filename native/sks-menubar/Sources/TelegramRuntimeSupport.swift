import Darwin
import Foundation

enum TelegramSelfHealAction: String, Sendable {
    case restartPoll = "restart_poll"
    case revalidateToken = "revalidate_token"
    case operatorRemoveWebhook = "operator_remove_webhook"
    case operatorRepairAudit = "operator_repair_audit"
    case none
}

func telegramSelfHealAction(_ receipt: TelegramLivenessReceipt) -> TelegramSelfHealAction {
    if receipt.audit_healthy == false { return .operatorRepairAudit }
    if !receipt.token_configured || !receipt.bot_identity_valid { return .revalidateToken }
    if receipt.poller.last_error?.range(of: "409|webhook", options: .regularExpression) != nil {
        return .operatorRemoveWebhook
    }
    if !receipt.running || !receipt.poller.running || receipt.poller.consecutive_failures > 0 { return .restartPoll }
    return .none
}

final class TelegramLivenessWriter: @unchecked Sendable {
    let url: URL
    init(url: URL) { self.url = url }

    func read() -> TelegramLivenessReceipt? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let kind = attributes[.type] as? FileAttributeType, kind == .typeRegular,
              let owner = attributes[.ownerAccountID] as? NSNumber, owner.uint32Value == getuid(),
              let permissions = attributes[.posixPermissions] as? NSNumber,
              permissions.intValue & 0o077 == 0,
              let data = try? Data(contentsOf: url), data.count <= 64 * 1024 else { return nil }
        return try? JSONDecoder().decode(TelegramLivenessReceipt.self, from: data)
    }

    func write(_ receipt: TelegramLivenessReceipt) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let temporary = directory.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        let data = try JSONEncoder().encode(receipt)
        try data.write(to: temporary, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        do {
            _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary)
        } catch CocoaError.fileNoSuchFile {
            try FileManager.default.moveItem(at: temporary, to: url)
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            throw error
        }
    }
}
