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

    func renderLatestProviderApply() {
        guard let projection = operations.latestSnapshot()?.providerApply else {
            providerApplyStatus.stringValue = "Provider apply stages: no operation receipt yet. Existing sessions remain unchanged."
            providerApplyStatus.textColor = .secondaryLabelColor
            return
        }
        let rows = projection.stages.map { receipt in
            let reason = receipt.reasonCode.map { " · \($0)" } ?? ""
            return "\(receipt.stage.rawValue): \(receipt.status.rawValue)\(reason)"
        }
        let existing = projection.existingSession.map { "\($0.mode) / \($0.model)" } ?? "none"
        let next = "\(projection.newSessionDefault.mode) / \(projection.newSessionDefault.model)"
        providerApplyStatus.stringValue = rows.joined(separator: " · ") + "\nExisting session: \(existing) · New-session default: \(next)"
        providerApplyStatus.textColor = projection.failedStage == nil ? .secondaryLabelColor : .systemOrange
    }

    func currentProviderSessionCopy() -> ProviderSessionCopy? {
        if openRouterSelectedNow {
            return ProviderSessionCopy(mode: "openrouter", model: openRouterActiveModel.isEmpty ? "catalog-selection-required" : openRouterActiveModel, catalogVersion: "last-verified")
        }
        if desktopFullRoutingNow || codexLbSelectedNow {
            return ProviderSessionCopy(mode: "codex-lb", model: routerActiveModel.isEmpty ? "catalog-selection-required" : routerActiveModel, catalogVersion: "last-verified")
        }
        if chatgptOauthPresentNow {
            return ProviderSessionCopy(mode: "chatgpt-oauth", model: "native-catalog-selection", catalogVersion: "native-last-verified")
        }
        return nil
    }

    func beginProviderApply(
        kind: String,
        summary: String,
        mode: String,
        model: String,
        catalogVersion: String = "pending-verification"
    ) -> OperationSnapshot? {
        operations.begin(
            kind: kind,
            mutationGroup: "codex-config",
            summary: summary,
            providerApply: .initial(
                existingSession: currentProviderSessionCopy(),
                newSessionDefault: ProviderSessionCopy(mode: mode, model: model, catalogVersion: catalogVersion)
            )
        )
    }

    func recordProviderApplyResult(
        _ snapshot: OperationSnapshot,
        json: [String: Any]?,
        configurationSaved: Bool,
        proxyApplied: Bool
    ) -> OperationSnapshot {
        var current = snapshot
        let catalog = (json?["catalog_sync"] as? [String: Any]) ?? (json?["model_catalog_sync"] as? [String: Any])
        let catalogReady = catalog?["state"] as? String == "verified" || json?["catalog_refreshed"] as? Bool == true
        let restart = json?["restart_performed"] as? Bool == true
            || json?["new_session_ready"] as? Bool == true
            || (json?["restart_app"] as? [String: Any])?["ok"] as? Bool == true
        let outcomes: [(ProviderApplyStageName, Bool, String)] = [
            (.configSaved, configurationSaved, "provider_config_not_confirmed"),
            (.proxyApplied, proxyApplied, "provider_proxy_not_confirmed"),
            (.catalogRefreshed, catalogReady, "provider_catalog_not_verified"),
            (.newSessionReady, restart, "provider_new_session_not_verified")
        ]
        for (stage, succeeded, reason) in outcomes {
            do {
                current = try operations.recordProviderApplyStage(current, stage: stage, status: .running)
                current = try operations.recordProviderApplyStage(
                    current,
                    stage: stage,
                    status: succeeded ? .succeeded : .failed,
                    reasonCode: succeeded ? nil : reason
                )
            } catch {
                providerApplyStatus.stringValue = "Provider stage receipt rejected · \(stage.rawValue). Recovery: refresh status and retry explicitly."
                providerApplyStatus.textColor = .systemRed
                break
            }
            if !succeeded { break }
        }
        renderLatestProviderApply()
        return current
    }

    func capabilityCompatibilityDetail(
        definition: (label: String, keys: [String]),
        payload: [String: Any],
        state: String,
        trustVerified: Bool
    ) -> String {
        let evidence = definition.keys.compactMap { payload[$0] as? [String: Any] }.first
        let route = (evidence?["route"] as? String) ?? (evidence?["credential_path"] as? String)
        let routeText: String
        switch route {
        case "proxy", "proxy-direct", "direct": routeText = "direct proxy"
        case "oauth", "oauth-auxiliary", "oauth_auxiliary": routeText = "OAuth auxiliary"
        default: routeText = "route unverified"
        }
        let oauthRequired = evidence?["oauth_required"] as? Bool
        let oauthText = oauthRequired == true
            ? (chatgptOauthPresentNow ? "OAuth connected" : "OAuth connection required")
            : oauthRequired == false ? "OAuth not required" : "OAuth requirement unverified"
        let reason = (evidence?["reason"] as? String)
            ?? (evidence?["blocker"] as? String)
            ?? (evidence?["error"] as? String)
            ?? (trustVerified ? "no reported degradation" : "trusted protocol evidence missing")
        let recovery = (evidence?["recovery_action"] as? String)
            ?? (oauthRequired == true && !chatgptOauthPresentNow ? "Open Codex sign-in" : "Verify Capabilities")
        return "\(state) · \(routeText) · \(oauthText) · reason: \(reason) · recovery: \(recovery)"
    }

    func renderCatalogSyncStatus(_ json: [String: Any]) {
        let payload = (json["schema"] as? String == "sks.desktop-capabilities.v3" ? json : nil)
            ?? (json["report"] as? [String: Any])
            ?? (json["capability_report"] as? [String: Any])
        guard payload?["schema"] as? String == "sks.desktop-capabilities.v3",
              let catalog = payload?["catalog_sync"] as? [String: Any],
              catalog["schema"] as? String == "sks.combined-catalog-sync.v1" else {
            catalogSyncStatus.stringValue = "Capability schema invalid · catalog_sync missing · capability_schema_invalid"
            catalogSyncStatus.textColor = .systemRed
            return
        }
        let state = catalog["state"] as? String ?? "failed"
        let models = (catalog["model_count"] as? NSNumber)?.intValue
        let conflicts = (catalog["conflict_count"] as? NSNumber)?.intValue ?? 0
        let providers = catalog["providers"] as? [String: Any]
        func count(_ id: String) -> String {
            guard let row = providers?[id] as? [String: Any] else { return "invalid" }
            let rowState = row["state"] as? String ?? "invalid"
            return (row["model_count"] as? NSNumber).map { "\($0.intValue)" } ?? rowState
        }
        let modelText = models.map { " · \($0) models" } ?? ""
        let conflictText = conflicts > 0 ? " · \(conflicts) conflicts" : ""
        let blocker = (catalog["blockers"] as? [String])?.first.map { " · \(ProviderSecretRedactor.redact($0))" } ?? ""
        catalogSyncStatus.stringValue = "Combined catalog · \(state)\(modelText) · Codex-LB \(count("codex-lb")) / OpenRouter \(count("openrouter"))\(conflictText)\(blocker)"
        switch state {
        case "verified": catalogSyncStatus.textColor = .systemGreen
        case "failed": catalogSyncStatus.textColor = .systemRed
        default: catalogSyncStatus.textColor = .systemOrange
        }
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
