import Cocoa

extension ProvidersViewController {
    func makeActiveProviderCard() -> NSBox {
        NativeView.card(
            title: "Active Provider",
            subtitle: "Live provider path. Codex LB uses Authorization: Bearer. Switch with Use Codex LB, OpenRouter Activate, or Advanced · Use ChatGPT OAuth Only.",
            views: [activeProviderBadge, oauthCredentialStatus]
        )
    }

    /// One-line truth for "what is Codex using right now", fed by the three
    /// independent status probes as their responses arrive.
    func renderActiveProviderSummary() {
        if openRouterSelectedNow {
            let model = openRouterActiveModel.isEmpty || openRouterActiveModel == "unset" ? "model unset" : openRouterActiveModel
            ControlKit.setBadge(activeProviderBadge, text: "OpenRouter · \(model)", tone: .ok)
        } else if routerSelectedNow {
            let model = routerActiveModel.isEmpty ? "model unset" : routerActiveModel
            ControlKit.setBadge(activeProviderBadge, text: "Multi-Provider Router · \(model)", tone: .ok)
        } else if desktopFullRoutingNow {
            ControlKit.setBadge(
                activeProviderBadge,
                text: chatgptOauthPresentNow
                    ? "Codex LB · Desktop Bridge · ChatGPT OAuth + built-in OpenAI"
                    : "Codex LB · Desktop Bridge · ChatGPT OAuth missing — run codex login",
                tone: chatgptOauthPresentNow ? .ok : .warning
            )
        } else if codexLbSelectedNow {
            // Measured CLI selection is not legacy migration (that badge comes only from refresh snapshot markers).
            if codexLbProvedNow {
                ControlKit.setBadge(activeProviderBadge, text: "Codex LB · CLI · verified", tone: .ok)
            } else {
                ControlKit.setBadge(activeProviderBadge, text: "Codex LB · CLI · selected · connection unproved", tone: .warning)
            }
        } else if chatgptOauthPresentNow {
            ControlKit.setBadge(activeProviderBadge, text: "ChatGPT OAuth mode · built-in OpenAI models", tone: .neutral)
        } else {
            ControlKit.setBadge(activeProviderBadge, text: "ChatGPT OAuth mode unavailable · run codex login", tone: .warning)
        }
    }

    func makeOpenRouterCard() -> NSBox {
        openRouterModelField.delegate = self
        openRouterModelPopup.addItem(withTitle: "Choose from catalog…")
        openRouterModelPopup.target = self
        openRouterModelPopup.action = #selector(selectOpenRouterModel(_:))
        openRouterModelPopup.setAccessibilityLabel("OpenRouter model catalog")
        openRouterModelPopup.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        openRouterModelPopup.widthAnchor.constraint(equalToConstant: 230).isActive = true
        openRouterModelPopup.isEnabled = false
        openRouterModelField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let refreshModels = NativeView.button("Refresh Models", target: self, action: #selector(refreshOpenRouterModelsAction(_:)))
        openRouterRefreshButton = refreshModels
        let saveKey = NativeView.button("Save OpenRouter key…", target: self, action: #selector(saveOpenRouterKey))
        let test = NativeView.button("Test Model", target: self, action: #selector(testOpenRouterConnection))
        test.setAccessibilityLabel("Test the selected OpenRouter model")
        let activate = ControlKit.primaryButton("Activate Selected Model", target: self, action: #selector(useOpenRouter))
        activate.setAccessibilityLabel("Activate selected OpenRouter model and restart Codex App")
        let restorePrevious = NativeView.button("Restore previous provider", target: self, action: #selector(restorePreviousDesktopRouting))
        restorePrevious.setAccessibilityLabel("Restore the previous Codex provider so hidden chats and picker state return")
        // Stays disabled until openrouter-status reports a restorable
        // cross-provider snapshot, so the button never promises a restore the
        // CLI would reject with snapshot_missing.
        restorePrevious.isEnabled = false
        openRouterRestoreButton = restorePrevious
        registerProviderAction(refreshModels, id: "sks-provider-refresh-openrouter-catalog")
        registerProviderAction(saveKey, id: "sks-provider-save-openrouter-key")
        registerProviderAction(test, id: "sks-provider-test-openrouter")
        registerProviderAction(activate, id: "sks-provider-activate-openrouter")
        registerProviderAction(restorePrevious, id: "sks-provider-restore-previous")
        actionButtons += [refreshModels, saveKey, test, activate, restorePrevious]

        let catalogLabel = NSTextField(labelWithString: "Catalog")
        catalogLabel.setContentHuggingPriority(.required, for: .horizontal)
        let manualLabel = NSTextField(labelWithString: "Model ID")
        manualLabel.setContentHuggingPriority(.required, for: .horizontal)
        return NativeView.card(
            title: "OpenRouter",
            subtitle: "Saving the key prepares OpenRouter but does not switch providers. Activate switches Desktop routing; SKS remaps the local thread sidebar so prior provider chats stay visible, and keeps a one-click restore snapshot.",
            views: [
                openRouterCredentialStatus, openRouterKeychainStatus,
                openRouterActiveStatus,
                NativeView.row([catalogLabel, openRouterModelPopup, refreshModels]),
                openRouterCatalogStatus,
                NativeView.row([manualLabel, openRouterModelField]),
                NativeView.row([saveKey, test, activate]),
                NativeView.row([restorePrevious]),
                openRouterStatus
            ]
        )
    }

    func refreshOpenRouterStatus() {
        processClient.run(["codex-app", "openrouter-status", "--json"], timeout: NativeView.statusTimeout) { [weak self] result in
            guard let self = self else { return }
            guard let json = self.json(result.output) else {
                if !self.busy {
                    self.openRouterCredentialStatus.stringValue = "Credential: status unavailable — no saved key was assumed."
                    self.openRouterActiveStatus.stringValue = "Active provider: status unavailable — no active provider was assumed."
                }
                // An unreadable status cannot vouch for a restore point, so the
                // button must not keep an enabled state from an earlier reply.
                self.openRouterRestoreAvailable = false
                self.openRouterRestoreButton?.isEnabled = false
                self.openRouterRestoreButton?.toolTip = "Restore availability is unknown — refresh the OpenRouter status first."
                return
            }
            let keyPresent = json["key_present"] as? Bool == true
            let keyValidated = json["key_validated"] as? Bool == true
                || json["credential_validated"] as? Bool == true
            let providerPresent = json["provider_present"] as? Bool == true
            let selected = json["selected"] as? Bool == true
            let activeModel = json["model"] as? String ?? "unset"
            let current = self.openRouterModelField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if selected, activeModel != "unset", !self.openRouterModelSelectionPending, current.isEmpty {
                self.openRouterModelField.stringValue = activeModel
            }
            self.synchronizeOpenRouterPopupSelection()
            self.openRouterSelectedNow = selected
            self.openRouterCredentialValidatedNow = keyValidated
            self.openRouterActiveModel = activeModel
            self.renderActiveProviderSummary()
            self.openRouterCredentialStatus.stringValue = keyValidated
                ? "Credential: validated\(providerPresent ? " · provider route ready" : " · provider setup needs repair")"
                : keyPresent
                    ? "Credential: stored but not validated · models remain hidden until authenticated refresh succeeds"
                : "Credential: missing · save a key before testing or activation"
            self.openRouterActiveStatus.stringValue = selected
                ? "Active provider: OpenRouter · main model \(activeModel)"
                : "Active provider: not OpenRouter · saved credentials remain available"
            if !self.openRouterActionRan {
                let summary = self.describeOpenRouterStatus(json)
                self.openRouterStatus.stringValue = result.code == 0
                    ? summary
                    : "\(summary) \(self.structuredPublicDetail(json, fallback: result.output, codePrefix: "E-OR"))"
            }
            self.openRouterCredentialStatus.textColor = keyValidated ? .secondaryLabelColor : .systemOrange
            if !keyValidated { self.clearOpenRouterModels(reason: "Credential not validated · model and child-agent lists are hidden. Choose Reconnect, then Refresh Models.") }
            self.openRouterActiveStatus.textColor = selected ? .systemGreen : .secondaryLabelColor
            self.openRouterRestoreAvailable = json["previous_routing_restore_available"] as? Bool == true
            self.openRouterRestoreButton?.isEnabled = !self.busy && self.openRouterRestoreAvailable
            self.openRouterRestoreButton?.toolTip = self.openRouterRestoreAvailable
                ? "Restore the snapshotted pre-OpenRouter provider, model, and catalog."
                : "No previous provider snapshot to restore."
        }
    }

    func describeOpenRouterStatus(_ json: [String: Any]) -> String {
        let keyPresent = json["key_present"] as? Bool == true
        let providerPresent = json["provider_present"] as? Bool == true
        let selected = json["selected"] as? Bool == true
        let activeModel = json["model"] as? String ?? "unset"
        if !keyPresent { return "OpenRouter: key missing. Next: save a key, refresh models, then test the model." }
        if !providerPresent { return "OpenRouter: provider missing. Next: save the key again to repair the provider block." }
        if selected { return "OpenRouter: active · main model \(activeModel). Next: test after changing models, or choose another provider to switch away." }
        return "OpenRouter: key stored · activation model \(selectedOpenRouterModel()) · not selected. Next: test, then activate the selected model."
    }

    @objc func refreshOpenRouterModelsAction(_ sender: NSButton) { refreshOpenRouterModels() }

    func refreshOpenRouterModels() {
        guard !catalogRefreshInFlight else { return }
        catalogRefreshInFlight = true
        clearOpenRouterModels(reason: "Validating the saved credential before exposing models…")
        openRouterRefreshButton?.isEnabled = false
        openRouterCatalogStatus.stringValue = "Loading OpenRouter model catalog…"
        processClient.run(["codex-app", "openrouter-models", "--ids-only", "--json"], timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.catalogRefreshInFlight = false
            self.openRouterRefreshButton?.isEnabled = !self.busy
            guard let json = self.json(result.output) else {
                self.clearOpenRouterModels(reason: "Catalog unavailable · no model list is exposed. Next: reconnect the key or retry.")
                return
            }
            guard result.code == 0, json["ok"] as? Bool == true else {
                self.clearOpenRouterModels(reason: "Catalog unavailable · \(self.structuredPublicDetail(json, fallback: result.output, codePrefix: "E-OR")) No model list is exposed.")
                return
            }
            guard json["authenticated"] as? Bool == true else {
                self.clearOpenRouterModels(reason: "Credential validation failed · model and child-agent lists were withdrawn. Choose Reconnect OpenRouter credential.")
                return
            }
            let models = self.openRouterModelIds(json)
            guard !models.isEmpty else {
                self.clearOpenRouterModels(reason: "Authenticated catalog returned no selectable models · no model list is exposed.")
                return
            }
            self.openRouterCredentialValidatedNow = true
            self.openRouterModels = models
            self.openRouterModelPopup.removeAllItems()
            self.openRouterModelPopup.addItem(withTitle: "Choose from \(models.count) models…")
            self.openRouterModelPopup.addItems(withTitles: models)
            self.synchronizeOpenRouterPopupSelection()
            self.openRouterModelPopup.isEnabled = !self.busy
            self.openRouterCatalogStatus.stringValue = "Catalog ready · \(models.count) models · saved key authenticated. Selecting one copies its id into the editable field."
        }
    }

    private func clearOpenRouterModels(reason: String) {
        openRouterCredentialValidatedNow = false
        openRouterModels = []
        openRouterModelPopup.removeAllItems()
        openRouterModelPopup.addItem(withTitle: "Models hidden until credential validation")
        openRouterModelPopup.isEnabled = false
        openRouterModelField.stringValue = ""
        openRouterModelField.isEnabled = false
        openRouterCatalogStatus.stringValue = reason
        openRouterCatalogStatus.textColor = .systemOrange
    }

    private func openRouterModelIds(_ json: [String: Any]) -> [String] {
        let raw = (json["models"] as? [Any])
            ?? (json["data"] as? [Any])
            ?? ((json["catalog"] as? [String: Any])?["models"] as? [Any])
            ?? []
        let values = raw.compactMap { entry -> String? in
            if let value = entry as? String { return value }
            guard let row = entry as? [String: Any] else { return nil }
            return (row["id"] as? String) ?? (row["model"] as? String) ?? (row["slug"] as? String)
        }.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        return Array(Set(values)).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    @objc private func selectOpenRouterModel(_ sender: NSPopUpButton) {
        guard sender.indexOfSelectedItem > 0, let model = sender.titleOfSelectedItem else { return }
        openRouterModelSelectionPending = true
        openRouterActionRan = true
        openRouterModelField.stringValue = model
        openRouterStatus.stringValue = "Selected \(model) from the catalog. Next: test the connection; activation remains unchanged."
    }

    func controlTextDidChange(_ notification: Notification) {
        guard let field = notification.object as? NSTextField else { return }
        if field === openRouterModelField {
            openRouterModelSelectionPending = true
            openRouterActionRan = true
            synchronizeOpenRouterPopupSelection()
            openRouterStatus.stringValue = "Manual model selection changed. Next: test the connection; activation remains unchanged."
        } else if field === multiProvider.model {
            multiProvider.modelSelectionPending = true
            synchronizeMultiProviderPopupSelection()
            multiProvider.status.stringValue = "Manual routed model selection changed. Check the router before activation."
            multiProvider.status.textColor = .secondaryLabelColor
        }
    }

    private func synchronizeOpenRouterPopupSelection() {
        let current = selectedOpenRouterModel()
        if let index = openRouterModels.firstIndex(of: current) {
            openRouterModelPopup.selectItem(at: index + 1)
        } else {
            openRouterModelPopup.selectItem(at: 0)
        }
    }

    @objc func saveOpenRouterKey() {
        guard let window = view.window else { return }
        openRouterActionRan = true
        promptForSecretKey(
            window: window,
            sheetTitle: "OpenRouter API Key",
            sheetMessage: "Paste your OpenRouter API key. It is sent through stdin and never logged. Saving does not switch the active provider.",
            placeholder: "sk-or-…",
            args: ["codex-app", "set-openrouter-key", "--api-key-stdin", "--json"],
            kind: "openrouter-set-key",
            title: "Save OpenRouter key",
            credential: .openRouterApiKey,
            statusLabel: openRouterStatus,
            successSummary: "OpenRouter key saved",
            failSummary: "OpenRouter key save failed",
            codePrefix: "E-OR"
        )
    }

    @objc private func testOpenRouterConnection() {
        let model = selectedOpenRouterModel()
        openRouterActionRan = true
        guard !model.isEmpty else {
            openRouterStatus.stringValue = "Connection test blocked · model id is empty. Next: choose or enter a model."
            return
        }
        guard !busy else { openRouterStatus.stringValue = "Another provider action is already running."; return }
        guard let snapshot = operations.begin(kind: "openrouter-test", mutationGroup: nil, summary: "Test OpenRouter model") else {
            openRouterStatus.stringValue = "Another guarded mutation is already running. Wait or open Diagnostics."
            return
        }
        setBusy(true)
        openRouterStatus.stringValue = "Testing OpenRouter with \(model)…"
        _ = operations.update(snapshot, state: .running, stage: "testing", progress: nil, summary: "Test OpenRouter model")
        processClient.run(["codex-app", "openrouter-test", "--model", model, "--json"], timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.setBusy(false)
            let json = self.json(result.output)
            let ok = result.code == 0 && json?["ok"] as? Bool == true
            let status = json?["status"] as? String ?? (ok ? "connected" : "failed")
            let detail = self.structuredPublicDetail(json, fallback: result.output, codePrefix: "E-OR")
            _ = self.operations.update(snapshot, state: ok ? .succeeded : .failed, stage: "complete", progress: 1, summary: ok ? "OpenRouter connection ready" : "OpenRouter connection needs action")
            self.openRouterStatus.stringValue = ok
                ? "Connection test passed · \(model) · \(status). Next: activate it if you want it as the main model."
                : "Connection test failed · \(model) · \(status) · \(detail)"
            self.refreshOpenRouterStatus()
        }
    }

    @objc func useOpenRouter() {
        let model = selectedOpenRouterModel()
        openRouterActionRan = true
        guard !model.isEmpty else {
            openRouterStatus.stringValue = "Enter an OpenRouter model id, then click Activate Selected Model."
            return
        }
        guard !busy else { openRouterStatus.stringValue = "Another provider action is already running."; return }
        guard let window = view.window else { return }
        AlertFactory.confirmSheet(
            window: window,
            title: "Activate OpenRouter?",
            message: "\(model) becomes the Codex main model and Codex App restarts. SKS remaps the Desktop thread sidebar so prior provider chats stay listed, snapshots the previous provider for Restore, and merges the model cache instead of wiping it. Codex Desktop may still label third-party models as Custom.",
            destructive: false
        ) { [weak self] approved in
            guard let self = self, approved else { return }
            self.performUseOpenRouter(model: model)
        }
    }

    @objc func restorePreviousDesktopRouting() {
        openRouterActionRan = true
        guard !busy else { openRouterStatus.stringValue = "Another provider action is already running."; return }
        guard let window = view.window else { return }
        AlertFactory.confirmSheet(
            window: window,
            title: "Restore previous provider?",
            message: "Restores the last pre-OpenRouter Desktop provider/model/catalog snapshot, reverses sidebar remap when present, and restarts Codex App.",
            destructive: false
        ) { [weak self] approved in
            guard let self = self, approved else { return }
            self.performRestorePreviousDesktopRouting()
        }
    }

    private func performRestorePreviousDesktopRouting() {
        guard let snapshot = operations.begin(kind: "desktop-routing-restore", mutationGroup: "codex-config", summary: "Restore previous Desktop provider") else {
            openRouterStatus.stringValue = "Another guarded mutation is already running. Wait or open Diagnostics."
            return
        }
        setBusy(true)
        openRouterStatus.stringValue = "Restoring previous Desktop provider and restarting Codex App…"
        _ = operations.update(snapshot, state: .running, stage: "restoring", progress: nil, summary: "Restore previous Desktop provider")
        processClient.run(["codex-app", "restore-desktop-routing", "--restart-app", "--json"], timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.setBusy(false)
            let json = self.json(result.output)
            let ok = result.code == 0 && json?["ok"] as? Bool == true
            let status = json?["status"] as? String ?? (ok ? "restored" : "failed")
            let detail = self.structuredPublicDetail(json, fallback: result.output, codePrefix: "E-OR")
            // Routing rolls back before the sidebar retag, so a blocked retag is
            // partial success: the snapshot is kept and re-running finishes it.
            let sidebarBlocked = status.hasPrefix("restored_sidebar")
            _ = self.operations.update(snapshot, state: ok ? .succeeded : .failed, stage: "complete", progress: 1, summary: ok ? "Previous Desktop provider restored" : sidebarBlocked ? "Desktop provider restored; sidebar retag pending" : "Desktop provider restore needs action")
            self.openRouterStatus.stringValue = ok
                ? "Previous provider restored · \(status). Fully quit and reopen Codex App if chats or the picker still look stale."
                : sidebarBlocked
                    ? "Provider restored, but prior-provider chats stay hidden · fully quit Codex App, then run Restore previous provider again."
                    : "Restore failed · \(status) · \(detail)"
            self.refreshOpenRouterStatus()
            self.refresh()
        }
    }

    private func performUseOpenRouter(model: String) {
        guard openRouterCredentialValidatedNow else {
            openRouterStatus.stringValue = "Activation blocked · OpenRouter credential is not validated. Models remain hidden; choose Reconnect, then Refresh Models."
            return
        }
        guard let snapshot = beginProviderApply(kind: "openrouter-use", summary: "Use OpenRouter", mode: "openrouter", model: model) else {
            openRouterStatus.stringValue = "Another guarded mutation is already running. Wait or open Diagnostics."
            return
        }
        setBusy(true)
        openRouterStatus.stringValue = "Activating OpenRouter main model \(model) and restarting Codex App…"
        let running = operations.update(snapshot, state: .running, stage: "activating", progress: nil, summary: "Use OpenRouter")
        processClient.run(["codex-app", "use-openrouter", "--model", model, "--restart-app", "--json"], timeout: NativeView.mutationTimeout) { [weak self] activation in
            guard let self = self else { return }
            _ = self.operations.update(running, state: .running, stage: "verifying", progress: nil, summary: "Verify OpenRouter main model")
            self.processClient.run(["codex-app", "openrouter-status", "--json"], timeout: NativeView.statusTimeout) { [weak self] status in
                guard let self = self else { return }
                self.setBusy(false)
                let activationJson = self.json(activation.output)
                let statusJson = self.json(status.output)
                let selected = status.code == 0 && statusJson?["selected"] as? Bool == true
                let activeModel = statusJson?["model"] as? String
                let configApplied = activation.code == 0
                    && activationJson?["config_applied"] as? Bool == true
                    && selected
                    && activeModel == model
                if configApplied {
                    self.openRouterModelSelectionPending = false
                }
                let restartOK = activationJson?["restart_ok"] as? Bool == true
                let remapped = (activationJson?["thread_sidebar_remap"] as? [String: Any])?["remapped"] as? Int ?? 0
                let restoreAvailable = activationJson?["previous_routing_restore_available"] as? Bool == true
                var applyJson = activationJson ?? [:]
                applyJson["catalog_refreshed"] = status.code == 0
                    && statusJson?["key_validated"] as? Bool == true
                    && activeModel == model
                applyJson["new_session_ready"] = restartOK
                let applied = self.recordProviderApplyResult(
                    running,
                    json: applyJson,
                    configurationSaved: configApplied,
                    proxyApplied: selected && activeModel == model
                )
                let complete = configApplied && restartOK && applied.providerApply?.allSucceeded == true
                if complete {
                    var parts = ["Activation complete · OpenRouter is active · main model \(model)"]
                    if remapped > 0 { parts.append("sidebar kept \(remapped) prior-provider chats visible") }
                    if restoreAvailable { parts.append("Restore previous provider is available") }
                    parts.append("Desktop may still show Custom for third-party models")
                    self.openRouterStatus.stringValue = parts.joined(separator: " · ") + "."
                } else if configApplied {
                    self.openRouterStatus.stringValue = "Configuration saved · main model \(model) is selected, but Codex App did not restart. Next: reopen Codex App, then verify status."
                } else {
                    self.openRouterStatus.stringValue = "Activation incomplete · requested \(model), observed \(activeModel ?? "unknown") · \(self.structuredPublicDetail(activationJson, fallback: activation.output, codePrefix: "E-OR"))"
                }
                self.refreshOpenRouterStatus()
            }
        }
    }

    private func selectedOpenRouterModel() -> String {
        openRouterModelField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// One shared failure format: stable code · HTTP · transport · public message · Next: one action.
    /// `codePrefix` keeps codes honest per surface (E-LB / E-OR); the neutral default next-step keeps OpenRouter failures from advertising Codex LB recovery actions.
    func structuredPublicDetail(_ json: [String: Any]?, fallback: String, codePrefix: String = "E-LB", fallbackNext: String = "review the key, model id, and network, then retry") -> String {
        let code = publicFailureCode(json, codePrefix: codePrefix)
        let http = publicHttpStatus(json).map { "HTTP \($0)" }
        let transport = publicAuthTransport(json)
        let error = publicError(json)
        var parts: [String] = [code]
        if let http { parts.append(http) }
        if let transport { parts.append("transport \(transport)") }
        if let error, !error.isEmpty { parts.append(error) }
        if let blockers = json?["blockers"] as? [String], !blockers.isEmpty {
            parts.append(blockers.prefix(2).joined(separator: ", "))
        }
        let next = firstGuidance(json) ?? (json?["hint"] as? String) ?? fallbackNext
        return "\(parts.joined(separator: " · ")). Next: \(next)."
    }

    func publicFailureCode(_ json: [String: Any]?, codePrefix: String = "E-LB") -> String {
        let blockers = json?["blockers"] as? [String] ?? []
        let truth = json?["routing_truth"] as? [String: Any]
        let truthBlockers = truth?["blockers"] as? [String] ?? []
        let all = blockers + truthBlockers
        if all.contains(where: { $0.contains("auth_rejected") || $0.contains("gateway_auth_rejected") }) {
            return "\(codePrefix)-AUTH"
        }
        if all.contains(where: { $0.contains("unreachable") }) { return "\(codePrefix)-UNREACHABLE" }
        if all.contains(where: { $0.contains("legacy") && $0.contains("migration") }) { return "\(codePrefix)-LEGACY-MIGRATE" }
        if let http = publicHttpStatus(json), http >= 400 { return "\(codePrefix)-HTTP-\(http)" }
        if json == nil || json?["ok"] as? Bool == false { return "\(codePrefix)-FAILED" }
        return "\(codePrefix)-INFO"
    }

    func publicHttpStatus(_ json: [String: Any]?) -> Int? {
        if let value = json?["http_status"] as? Int { return value }
        if let value = (json?["http_status"] as? NSNumber)?.intValue { return value }
        let truth = json?["routing_truth"] as? [String: Any]
        if let value = truth?["http_status"] as? Int { return value }
        return (truth?["http_status"] as? NSNumber)?.intValue
    }

    func publicAuthTransport(_ json: [String: Any]?) -> String? {
        if let value = json?["gateway_auth_transport"] as? String, !value.isEmpty { return value }
        if let value = json?["auth_transport"] as? String, !value.isEmpty { return value }
        let truth = json?["routing_truth"] as? [String: Any]
        if let value = truth?["auth_transport"] as? String, !value.isEmpty { return value }
        return nil
    }

    func firstGuidance(_ json: [String: Any]?) -> String? {
        if let rows = json?["guidance"] as? [String] {
            return rows.first { !$0.isEmpty }
        }
        return nil
    }

    func publicError(_ json: [String: Any]?) -> String? {
        if let value = json?["error"] as? String { return value }
        guard let value = json?["error"] as? [String: Any] else { return nil }
        let code = value["code"] as? String
        let message = value["message"] as? String
        return [code, message].compactMap { $0 }.joined(separator: ": ")
    }

}
