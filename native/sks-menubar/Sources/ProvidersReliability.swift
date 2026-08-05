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
        .init(id: "sks-provider-desktop-bridge-mode", handler: "enableDesktopFull", backend: "sks codex-lb use-desktop-full", loadingState: "routing", successState: "four-stage receipt", recoveryAction: "review provider stages"),
        .init(id: "sks-provider-verify-capabilities", handler: "verifyDesktopCapabilities", backend: "sks codex-lb capabilities", loadingState: "verifying", successState: "trusted capability matrix", recoveryAction: "retry verification"),
        .init(id: "sks-provider-use-chatgpt-oauth", handler: "disableDesktopRouting", backend: "sks codex-lb disable", loadingState: "routing", successState: "four-stage receipt", recoveryAction: "open provider settings"),
        .init(id: "sks-provider-reconnect-codex-lb", handler: "setDomainAndKey", backend: "sks codex-lb setup", loadingState: "saving", successState: "Keychain confirmed", recoveryAction: "repair Keychain and reconnect"),
        .init(id: "sks-provider-run-connect-test", handler: "testConnection", backend: "sks codex-lb connect-test", loadingState: "testing", successState: "bounded response proof", recoveryAction: "retry connect test"),
        .init(id: "sks-provider-copy-cli-command", handler: "copyCliCommand", backend: "local pasteboard", loadingState: "copying", successState: "command copied", recoveryAction: "copy again"),
        .init(id: "sks-provider-activate-codex-lb", handler: "useCliProvider", backend: "sks codex-lb use-cli", loadingState: "applying", successState: "connection proof", recoveryAction: "review Credentials Connection Proof"),
        .init(id: "sks-provider-reconnect-openrouter", handler: "saveOpenRouterKey", backend: "sks codex-app set-openrouter-key", loadingState: "saving", successState: "Keychain confirmed", recoveryAction: "repair Keychain and reconnect"),
        .init(id: "sks-provider-save-openrouter-key", handler: "saveOpenRouterKey", backend: "sks codex-app set-openrouter-key", loadingState: "saving", successState: "Keychain confirmed", recoveryAction: "repair Keychain and reconnect"),
        .init(id: "sks-provider-refresh-openrouter-catalog", handler: "refreshOpenRouterModelsAction", backend: "sks codex-app openrouter-models", loadingState: "refreshing", successState: "validated catalog", recoveryAction: "reconnect then refresh"),
        .init(id: "sks-provider-test-openrouter", handler: "testOpenRouterConnection", backend: "sks codex-app openrouter-test", loadingState: "testing", successState: "model verified", recoveryAction: "choose a validated model"),
        .init(id: "sks-provider-activate-openrouter", handler: "useOpenRouter", backend: "sks codex-app use-openrouter", loadingState: "applying", successState: "four-stage receipt", recoveryAction: "restore previous provider"),
        .init(id: "sks-provider-restore-previous", handler: "restorePreviousDesktopRouting", backend: "sks codex-app restore-desktop-routing", loadingState: "restoring", successState: "snapshot restored", recoveryAction: "review restore blocker"),
        .init(id: "sks-provider-open-codex-signin", handler: "openCodexSignInAction", backend: "NSWorkspace Codex launch", loadingState: "opening", successState: "Codex opened", recoveryAction: "install or open Codex manually"),
        .init(id: "sks-provider-fast-on", handler: "fastOn", backend: "sks fast-mode on", loadingState: "applying", successState: "service tier verified", recoveryAction: "refresh status"),
        .init(id: "sks-provider-fast-off", handler: "fastOff", backend: "sks fast-mode off", loadingState: "applying", successState: "service tier verified", recoveryAction: "refresh status"),
        .init(id: "sks-provider-refresh-router", handler: "refreshMultiProviderRouterAction", backend: "sks codex-app router-status", loadingState: "refreshing", successState: "router catalog loaded", recoveryAction: "retry refresh"),
        .init(id: "sks-provider-test-router", handler: "testMultiProviderRouter", backend: "sks codex-app router-test", loadingState: "testing", successState: "router verified", recoveryAction: "review router blocker"),
        .init(id: "sks-provider-configure-router", handler: "useMultiProviderRouter", backend: "sks codex-app use-router", loadingState: "applying", successState: "router configured", recoveryAction: "restore provider settings"),
        .init(id: "sks-provider-refresh-role-models", handler: "refreshRoleModelsAction", backend: "sks codex-app role-models", loadingState: "refreshing", successState: "role settings loaded", recoveryAction: "retry refresh"),
        .init(id: "sks-provider-save-role-model", handler: "saveRoleModel", backend: "sks codex-app set-role-model", loadingState: "saving", successState: "role override saved", recoveryAction: "retry or reset"),
        .init(id: "sks-provider-reset-role-model", handler: "resetRoleModel", backend: "sks codex-app reset-role-model", loadingState: "resetting", successState: "role override reset", recoveryAction: "retry reset")
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
        let catalogReady = catalog?["status"] as? String == "ready" || json?["catalog_refreshed"] as? Bool == true
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
        let catalog = (json["catalog_sync"] as? [String: Any])
            ?? (json["model_catalog_sync"] as? [String: Any])
        guard let catalog = catalog else {
            catalogSyncStatus.stringValue = "Native Codex catalog sync: state not reported · last verified catalog was not assumed. Retry provider status or Verify Capabilities."
            catalogSyncStatus.textColor = .systemOrange
            return
        }
        let state = (catalog["status"] as? String) ?? "unverified"
        let updatedAt = (catalog["updated_at"] as? String) ?? "unknown time"
        let changed = catalog["changed"] as? Bool
        let failure = (catalog["failure_reason"] as? String) ?? (catalog["error"] as? String)
        let changeText = changed == true ? "changed" : changed == false ? "unchanged" : "change unknown"
        let failureText = failure.map { " · reason: \($0) · recovery: retry catalog sync" } ?? ""
        catalogSyncStatus.stringValue = "Native Codex catalog sync: \(state) · \(changeText) · last \(updatedAt)\(failureText)"
        catalogSyncStatus.textColor = failure == nil && state == "ready" ? .secondaryLabelColor : .systemOrange
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

    func promptForSecretKey(window: NSWindow, sheetTitle: String, sheetMessage: String, placeholder: String, args: [String], kind: String, title: String, credential: SKSKeychainCredential, statusLabel: NSTextField, successSummary: String, failSummary: String) {
        AlertFactory.textSheet(window: window, title: sheetTitle, message: sheetMessage, secure: true, placeholder: placeholder) { [weak self] key in
            guard let self = self, let key = key else { return }
            guard !self.busy else { statusLabel.stringValue = "Another provider action is already running."; return }
            guard let snapshot = self.operations.begin(kind: kind, mutationGroup: "codex-config", summary: title) else {
                statusLabel.stringValue = "Another guarded mutation is already running. Wait or open Diagnostics."
                return
            }
            self.setBusy(true)
            statusLabel.stringValue = "\(title)…"
            _ = self.operations.update(snapshot, state: .running, stage: "running", progress: nil, summary: title)
            self.processClient.run(args, stdin: key + "\n", timeout: NativeView.mutationTimeout) { [weak self] result in
                guard let self = self else { return }
                self.setBusy(false)
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
                    statusLabel.stringValue = "\(failSummary) · \(self.structuredPublicDetail(parsed, fallback: result.output))"
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

    func performDesktopRouting(_ args: [String], title: String, kind: String, expectedMode: String) {
        guard !busy else { providerStatus.stringValue = "Another provider action is already running."; return }
        let targetMode = expectedMode == "disabled" ? "chatgpt-oauth" : "codex-lb"
        let targetModel = targetMode == "chatgpt-oauth" ? "native-catalog-selection" : "catalog-selection-required"
        guard let snapshot = beginProviderApply(kind: kind, summary: title, mode: targetMode, model: targetModel) else {
            providerStatus.stringValue = "Another guarded mutation is already running. Wait or open Diagnostics."
            return
        }
        setBusy(true)
        providerStatus.stringValue = "\(title)…"
        let running = operations.update(snapshot, state: .running, stage: "routing", progress: nil, summary: title)
        processClient.run(args, timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.setBusy(false)
            let parsed = self.json(result.output)
            let routing = parsed.map(ProviderRoutingTruth.snapshot(from:))
            let mode = routing?.mode
            let oauthPreserved = routing.flatMap { $0.oauthPreservedFlag }
            let routeConfirmed = result.code == 0 && parsed?["ok"] as? Bool == true && mode == expectedMode && oauthPreserved != false
            let configSaved = parsed?["config_committed"] as? Bool == true || parsed?["config_applied"] as? Bool == true
            let applied = self.recordProviderApplyResult(running, json: parsed, configurationSaved: configSaved, proxyApplied: routeConfirmed)
            let fullyApplied = applied.providerApply?.allSucceeded == true
            guard routeConfirmed else {
                self.providerStatus.stringValue = "\(title) was not confirmed · \(self.structuredPublicDetail(parsed, fallback: result.output)) No routing or OAuth change was assumed."
                return
            }
            let bridgeSelected = expectedMode == "desktop-native-bridge"
            self.desktopFullRoutingNow = false
            self.codexLbSelectedNow = false
            self.chatgptOauthPresentNow = routing?.chatgptOauthPresent ?? self.chatgptOauthPresentNow
            self.renderActiveProviderSummary()
            if bridgeSelected { self.renderMeasuredRoutingBadge(nil, routeExpected: true) }
            self.providerStatus.stringValue = fullyApplied
                ? (bridgeSelected
                    ? "Desktop Bridge Mode applied · ChatGPT sign-in preserved · all four local stages confirmed."
                    : "ChatGPT OAuth mode applied · all four local stages confirmed.")
                : "Routing changed, but one or more apply stages remain unverified. Review Provider Apply Stages before starting new sessions."
            self.refresh()
        }
    }
}
