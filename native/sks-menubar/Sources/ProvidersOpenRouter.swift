import Cocoa

extension ProvidersViewController {
    // Compatibility refresh keeps an unsaved editor value intact while the
    // active 8.1.3 card obtains profile truth from `bridge status`.
    func refreshOpenRouterStatus() {
        let current = openRouterModelField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if !self.openRouterModelSelectionPending,
           current.isEmpty,
           !openRouterActiveModel.isEmpty {
            openRouterModelField.stringValue = openRouterActiveModel
        }
        refresh()
    }

    func describeOpenRouterStatus(_ json: [String: Any]) -> String {
        let enabled = json["enabled"] as? Bool == true
        return "OpenRouter profile · \(enabled ? "enabled" : "disabled")"
    }

    @objc private func selectOpenRouterModel(_ sender: NSPopUpButton) {
        guard sender.indexOfSelectedItem > 0, let model = sender.titleOfSelectedItem else { return }
        openRouterModelSelectionPending = true
        openRouterModelField.stringValue = model
    }

    func makeProviderCredentialsCard() -> NSBox {
        let lbConfigure = NativeView.button("Configure / Rotate", target: self, action: #selector(configureCodexLbProfile))
        let lbValidate = NativeView.button("Validate", target: self, action: #selector(validateCodexLbProfile))
        let lbToggle = NativeView.button("Enable / Disable", target: self, action: #selector(toggleCodexLbProfile))
        let orConfigure = NativeView.button("Configure / Rotate", target: self, action: #selector(configureOpenRouterProfile))
        let orValidate = NativeView.button("Validate", target: self, action: #selector(validateOpenRouterProfile))
        let orToggle = NativeView.button("Enable / Disable", target: self, action: #selector(toggleOpenRouterProfile))
        registerProviderAction(lbConfigure, id: "sks-provider-reconnect-codex-lb")
        registerProviderAction(lbValidate, id: "sks-provider-validate-codex-lb")
        registerProviderAction(lbToggle, id: "sks-provider-toggle-codex-lb")
        registerProviderAction(orConfigure, id: "sks-provider-reconnect-openrouter")
        registerProviderAction(orValidate, id: "sks-provider-validate-openrouter")
        registerProviderAction(orToggle, id: "sks-provider-toggle-openrouter")
        providerButtons["codex-lb"] = [lbConfigure, lbValidate, lbToggle]
        providerButtons["openrouter"] = [orConfigure, orValidate, orToggle]
        actionButtons += [lbConfigure, lbValidate, lbToggle, orConfigure, orValidate, orToggle]
        let card = NativeView.card(
            title: "Provider Credentials",
            subtitle: "Profiles coexist. Enable, disable, validate, rotate, or remove one credential without changing the other or Codex-owned ChatGPT OAuth.",
            views: [
                NativeView.sectionTitle("Codex-LB"), codexLbKeychainStatus, cliProviderStatus,
                ControlKit.actionRow([lbConfigure, lbValidate, lbToggle]),
                NativeView.sectionTitle("OpenRouter"), openRouterKeychainStatus, openRouterCredentialStatus,
                ControlKit.actionRow([orConfigure, orValidate, orToggle]),
                oauthCredentialStatus
            ]
        )
        card.setAccessibilityIdentifier("sks-provider-card-credentials")
        return card
    }

    func renderProviderProfiles(_ json: [String: Any]) {
        guard let providers = json["providers"] as? [String: Any] else {
            cliProviderStatus.stringValue = "Codex-LB · schema unavailable · no state assumed"
            openRouterCredentialStatus.stringValue = "OpenRouter · schema unavailable · no state assumed"
            cliProviderStatus.textColor = .systemRed
            openRouterCredentialStatus.textColor = .systemRed
            return
        }
        renderProviderProfile(providers["codex-lb"] as? [String: Any], id: "codex-lb", label: cliProviderStatus)
        renderProviderProfile(providers["openrouter"] as? [String: Any], id: "openrouter", label: openRouterCredentialStatus)
        let identity = json["native_identity"] as? [String: Any]
        let identityState = identity?["state"] as? String ?? "not_attempted"
        chatgptOauthPresentNow = identityState == "verified" || identityState == "configured_unverified"
        oauthCredentialStatus.stringValue = "ChatGPT OAuth Identity · \(identityState) · Codex-owned; never copied into provider profiles"
        oauthCredentialStatus.textColor = identityState == "verified" ? .systemGreen : .secondaryLabelColor
    }

    private func renderProviderProfile(_ profile: [String: Any]?, id: String, label: NSTextField) {
        guard profile?["schema"] as? String == "sks.bridge-provider-profile-status.v1",
              profile?["provider_id"] as? String == id,
              let credential = profile?["credential"] as? [String: Any],
              let catalog = profile?["catalog"] as? [String: Any],
              catalog["schema"] as? String == "sks.catalog-sync-state.v2" else {
            label.stringValue = "\(displayProvider(id)) · capability schema invalid"
            label.textColor = .systemRed; return
        }
        let enabled = profile?["enabled"] as? Bool == true
        providerEnabled[id] = enabled
        let credentialState = credential["state"] as? String ?? "unavailable"
        let endpoint = profile?["endpoint"] as? [String: Any]
        let origin = ProviderSecretRedactor.redactEndpoint(endpoint?["origin_redacted"] as? String ?? "not configured")
        let auth = endpoint?["auth_transport"] as? String ?? "unreported"
        let catalogState = catalog["state"] as? String ?? "failed"
        let checked = credential["checked_at"] as? String ?? catalog["checked_at"] as? String ?? "never"
        label.stringValue = "\(displayProvider(id)) · \(enabled ? "enabled" : "disabled") · credential \(credentialState) · endpoint \(origin) · auth \(auth) · catalog \(catalogState) · last \(checked)"
        label.textColor = credentialState == "ready" && enabled ? .systemGreen
            : ["rejected", "unavailable"].contains(credentialState) ? .systemRed : .systemOrange
    }

    @objc func configureCodexLbProfile() {
        guard let window = view.window else { return }
        AlertFactory.textSheet(window: window, title: "Codex-LB Endpoint", message: "Enter the Codex-LB endpoint. Its credential is stored independently from OpenRouter and ChatGPT OAuth.", secure: false, placeholder: "https://lb.example.com") { [weak self] host in
            guard let self = self, let host = host?.trimmingCharacters(in: .whitespacesAndNewlines), !host.isEmpty else { return }
            self.promptForSecretKey(window: window, sheetTitle: "Codex-LB API Key", sheetMessage: "Paste the Codex-LB key. It is sent through stdin and is never rendered in status, receipts, or logs.", placeholder: "sk-clb-…", args: ["bridge", "provider", "configure", "codex-lb", "--host", host, "--api-key-stdin", "--json"], kind: "bridge-provider-configure-codex-lb", title: "Configure Codex-LB profile", credential: .codexLbApiKey, statusLabel: self.cliProviderStatus, successSummary: "Codex-LB profile configured; OpenRouter preserved", failSummary: "Codex-LB profile configuration failed", providerId: "codex-lb")
        }
    }

    @objc func configureOpenRouterProfile() {
        guard let window = view.window else { return }
        promptForSecretKey(window: window, sheetTitle: "OpenRouter API Key", sheetMessage: "Paste the OpenRouter key. Codex-LB and ChatGPT OAuth remain unchanged.", placeholder: "sk-or-…", args: ["bridge", "provider", "configure", "openrouter", "--api-key-stdin", "--json"], kind: "bridge-provider-configure-openrouter", title: "Configure OpenRouter profile", credential: .openRouterApiKey, statusLabel: openRouterCredentialStatus, successSummary: "OpenRouter profile configured; Codex-LB preserved", failSummary: "OpenRouter profile configuration failed", codePrefix: "E-OR", providerId: "openrouter")
    }

    @objc func saveOpenRouterKey() { configureOpenRouterProfile() }
    @objc func validateCodexLbProfile() { runProviderAction("codex-lb", args: ["bridge", "provider", "validate", "codex-lb", "--json"], title: "Validate Codex-LB", mutationGroup: nil) }
    @objc func validateOpenRouterProfile() { runProviderAction("openrouter", args: ["bridge", "provider", "validate", "openrouter", "--json"], title: "Validate OpenRouter", mutationGroup: nil) }
    @objc func toggleCodexLbProfile() { toggleProvider("codex-lb") }
    @objc func toggleOpenRouterProfile() { toggleProvider("openrouter") }

    private func toggleProvider(_ id: String) {
        let verb = providerEnabled[id] == true ? "disable" : "enable"
        runProviderAction(id, args: ["bridge", "provider", verb, id, "--json"], title: "\(verb.capitalized) \(displayProvider(id))", mutationGroup: "codex-config")
    }

    private func runProviderAction(_ id: String, args: [String], title: String, mutationGroup: String?) {
        guard !providerActionInFlight.contains(id), let snapshot = operations.begin(kind: "bridge-provider-\(id)", mutationGroup: mutationGroup, summary: title) else { return }
        setProviderActionBusy(id, true)
        let label = id == "codex-lb" ? cliProviderStatus : openRouterCredentialStatus
        label.stringValue = "\(title)…"
        _ = operations.update(snapshot, state: .running, stage: "running", progress: nil, summary: title)
        processClient.run(args, timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.setProviderActionBusy(id, false)
            let parsed = self.json(result.output)
            let generated = parsed != nil && parsed?["schema"] != nil
            _ = self.operations.update(snapshot, state: generated ? .succeeded : .failed, stage: "complete", progress: 1, summary: generated ? "\(title) report generated" : "\(title) failed")
            if !generated { label.stringValue = "\(title) failed · \(self.structuredPublicDetail(parsed, fallback: result.output))" }
            self.refresh()
        }
    }

    func renderActiveProviderSummary() {
        let ready = [providerEnabled["codex-lb"] == true ? "Codex-LB" : nil, providerEnabled["openrouter"] == true ? "OpenRouter" : nil].compactMap { $0 }
        ControlKit.setBadge(activeProviderBadge, text: ready.isEmpty ? "Desktop Bridge · awaiting provider" : "Desktop Bridge · \(ready.joined(separator: " + "))", tone: ready.isEmpty ? .warning : .ok)
    }

    func structuredPublicDetail(_ json: [String: Any]?, fallback: String, codePrefix: String = "E-PROVIDER", fallbackNext: String = "Retry the operation") -> String {
        let code = publicFailureCode(json, fallback: codePrefix)
        if let blockers = json?["blockers"] as? [String], let first = blockers.first {
            return "\(code) · \(ProviderSecretRedactor.redact(first)) · Next: \(fallbackNext)"
        }
        return "\(code) · \(ProviderSecretRedactor.redact(NativeView.redactPreview(fallback))) · Next: \(fallbackNext)"
    }

    func publicFailureCode(_ json: [String: Any]?, fallback: String = "E-PROVIDER") -> String {
        if let code = json?["code"] as? String, !code.isEmpty { return ProviderSecretRedactor.redact(code) }
        if let blocker = (json?["blockers"] as? [String])?.first, !blocker.isEmpty { return ProviderSecretRedactor.redact(blocker) }
        return fallback
    }

    private func displayProvider(_ id: String) -> String { id == "codex-lb" ? "Codex-LB" : "OpenRouter" }
}
