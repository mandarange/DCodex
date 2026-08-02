import Cocoa

final class RemoteCodingViewController: NSViewController, ControlCenterPage {
    private static let botFatherURL = URL(string: "https://t.me/BotFather")!
    private static let tokenPattern = #"^\d{5,20}:[A-Za-z0-9_-]{20,128}$"#

    private let processClient: ProcessClient
    private let telegramService: TelegramMenuBarService
    private let serviceBadge = NativeView.badge("Checking Telegram service", color: .systemBlue)
    private let serviceDetail = NativeView.detail("Reading secret-free Telegram liveness status…")
    private let pairingDetail = NativeView.detail("No pairing code has been issued in this session.")
    private let serviceSpinner = NativeView.spinner(label: "Telegram operation in progress")
    private lazy var setupButton = NativeView.button("Enter Bot Token…", target: self, action: #selector(enterToken))
    private lazy var pairButton = NativeView.button("Generate Pairing Code", target: self, action: #selector(generatePairingCode))
    private lazy var startButton = NativeView.button("Start", target: self, action: #selector(startService))
    private lazy var stopButton = NativeView.button("Stop", target: self, action: #selector(stopService))
    private lazy var restartButton = NativeView.button("Restart", target: self, action: #selector(restartService))
    private lazy var refreshButton = NativeView.button("Refresh Status", target: self, action: #selector(refreshStatusAction))
    private var operationInFlight = false
    private var tokenConfigured = false
    private var pollerRunning = false

    init(processClient: ProcessClient, telegramService: TelegramMenuBarService) {
        self.processClient = processClient
        self.telegramService = telegramService
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func loadView() {
        let botFatherButton = NativeView.button("Open @BotFather", target: self, action: #selector(openBotFather))
        botFatherButton.setAccessibilityHelp("Open the official Telegram BotFather chat in your default handler.")
        setupButton.setAccessibilityHelp("Enter a BotFather token securely. The token is verified live and stored in the private SKS user secret file.")
        pairButton.setAccessibilityHelp("With Telegram polling running, issue a short-lived, single-use code for pairing one intended private chat.")
        startButton.setAccessibilityHelp("Start Telegram polling for the current SKS companion session after a bot token is configured.")
        stopButton.setAccessibilityHelp("Stop polling for the current companion session without deleting the token or paired chats. A companion relaunch starts it again.")
        restartButton.setAccessibilityHelp("Restart the single resident Telegram poller and revalidate the stored bot identity.")
        refreshButton.setAccessibilityHelp("Refresh secret-free bot, pairing, audit, and poller status.")
        pairingDetail.isSelectable = true
        pairingDetail.setAccessibilityLabel("Telegram pairing instructions")
        serviceDetail.setAccessibilityLabel("Telegram service status detail")

        let setupCard = NativeView.card(
            title: "Connect with BotFather",
            subtitle: "Create a Telegram bot, then let SKS validate and store its token privately.",
            views: [
                NativeView.detail(
                    "1. Open @BotFather and send /newbot.  2. Finish the bot name and username prompts.  " +
                    "3. Copy the HTTP API token BotFather returns.  4. Choose Enter Bot Token below."
                ),
                NativeView.detail(
                    "The token is sent only through process stdin to the canonical SKS setup command, verified with Telegram getMe, and stored in the private user secret file. It is never shown again or written to the SKS action log. Revoke it in BotFather if you suspect exposure."
                ),
                NativeView.row([botFatherButton, setupButton])
            ]
        )

        let pairingCard = NativeView.card(
            title: "Pair a Private Chat",
            subtitle: "Authorize only the intended Telegram account and private chat.",
            views: [
                NativeView.detail(
                    "With Telegram polling running, generate a short-lived code, open your new bot from the intended private chat, and send /start followed by that code. Codes are single-use; group chats are rejected. After pairing, try /sks status {}."
                ),
                pairingDetail,
                pairButton
            ]
        )

        let statusCard = NativeView.card(
            title: "Service Status",
            subtitle: "Control the single SKS-owned poller for this companion session and inspect secret-free health evidence.",
            views: [
                NativeView.row([serviceBadge, serviceSpinner]),
                serviceDetail,
                NativeView.row([startButton, stopButton, restartButton, refreshButton])
            ]
        )

        view = NativeView.page([
            NativeView.title("Telegram Remote Control"),
            NativeView.detail(
                "Connect SKS to a BotFather-created Telegram bot for paired, allowlisted remote commands with confirmation gates and a local audit trail."
            ),
            setupCard,
            pairingCard,
            statusCard
        ])
        updateControls()
    }

    func refreshOnAppear() { refreshStatus() }

    @objc private func openBotFather() {
        NSWorkspace.shared.open(Self.botFatherURL)
    }

    @objc private func enterToken() {
        if TelegramPrivateFileStore.operatorEnvironmentOverrideActive() {
            showAttention(
                "Environment-managed token is active",
                detail: "SKS is using an operator-managed Telegram token environment override. Remove TELEGRAM_BOT_TOKEN or SKS_TELEGRAM_BOT_TOKEN and relaunch the companion before storing a BotFather token file."
            )
            return
        }
        promptForToken(removeWebhook: false)
    }

    private func promptForToken(removeWebhook: Bool) {
        guard !operationInFlight, let window = view.window else { return }
        AlertFactory.textSheet(
            window: window,
            title: "Enter Telegram Bot Token",
            message: removeWebhook
                ? "Paste the BotFather token again. With your consent, SKS will remove this bot's existing webhook without dropping pending updates, verify the bot, and store the token privately."
                : "Paste the HTTP API token supplied by @BotFather. SKS will verify the bot identity before storing it privately.",
            secure: true,
            placeholder: "123456789:BotFatherToken",
            actionTitle: removeWebhook ? "Remove Webhook & Save" : "Verify & Save"
        ) { [weak self] token in
            guard let self, let token else { return }
            let normalizedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
            guard self.validTokenShape(normalizedToken) else {
                self.showAttention(
                    "Token not saved",
                    detail: "That value does not match the BotFather token format. Copy the complete HTTP API token and try again."
                )
                return
            }
            self.saveToken(normalizedToken, removeWebhook: removeWebhook)
        }
    }

    @objc private func generatePairingCode() {
        guard !operationInFlight else { return }
        beginOperation("Issuing a short-lived pairing code…")
        processClient.run(
            ["telegram", "pair", "--json"],
            environment: telegramSecretFreeEnvironment,
            timeout: NativeView.statusTimeout,
            logOutput: false
        ) { [weak self] result in
            guard let self else { return }
            self.endOperation()
            guard result.code == 0,
                  let response = self.decode(TelegramCenterPairResponse.self, result.output),
                  response.ok,
                  let code = response.code,
                  code.range(of: #"^\d{6}-[A-F0-9]{4}$"#, options: .regularExpression) != nil else {
                self.showAttention(
                    "Pairing code unavailable",
                    detail: self.publicFailure(result.output, fallback: "SKS could not create a pairing code. Refresh status and try again.")
                )
                return
            }
            let expiration = response.expires_at.map { " It expires at \($0)." } ?? ""
            let instruction = response.instruction
                ?? "Send /start \(code) to this bot from the intended private chat."
            let postPair = response.post_pair_command ?? "/sks status {}"
            let confirmation = response.confirmation_grammar ?? "/confirm <nonce>"
            let statusGuidance = instruction.contains(postPair) ? "" : " Then try \(postPair)."
            self.pairingDetail.stringValue = "\(instruction)\(expiration)\(statusGuidance) Confirm prompted actions with \(confirmation)."
            self.pairingDetail.setAccessibilityValue(self.pairingDetail.stringValue)
            self.showProgress("Pairing code ready", detail: "Use the displayed code once in the intended private chat.")
            self.refreshStatus(after: 1)
        }
    }

    @objc private func startService() { runLifecycle(.start) }
    @objc private func stopService() { runLifecycle(.stop) }
    @objc private func restartService() { runLifecycle(.restart) }
    @objc private func refreshStatusAction() { refreshStatus() }

    private enum LifecycleAction { case start, stop, restart }

    private func runLifecycle(_ action: LifecycleAction) {
        guard !operationInFlight else { return }
        let actionName: String
        switch action {
        case .start: actionName = "Starting"
        case .stop: actionName = "Stopping"
        case .restart: actionName = "Restarting"
        }
        beginOperation("\(actionName) Telegram polling…")

        switch action {
        case .stop:
            let task = telegramService.stop()
            Task { @MainActor [weak self] in
                await task.value
                self?.endOperation()
                self?.showProgress(
                    "Telegram polling stopped",
                    detail: "The token and paired chats were preserved. Relaunching the SKS companion starts polling again."
                )
                self?.refreshStatus(after: 0.2)
            }
        case .start, .restart:
            let task = action == .start ? telegramService.start() : telegramService.restart()
            Task { @MainActor [weak self] in
                do {
                    let receipt = try await task.value
                    self?.endOperation()
                    self?.render(receipt)
                } catch {
                    self?.endOperation()
                    self?.showAttention(
                        "Telegram polling did not start",
                        detail: "Refresh status for the verified blocker. Re-enter the BotFather token if identity validation failed."
                    )
                }
                self?.refreshStatus(after: 0.3)
            }
        }
    }

    private func saveToken(_ token: String, removeWebhook: Bool) {
        let normalizedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard validTokenShape(normalizedToken) else {
            showAttention(
                "Token not saved",
                detail: "That value does not match the BotFather token format. Copy the complete token and try again."
            )
            return
        }
        beginOperation("Verifying bot identity with Telegram…")
        var arguments = ["telegram", "setup", "--token-stdin", "--json"]
        if TelegramPrivateFileStore.operatorEnvironmentOverrideActive() {
            arguments.append("--operator-env-override-active")
        }
        if removeWebhook { arguments.append("--remove-webhook") }
        processClient.run(
            arguments,
            stdin: normalizedToken + "\n",
            environment: telegramSecretFreeEnvironment,
            timeout: NativeView.mutationTimeout,
            logOutput: false
        ) { [weak self] result in
            guard let self else { return }
            let response = self.decode(TelegramCenterSetupResponse.self, result.output)
            guard result.code == 0,
                  let response,
                  response.ok,
                  response.getme_verified == true,
                  response.token_stored == true else {
                self.endOperation()
                if !removeWebhook,
                   response?.error == "telegram_webhook_configured_remove_consent_required" {
                    self.confirmWebhookRemoval()
                    return
                }
                if response?.error == "telegram_operator_env_override_active" {
                    self.showAttention(
                        "Environment-managed token is active",
                        detail: response?.operator_action
                            ?? "Remove the operator-managed Telegram token environment override and relaunch before storing a file token."
                    )
                    return
                }
                if response?.partial_success == true {
                    self.showAttention(
                        "Telegram setup partially completed",
                        detail: self.partialSetupRecovery(response)
                    )
                    return
                }
                self.showAttention(
                    "Token not saved",
                    detail: self.publicFailure(
                        result.output,
                        fallback: "Telegram could not verify this bot token. Confirm it in @BotFather and try again."
                    )
                )
                return
            }
            let restart = self.telegramService.restart()
            Task { @MainActor [weak self] in
                do {
                    let receipt = try await restart.value
                    self?.endOperation()
                    self?.render(receipt)
                    self?.showProgress(
                        "Bot verified and connected",
                        detail: response.bot_state_reset == true
                            ? "The token is stored privately. Bot-scoped pairing and poll state were reset; generate a new pairing code."
                            : "The token is stored privately. Generate a pairing code for the intended private chat."
                    )
                } catch {
                    self?.endOperation()
                    self?.showAttention(
                        "Token saved; poller needs attention",
                        detail: "The verified token was stored, but the resident poller did not restart. Refresh status for the blocker."
                    )
                }
                self?.refreshStatus(after: 0.3)
            }
        }
    }

    private func confirmWebhookRemoval() {
        guard let window = view.window else { return }
        AlertFactory.confirmSheet(
            window: window,
            title: "Remove the existing Telegram webhook?",
            message: "Telegram cannot run getUpdates while this bot has a webhook. Removing it changes delivery: the existing webhook endpoint will stop receiving updates and SKS long polling can start. SKS requests removal without dropping pending updates. The token was not retained; after Continue, paste it again to authorize this one change.",
            destructive: true,
            actionTitle: "Continue"
        ) { [weak self] confirmed in
            guard confirmed else { return }
            self?.promptForToken(removeWebhook: true)
        }
    }

    private var telegramSecretFreeEnvironment: [String: String] {
        ["TELEGRAM_BOT_TOKEN": "", "SKS_TELEGRAM_BOT_TOKEN": ""]
    }

    private func refreshStatus(after delay: TimeInterval = 0) {
        guard delay > 0 else {
            loadStatus()
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.loadStatus() }
    }

    private func loadStatus() {
        guard !operationInFlight else { return }
        beginOperation("Refreshing secret-free Telegram status…")
        processClient.run(
            ["telegram", "doctor", "--json"],
            environment: telegramSecretFreeEnvironment,
            timeout: NativeView.statusTimeout,
            logOutput: false
        ) { [weak self] result in
            guard let self else { return }
            self.endOperation()
            guard let response = self.decode(TelegramCenterDoctorResponse.self, result.output) else {
                self.tokenConfigured = false
                self.pollerRunning = false
                self.showAttention("Status unavailable", detail: "SKS could not read the Telegram liveness receipt.")
                return
            }
            self.render(response)
        }
    }

    private func render(_ response: TelegramCenterDoctorResponse) {
        tokenConfigured = response.token_configured
        pollerRunning = response.poller.running
        let paired = response.paired_chat_count == 1 ? "1 paired chat" : "\(response.paired_chat_count) paired chats"
        let source = tokenSourceDescription(response.token_source)
        if response.ok {
            NativeView.setBadge(serviceBadge, text: "Ready", color: .systemGreen)
            serviceDetail.stringValue = "Bot identity verified · \(source) · \(paired) · poller running · audit healthy."
        } else if response.self_heal_action == "operator_remove_webhook"
                    || response.poller.last_error?.range(of: "409|webhook", options: .regularExpression) != nil {
            NativeView.setBadge(serviceBadge, text: "Webhook blocks polling", color: .systemOrange)
            serviceDetail.stringValue = "This bot has an active Telegram webhook, so getUpdates polling cannot run. Choose Enter Bot Token again; SKS will explain the delivery change and request explicit consent before removing the webhook without dropping pending updates."
        } else if !response.token_configured {
            NativeView.setBadge(serviceBadge, text: "Bot token required", color: .systemOrange)
            serviceDetail.stringValue = "Create a bot with @BotFather, then enter and verify its HTTP API token."
        } else if !response.bot_identity_valid {
            NativeView.setBadge(serviceBadge, text: "Bot identity not verified", color: .systemRed)
            serviceDetail.stringValue = "Telegram could not validate the stored bot identity. Enter the current BotFather token again."
        } else if !response.audit_healthy {
            NativeView.setBadge(serviceBadge, text: "Audit unavailable", color: .systemRed)
            serviceDetail.stringValue = "Remote control is stopped because its local audit ledger is unavailable. Repair local SKS permissions before restarting."
        } else if response.paired_chat_count == 0 {
            NativeView.setBadge(serviceBadge, text: "Private chat not paired", color: .systemOrange)
            serviceDetail.stringValue = "Bot verified · \(source) · no paired chats · \(response.poller.running ? "poller running" : "poller stopped"). Generate a pairing code and use it once in the intended private chat."
        } else if !response.poller.running {
            NativeView.setBadge(serviceBadge, text: "Poller stopped", color: .systemOrange)
            serviceDetail.stringValue = "Bot identity verified · \(source) · \(paired) · poller stopped. Choose Start to resume."
        } else {
            NativeView.setBadge(serviceBadge, text: "Needs attention", color: .systemOrange)
            serviceDetail.stringValue = "Bot identity verified · \(paired) · poller degraded after \(response.poller.consecutive_failures) consecutive failures. Refresh status or Restart."
        }
        serviceDetail.setAccessibilityValue(serviceDetail.stringValue)
        updateControls()
    }

    private func render(_ receipt: TelegramLivenessReceipt) {
        tokenConfigured = receipt.token_configured
        pollerRunning = receipt.running && receipt.poller.running
        let paired = receipt.paired_chat_count == 1 ? "1 paired chat" : "\(receipt.paired_chat_count) paired chats"
        let source = tokenSourceDescription(receipt.token_source.rawValue)
        NativeView.setBadge(
            serviceBadge,
            text: pollerRunning ? "Running" : "Stopped",
            color: pollerRunning ? .systemGreen : .systemOrange
        )
        serviceDetail.stringValue = "Bot identity \(receipt.bot_identity_valid ? "verified" : "not verified") · \(source) · \(paired) · poller \(pollerRunning ? "running" : "stopped") · audit \(receipt.audit_healthy == true ? "healthy" : "unavailable")."
        serviceDetail.setAccessibilityValue(serviceDetail.stringValue)
        updateControls()
    }

    private func beginOperation(_ detail: String) {
        operationInFlight = true
        serviceSpinner.startAnimation(nil)
        serviceDetail.stringValue = detail
        updateControls()
    }

    private func endOperation() {
        operationInFlight = false
        serviceSpinner.stopAnimation(nil)
        updateControls()
    }

    private func showProgress(_ title: String, detail: String) {
        NativeView.setBadge(serviceBadge, text: title, color: .systemBlue)
        serviceDetail.stringValue = detail
        serviceDetail.setAccessibilityValue(detail)
        updateControls()
    }

    private func showAttention(_ title: String, detail: String) {
        NativeView.setBadge(serviceBadge, text: title, color: .systemOrange)
        serviceDetail.stringValue = detail
        serviceDetail.setAccessibilityValue(detail)
        updateControls()
    }

    private func updateControls() {
        setupButton.isEnabled = !operationInFlight
        pairButton.isEnabled = !operationInFlight && tokenConfigured && pollerRunning
        startButton.isEnabled = !operationInFlight && tokenConfigured && !pollerRunning
        stopButton.isEnabled = !operationInFlight && pollerRunning
        restartButton.isEnabled = !operationInFlight && tokenConfigured
        refreshButton.isEnabled = !operationInFlight
    }

    private func validTokenShape(_ value: String) -> Bool {
        value.utf8.count <= 1024
            && value.range(of: Self.tokenPattern, options: .regularExpression) != nil
    }

    private func decode<T: Decodable>(_ type: T.Type, _ output: String) -> T? {
        guard let data = output.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private func publicFailure(_ output: String, fallback: String) -> String {
        guard let data = output.data(using: .utf8),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let error = row["error"] as? String else { return fallback }
        switch error {
        case "telegram_token_invalid", "telegram_token_stdin_empty":
            return "That value is not a complete BotFather HTTP API token."
        case let value where value.contains("401") || value.contains("Unauthorized"):
            return "Telegram rejected this token. Copy the current token from @BotFather and try again."
        case let value where value.contains("timeout") || value.contains("network"):
            return "Telegram identity verification could not complete. Check the network connection and try again."
        default:
            return fallback
        }
    }

    private func partialSetupRecovery(_ response: TelegramCenterSetupResponse?) -> String {
        var parts: [String] = []
        if response?.webhook_removed == true {
            parts.append("The existing webhook was removed without dropping pending updates.")
        }
        if response?.bot_state_reset == true {
            parts.append("Bot-scoped pairing and poll state were reset safely.")
        }
        if response?.token_stored == false {
            parts.append("The token was not stored; rerun secure setup to finish.")
        }
        if let note = response?.recovery?.note, !note.isEmpty { parts.append(note) }
        return parts.isEmpty
            ? "Review the secret-free recovery status, then rerun secure setup."
            : parts.joined(separator: " ")
    }

    private func tokenSourceDescription(_ source: String) -> String {
        switch source {
        case "env": return "operator environment token"
        case "user_secret_file": return "private token file"
        case "none": return "no token source"
        default: return "token source unknown"
        }
    }
}
