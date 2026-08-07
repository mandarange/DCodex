import Cocoa

final class RemoteCodingSettingsControls {
    private static let tokenPattern = #"^\d{5,20}:[A-Za-z0-9_-]{20,128}$"#

    let selectedBotDetail = NativeView.detail("No bot is configured.")
    let pairingCommandField = NativeView.detail("Generate a code to create the /start pairing command.")
    let botTokenField: NSSecureTextField
    let setupButton: NSButton
    let copyPairingButton: NSButton

    private var pairingCommand: String?
    private var selectedBotID: Int64?
    private var selectedBotUsername: String?

    init(target: AnyObject, submitTokenAction: Selector, copyPairingAction: Selector) {
        let tokenField = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
        tokenField.placeholderString = "Paste the complete BotFather HTTP API token"
        tokenField.setContentHuggingPriority(.defaultLow, for: .horizontal)
        tokenField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        tokenField.setAccessibilityLabel("BotFather HTTP API token")
        tokenField.setAccessibilityHelp("Required. Paste the complete token for any Telegram bot you own. SKS clears this field before verification and never displays the token again.")
        tokenField.setAccessibilityIdentifier("sks-center-telegram-bot-token")
        tokenField.target = target
        tokenField.action = submitTokenAction
        botTokenField = tokenField

        setupButton = NativeView.button("Verify, Save & Apply", target: target, action: submitTokenAction)
        setupButton.setAccessibilityIdentifier("sks-center-telegram-verify-save-apply")
        setupButton.setAccessibilityHelp("Verify the entered bot token with Telegram, save it to the private SKS user secret file, and apply it to the resident poller.")

        copyPairingButton = NativeView.button("Copy Pairing Command", target: target, action: copyPairingAction)
        copyPairingButton.setAccessibilityHelp("Copy only the generated /start pairing command. The bot token is never copied or displayed.")

        pairingCommandField.isSelectable = true
        pairingCommandField.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        pairingCommandField.setAccessibilityLabel("Telegram pairing command")
        pairingCommandField.setAccessibilityIdentifier("sks-center-telegram-pairing-command")
        selectedBotDetail.isSelectable = true
        selectedBotDetail.setAccessibilityLabel("Selected Telegram bot")
        selectedBotDetail.setAccessibilityIdentifier("sks-center-telegram-selected-bot")
    }

    func configure(delegate: NSTextFieldDelegate) {
        botTokenField.delegate = delegate
    }

    func consumeTokenInput() -> String {
        let value = botTokenField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        botTokenField.stringValue = ""
        return value
    }

    func updateActionControls(operationInFlight: Bool, tokenConfigured: Bool, environmentOverride: Bool) {
        let hasTokenInput = !botTokenField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        botTokenField.isEnabled = !operationInFlight && !environmentOverride
        setupButton.title = tokenConfigured ? "Verify, Replace & Apply" : "Verify, Save & Apply"
        setupButton.setAccessibilityLabel(setupButton.title)
        setupButton.isEnabled = !operationInFlight && !environmentOverride && hasTokenInput
        copyPairingButton.isEnabled = !operationInFlight && pairingCommand != nil
    }

    func renderSelectedBot(
        botID: Int64?,
        username: String? = nil,
        configured: Bool,
        identityValid: Bool
    ) {
        guard configured else {
            selectedBotID = nil
            selectedBotUsername = nil
            selectedBotDetail.stringValue = "No bot is configured."
            selectedBotDetail.setAccessibilityValue(selectedBotDetail.stringValue)
            resetPairingCommand("Generate a code after connecting a bot.")
            return
        }
        let retainedUsername = username ?? (botID == selectedBotID ? selectedBotUsername : nil)
        selectedBotID = botID
        selectedBotUsername = retainedUsername
        if let botID, let retainedUsername, identityValid {
            selectedBotDetail.stringValue = "@\(retainedUsername) · Bot ID \(botID)"
        } else if let botID, identityValid {
            selectedBotDetail.stringValue = "Bot ID \(botID) · verified by Telegram"
        } else if let botID {
            selectedBotDetail.stringValue = "Bot ID \(botID) · identity needs verification"
        } else {
            selectedBotDetail.stringValue = "Configured bot · identity details unavailable"
        }
        selectedBotDetail.setAccessibilityValue(selectedBotDetail.stringValue)
    }

    func setPairingCode(_ code: String) {
        pairingCommand = "/start \(code)"
        pairingCommandField.stringValue = pairingCommand ?? ""
        pairingCommandField.setAccessibilityValue(pairingCommandField.stringValue)
    }

    func resetPairingCommand(_ detail: String) {
        pairingCommand = nil
        pairingCommandField.stringValue = detail
        pairingCommandField.setAccessibilityValue(detail)
    }

    @discardableResult
    func copyPairingCommand() -> Bool {
        guard let pairingCommand else { return false }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        return pasteboard.setString(pairingCommand, forType: .string)
    }

    static func validTokenShape(_ value: String) -> Bool {
        value.utf8.count <= 1024
            && value.range(of: tokenPattern, options: .regularExpression) != nil
    }

    static func publicFailure(_ output: String, fallback: String) -> String {
        guard let data = output.data(using: .utf8),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let error = row["error"] as? String else { return fallback }
        switch error {
        case "telegram_token_invalid", "telegram_token_stdin_empty":
            return "That value is not a complete BotFather HTTP API token."
        case "telegram_token_rejected":
            return "Telegram rejected this token. In @BotFather, select the bot you want SKS to use and copy that bot's current complete token."
        case "telegram_identity_verification_timeout":
            return "Telegram identity verification timed out. Check the network connection and try the selected bot token again."
        case "telegram_identity_verification_network_failed":
            return "Telegram identity verification could not reach the Bot API. Check the network connection and try again."
        case "telegram_identity_verification_failed":
            return "Telegram returned an invalid bot identity response. Try the selected bot's current token again."
        case let value where value.contains("401") || value.contains("Unauthorized"):
            return "Telegram rejected this token. Copy the current token from @BotFather and try again."
        case let value where value.contains("timeout") || value.contains("network"):
            return "Telegram identity verification could not complete. Check the network connection and try again."
        default:
            return fallback
        }
    }

    static func partialSetupRecovery(_ response: TelegramCenterSetupResponse?) -> String {
        var parts: [String] = []
        if response?.webhook_removed == true { parts.append("The existing webhook was removed without dropping pending updates.") }
        if response?.bot_state_reset == true { parts.append("Bot-scoped pairing and poll state were reset safely.") }
        if response?.token_stored == false { parts.append("The token was not stored; rerun secure setup to finish.") }
        if let note = response?.recovery?.note, !note.isEmpty { parts.append(note) }
        return parts.isEmpty
            ? "Review the secret-free recovery status, then rerun secure setup."
            : parts.joined(separator: " ")
    }

    static func tokenSourceDescription(_ source: String) -> String {
        switch source {
        case "env": return "operator environment token"
        case "user_secret_file": return "private token file"
        case "none": return "no token source"
        default: return "token source unknown"
        }
    }
}
