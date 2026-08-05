import Cocoa

struct ProviderActionInventoryItem: Equatable {
    let id: String
    let handler: String
    let backend: String
    let loadingState: String
    let successState: String
    let recoveryAction: String
}

enum ProviderActionInventory {
    static let items: [ProviderActionInventoryItem] = [
        .init(id: "sks-provider-bridge-repair", handler: "repairDesktopBridge", backend: "sks bridge repair --json", loadingState: "repairing", successState: "bridge receipt", recoveryAction: "inspect bridge logs"),
        .init(id: "sks-provider-verify-transport", handler: "verifyTransport", backend: "sks bridge verify --level transport --json", loadingState: "verifying", successState: "v3 report", recoveryAction: "retry transport verification"),
        .init(id: "sks-provider-verify-deep", handler: "verifyDeep", backend: "sks bridge verify --level deep --json", loadingState: "verifying", successState: "v3 report", recoveryAction: "review scoped findings"),
        .init(id: "sks-provider-reconnect-codex-lb", handler: "configureCodexLbProfile", backend: "sks bridge provider configure codex-lb", loadingState: "saving", successState: "profile configured", recoveryAction: "repair Keychain and reconnect"),
        .init(id: "sks-provider-validate-codex-lb", handler: "validateCodexLbProfile", backend: "sks bridge provider validate codex-lb --json", loadingState: "validating", successState: "provider report", recoveryAction: "rotate credential"),
        .init(id: "sks-provider-toggle-codex-lb", handler: "toggleCodexLbProfile", backend: "sks bridge provider enable or disable codex-lb", loadingState: "updating profile", successState: "profile state updated", recoveryAction: "retry provider update"),
        .init(id: "sks-provider-reconnect-openrouter", handler: "configureOpenRouterProfile", backend: "sks bridge provider configure openrouter", loadingState: "saving", successState: "profile configured", recoveryAction: "repair Keychain and reconnect"),
        .init(id: "sks-provider-validate-openrouter", handler: "validateOpenRouterProfile", backend: "sks bridge provider validate openrouter --json", loadingState: "validating", successState: "provider report", recoveryAction: "rotate credential"),
        .init(id: "sks-provider-toggle-openrouter", handler: "toggleOpenRouterProfile", backend: "sks bridge provider enable or disable openrouter", loadingState: "updating profile", successState: "profile state updated", recoveryAction: "retry provider update"),
        .init(id: "sks-provider-refresh-catalog", handler: "refreshCombinedCatalog", backend: "sks bridge catalog sync --json", loadingState: "syncing", successState: "combined catalog report", recoveryAction: "retry catalog sync"),
        .init(id: "sks-provider-open-catalog-report", handler: "openCatalogReport", backend: "sks bridge catalog status --json", loadingState: "loading report", successState: "combined catalog report", recoveryAction: "retry catalog status"),
        .init(id: "sks-provider-route-explain", handler: "explainRoute", backend: "sks bridge route explain --json", loadingState: "resolving", successState: "explicit route shown", recoveryAction: "refresh catalog or choose supported model")
    ]

    static func item(_ id: String) -> ProviderActionInventoryItem? { items.first { $0.id == id } }
}

extension ProvidersViewController {
    func registerProviderAction(_ button: NSButton, id: String) {
        guard let item = ProviderActionInventory.item(id) else {
            assertionFailure("Missing provider action inventory: \(id)")
            button.isEnabled = false
            return
        }
        button.setAccessibilityIdentifier(item.id)
        button.setAccessibilityHelp("Loading: \(item.loadingState). Success: \(item.successState). Recovery: \(item.recoveryAction).")
    }

    func refreshCredentialHealth() {
        renderCredentialState(keychainStore.statusNonInteractive(.codexLbApiKey), label: codexLbKeychainStatus, name: "Codex LB")
        renderCredentialState(keychainStore.statusNonInteractive(.openRouterApiKey), label: openRouterKeychainStatus, name: "OpenRouter")
    }

    func renderCredentialState(_ state: SKSKeychainCredentialState, label: NSTextField, name: String) {
        switch state {
        case .available:
            label.stringValue = "\(name) credential: available in Keychain · background reads are non-interactive."
            label.textColor = .secondaryLabelColor
        case .authenticationRequired(let reason):
            label.stringValue = "Authentication Required: \(name) · \(reason). Choose Reconnect; no authentication UI was opened automatically."
            label.textColor = .systemOrange
        case .unavailable(let reason):
            label.stringValue = "Authentication Required: \(name) · \(reason). SKS remains running; unlock or repair Keychain, then choose Reconnect."
            label.textColor = .systemRed
        }
    }

    func promptForSecretKey(window: NSWindow, sheetTitle: String, sheetMessage: String, placeholder: String, args: [String], kind: String, title: String, credential: SKSKeychainCredential, statusLabel: NSTextField, successSummary: String, failSummary: String, codePrefix: String = "E-LB", providerId: String? = nil) {
        AlertFactory.textSheet(window: window, title: sheetTitle, message: sheetMessage, secure: true, placeholder: placeholder) { [weak self] key in
            guard let self = self, let key = key else { return }
            if let providerId = providerId, self.providerActionInFlight.contains(providerId) {
                statusLabel.stringValue = "That provider already has an operation in progress."
                return
            }
            guard providerId != nil || !self.busy else { statusLabel.stringValue = "Another provider action is already running."; return }
            guard let snapshot = self.operations.begin(kind: kind, mutationGroup: "codex-config", summary: title) else {
                statusLabel.stringValue = "Another guarded mutation is already running. Wait or open Diagnostics."
                return
            }
            if let providerId = providerId { self.setProviderActionBusy(providerId, true) } else { self.setBusy(true) }
            statusLabel.stringValue = "\(title)…"
            _ = self.operations.update(snapshot, state: .running, stage: "running", progress: nil, summary: title)
            self.processClient.run(args, stdin: key + "\n", timeout: NativeView.mutationTimeout) { [weak self] result in
                guard let self = self else { return }
                if let providerId = providerId { self.setProviderActionBusy(providerId, false) } else { self.setBusy(false) }
                let parsed = self.json(result.output)
                let configurationSaved = result.code == 0 && parsed?["ok"] as? Bool == true
                let keychainWrite = configurationSaved
                    ? self.keychainStore.store(key, credential: credential, explicitUserAction: true)
                    : SKSKeychainWriteResult(state: .authenticationRequired(reason: "configuration save failed"), stored: false)
                let complete = configurationSaved && keychainWrite.stored
                _ = self.operations.update(snapshot, state: complete ? .succeeded : .failed, stage: "complete", progress: 1, summary: complete ? successSummary : failSummary)
                if complete {
                    statusLabel.stringValue = "\(successSummary) · Keychain confirmed. Next: test the saved configuration."
                } else if configurationSaved {
                    let reason: String
                    switch keychainWrite.state {
                    case .available: reason = "Keychain write was not confirmed"
                    case .authenticationRequired(let detail), .unavailable(let detail): reason = detail
                    }
                    statusLabel.stringValue = "Configuration saved, but Keychain was not applied · \(reason). Authentication Required: choose Reconnect after repairing Keychain."
                } else {
                    statusLabel.stringValue = "\(failSummary) · \(self.structuredPublicDetail(parsed, fallback: result.output, codePrefix: codePrefix))"
                }
                self.refresh()
            }
        }
    }

    @objc func openCodexSignInAction() {
        guard let bundleIdentifier = AppRuntime.codexBundleId,
              let applicationURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier) else {
            oauthCredentialStatus.stringValue = "Authentication Required: Codex application was not found. Install or open Codex, sign in with ChatGPT, then refresh SKS Center."
            oauthCredentialStatus.textColor = .systemRed
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: applicationURL, configuration: configuration) { [weak self] _, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let error = error {
                    self.oauthCredentialStatus.stringValue = "Authentication Required: Codex could not be opened · \(NativeView.redactPreview(error.localizedDescription)). Retry explicitly."
                    self.oauthCredentialStatus.textColor = .systemRed
                } else {
                    self.oauthCredentialStatus.stringValue = "Codex opened by your explicit action. Complete ChatGPT sign-in there; SKS will not copy or display the OAuth refresh token."
                    self.oauthCredentialStatus.textColor = .systemOrange
                }
            }
        }
    }

}
