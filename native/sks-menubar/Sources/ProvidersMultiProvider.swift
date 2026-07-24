import Cocoa

final class MultiProviderRouterControls {
    let baseURL: NSTextField = {
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.placeholderString = "http://127.0.0.1:10100/v1"
        field.stringValue = "http://127.0.0.1:10100/v1"
        field.setAccessibilityLabel("Multi-provider router base URL")
        field.setAccessibilityHelp("Only loopback HTTP or HTTPS endpoints ending in /v1 are accepted.")
        field.toolTip = "Loopback only: localhost, 127.0.0.1, or ::1, ending in /v1."
        return field
    }()
    let catalogPath: NSTextField = {
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 340, height: 24))
        field.placeholderString = "~/.codex/opencodex-catalog.json"
        field.stringValue = "~/.codex/opencodex-catalog.json"
        field.setAccessibilityLabel("Codex multi-provider model catalog path")
        field.setAccessibilityHelp("OpenCodex writes this owner-only Codex catalog. Other routers must export a complete Codex ModelInfo catalog.")
        field.toolTip = "OpenCodex default: $CODEX_HOME/opencodex-catalog.json"
        return field
    }()
    let model: NSTextField = {
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.placeholderString = "anthropic/claude-sonnet"
        field.setAccessibilityLabel("Multi-provider router model slug")
        field.setAccessibilityPlaceholderValue("provider/model")
        field.setAccessibilityHelp("Enter an exact model slug from the configured Codex catalog.")
        return field
    }()
    let modelPopup = NSPopUpButton()
    let status: NSTextField = {
        let field = NativeView.detail("Multi-provider router status has not loaded yet.")
        field.setAccessibilityLabel("Multi-provider router status")
        return field
    }()
    weak var refreshButton: NSButton?
    var models: [String] = []
    var refreshInFlight = false
    var modelSelectionPending = false
}

extension ProvidersViewController {
    func makeMultiProviderRouterCard() -> NSBox {
        multiProvider.model.delegate = self
        multiProvider.modelPopup.addItem(withTitle: "Choose from catalog…")
        multiProvider.modelPopup.target = self
        multiProvider.modelPopup.action = #selector(selectMultiProviderModel(_:))
        multiProvider.modelPopup.setAccessibilityLabel("Multi-provider routed model catalog")
        multiProvider.modelPopup.setAccessibilityHelp("Choose an exact provider/model slug from the active Codex catalog.")
        multiProvider.modelPopup.widthAnchor.constraint(greaterThanOrEqualToConstant: 280).isActive = true
        multiProvider.modelPopup.isEnabled = false

        let refresh = NativeView.button("Refresh Router", target: self, action: #selector(refreshMultiProviderRouterAction(_:)))
        let test = NativeView.button("Check Router", target: self, action: #selector(testMultiProviderRouter))
        let activate = NativeView.button("Configure Router Model", target: self, action: #selector(useMultiProviderRouter))
        refresh.setAccessibilityLabel("Refresh multi-provider router and catalog status")
        test.setAccessibilityLabel("Check the loopback multi-provider router")
        activate.setAccessibilityLabel("Configure the selected routed model and restart Codex App")
        test.setAccessibilityHelp("Checks that the selected model exists in both the local catalog and the live loopback router. No configuration is changed.")
        activate.setAccessibilityHelp("Validates the loopback router, writes its provider and catalog settings to Codex config, and restarts Codex App. Runtime adoption still requires a live Codex check.")
        multiProvider.refreshButton = refresh
        actionButtons += [refresh, test, activate]

        let routerLabel = NSTextField(labelWithString: "Router URL")
        let catalogLabel = NSTextField(labelWithString: "Catalog")
        let modelsLabel = NSTextField(labelWithString: "Models")
        let modelLabel = NSTextField(labelWithString: "Model slug")
        for label in [routerLabel, catalogLabel, modelsLabel, modelLabel] {
            label.setContentHuggingPriority(.required, for: .horizontal)
        }
        let security = NativeView.detail(
            "Security: only loopback HTTP(S) /v1 endpoints are accepted. SKS Control Center does not accept or store router credentials; keep upstream credentials inside the local router."
        )
        security.setAccessibilityLabel("Multi-provider router security")
        let setup = NativeView.detail(
            "OpenCodex setup: run ocx start, then ensure the catalog stamps multi_agent_version = \"v2\" on routed models. If OpenCodex chose a fallback port, replace 10100 with the live port reported by ocx status."
        )
        setup.setAccessibilityLabel("OpenCodex multi-provider setup guidance")

        return NativeView.card(
            title: "Multi-Provider Router",
            subtitle: "Connects Codex to one local Responses router, such as OpenCodex. Multi-agent v2 catalog slugs (multi_agent_version = \"v2\") can then be assigned to different agent roles.",
            views: [
                security,
                setup,
                multiProvider.status,
                NativeView.row([routerLabel, multiProvider.baseURL]),
                NativeView.row([catalogLabel, multiProvider.catalogPath]),
                NativeView.row([modelsLabel, multiProvider.modelPopup, refresh]),
                NativeView.row([modelLabel, multiProvider.model]),
                NativeView.row([test, activate])
            ]
        )
    }

    func setMultiProviderRouterBusy(_ value: Bool) {
        multiProvider.baseURL.isEnabled = !value
        multiProvider.catalogPath.isEnabled = !value
        multiProvider.model.isEnabled = !value
        multiProvider.modelPopup.isEnabled = !value && !multiProvider.models.isEmpty
        multiProvider.refreshButton?.isEnabled = !value && !multiProvider.refreshInFlight
    }

    @objc func refreshMultiProviderRouterAction(_ sender: NSButton) {
        refreshMultiProviderRouterStatus()
    }

    func refreshMultiProviderRouterStatus() {
        guard !multiProvider.refreshInFlight else { return }
        multiProvider.refreshInFlight = true
        multiProvider.refreshButton?.isEnabled = false
        if !busy { multiProvider.status.stringValue = "Checking multi-provider router and catalog…" }
        processClient.run(["codex-app", "router-status", "--json"], timeout: NativeView.statusTimeout) { [weak self] result in
            guard let self = self else { return }
            self.multiProvider.refreshInFlight = false
            self.multiProvider.refreshButton?.isEnabled = !self.busy
            guard let json = self.json(result.output) else {
                if !self.busy {
                    self.multiProvider.status.stringValue = "Router status unavailable · no configuration was changed."
                    self.multiProvider.status.textColor = .systemOrange
                }
                self.setMultiProviderRouterBusy(self.busy)
                return
            }
            if let baseURL = json["base_url"] as? String, !baseURL.isEmpty {
                self.multiProvider.baseURL.stringValue = baseURL
            }
            if let catalogPath = json["catalog_path"] as? String, !catalogPath.isEmpty {
                self.multiProvider.catalogPath.stringValue = catalogPath
            }
            let models = (json["models"] as? [String]) ?? []
            self.multiProvider.models = models
            self.multiProvider.modelPopup.removeAllItems()
            self.multiProvider.modelPopup.addItem(withTitle: models.isEmpty ? "Catalog has no models" : "Choose from \(models.count) models…")
            if !models.isEmpty { self.multiProvider.modelPopup.addItems(withTitles: models) }
            if let activeModel = json["active_model"] as? String,
               !activeModel.isEmpty,
               !self.multiProvider.modelSelectionPending,
               self.multiProvider.model.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                self.multiProvider.model.stringValue = activeModel
            }
            self.synchronizeMultiProviderPopupSelection()
            let selected = json["selected"] as? Bool == true
            self.routerSelectedNow = selected
            self.routerActiveModel = (json["active_model"] as? String) ?? ""
            self.renderActiveProviderSummary()
            let providerReady = json["provider_contract_ok"] as? Bool == true
            let catalog = json["catalog"] as? [String: Any]
            let catalogReady = catalog?["ok"] as? Bool == true
            let activeModel = json["active_model"] as? String ?? "unset"
            let modelCount = json["model_count"] as? Int ?? models.count
            let truncated = json["models_truncated"] as? Bool == true
            let modelSummary = truncated
                ? "\(models.count) of \(modelCount) catalog models shown"
                : "\(modelCount) catalog models available"
            let state = json["status"] as? String ?? "unknown"
            let ownership = json["routing_ownership"] as? [String: Any]
            let ownershipClass = ownership?["classification"] as? String ?? ""
            let desktopPicker = json["desktop_picker"] as? [String: Any]
            let cacheInvalidated = desktopPicker?["models_cache_invalidated"] as? Bool == true
            let restartRecommended = desktopPicker?["restart_recommended"] as? Bool == true
            if !self.busy {
                var suffix = ""
                if ownershipClass == "opencodex_design_b" {
                    suffix += " · OpenCodex Design B owns openai_base_url (do not overwrite without --force-routing-override)"
                } else if !ownershipClass.isEmpty && ownershipClass != "sks_router" && ownershipClass != "unconfigured" {
                    suffix += " · routing owner: \(ownershipClass)"
                }
                if restartRecommended {
                    suffix += cacheInvalidated
                        ? " · Desktop models cache marked stale; restart Codex App if the picker is still old"
                        : " · restart Codex App after catalog changes so the Desktop picker refreshes"
                }
                if selected && providerReady && catalogReady {
                    self.multiProvider.status.stringValue = "Router configured · \(activeModel) · \(modelSummary). Runtime adoption is not verified here.\(suffix)"
                    self.multiProvider.status.textColor = .systemGreen
                } else if providerReady && catalogReady {
                    self.multiProvider.status.stringValue = "Router definition ready, not selected · \(modelSummary). Choose a model and configure when ready.\(suffix)"
                    self.multiProvider.status.textColor = .secondaryLabelColor
                } else {
                    self.multiProvider.status.stringValue = "Router \(state.replacingOccurrences(of: "_", with: " ")) · \(self.multiProviderPublicDetail(json, fallback: result.output))\(suffix)"
                    self.multiProvider.status.textColor = .systemOrange
                }
            }
            self.setMultiProviderRouterBusy(self.busy)
        }
    }

    @objc private func selectMultiProviderModel(_ sender: NSPopUpButton) {
        guard sender.indexOfSelectedItem > 0, let model = sender.titleOfSelectedItem else { return }
        multiProvider.modelSelectionPending = true
        multiProvider.model.stringValue = model
        multiProvider.status.stringValue = "Selected \(model). Check the router before activation."
        multiProvider.status.textColor = .secondaryLabelColor
    }

    @objc func testMultiProviderRouter() {
        let values = multiProviderRouterInput()
        guard !values.model.isEmpty else {
            multiProvider.status.stringValue = "Router check blocked · choose or enter a provider/model catalog slug."
            multiProvider.status.textColor = .systemOrange
            return
        }
        guard !busy else { multiProvider.status.stringValue = "Another provider action is already running."; return }
        guard let snapshot = operations.begin(kind: "multi-provider-router-test", mutationGroup: nil, summary: "Check multi-provider router") else {
            multiProvider.status.stringValue = "Another guarded mutation is already running. Wait or open Diagnostics."
            return
        }
        setBusy(true)
        multiProvider.status.stringValue = "Checking \(values.model) through the loopback router…"
        _ = operations.update(snapshot, state: .running, stage: "testing", progress: nil, summary: "Check multi-provider router")
        processClient.run([
            "codex-app", "router-test",
            "--base-url", values.baseURL,
            "--catalog", values.catalogPath,
            "--model", values.model,
            "--json"
        ], timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.setBusy(false)
            let json = self.json(result.output)
            let ok = result.code == 0 && json?["ok"] as? Bool == true
            _ = self.operations.update(snapshot, state: ok ? .succeeded : .failed, stage: "complete", progress: 1, summary: ok ? "Multi-provider router ready" : "Multi-provider router needs action")
            self.multiProvider.status.stringValue = ok
                ? "Router check passed · \(values.model) is present in both the Codex catalog and live router."
                : "Router check failed · \(self.multiProviderPublicDetail(json, fallback: result.output))"
            self.multiProvider.status.textColor = ok ? .systemGreen : .systemOrange
        }
    }

    @objc func useMultiProviderRouter() {
        let values = multiProviderRouterInput()
        guard !values.model.isEmpty else {
            multiProvider.status.stringValue = "Configuration blocked · choose or enter a provider/model catalog slug."
            multiProvider.status.textColor = .systemOrange
            return
        }
        guard !busy else { multiProvider.status.stringValue = "Another provider action is already running."; return }
        guard let window = view.window else { return }
        AlertFactory.confirmSheet(
            window: window,
            title: "Configure Router Model?",
            message: "\(values.model) becomes the routed Codex main model and Codex App restarts.",
            destructive: false
        ) { [weak self] approved in
            guard let self = self, approved else { return }
            self.performUseMultiProviderRouter(values: values)
        }
    }

    private func performUseMultiProviderRouter(values: (baseURL: String, catalogPath: String, model: String)) {
        guard let snapshot = operations.begin(kind: "multi-provider-router-use", mutationGroup: "codex-config", summary: "Configure multi-provider router") else {
            multiProvider.status.stringValue = "Another guarded mutation is already running. Wait or open Diagnostics."
            return
        }
        setBusy(true)
        multiProvider.status.stringValue = "Validating and configuring \(values.model), then restarting Codex App…"
        _ = operations.update(snapshot, state: .running, stage: "configuring", progress: nil, summary: "Configure multi-provider router")
        processClient.run([
            "codex-app", "use-router",
            "--base-url", values.baseURL,
            "--catalog", values.catalogPath,
            "--model", values.model,
            "--restart-app",
            "--json"
        ], timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.setBusy(false)
            let json = self.json(result.output)
            let applied = json?["config_applied"] as? Bool == true
            let restarted = json?["restart_completed"] as? Bool == true
            let ok = result.code == 0 && json?["ok"] as? Bool == true && applied && restarted
            _ = self.operations.update(snapshot, state: ok ? .succeeded : .failed, stage: "complete", progress: 1, summary: ok ? "Multi-provider router configured" : applied ? "Router configured; restart needs action" : "Router configuration needs action")
            if ok {
                let desktopPicker = json?["desktop_picker"] as? [String: Any]
                let cacheNote = desktopPicker?["models_cache_invalidated"] as? Bool == true
                    ? " Desktop models cache was marked stale."
                    : ""
                self.multiProvider.status.stringValue = "Configuration saved and Codex App restarted · \(values.model).\(cacheNote) Run a live Codex turn before treating runtime adoption as verified."
                self.multiProvider.status.textColor = .systemGreen
            } else if applied {
                let desktopPicker = json?["desktop_picker"] as? [String: Any]
                let cacheNote = desktopPicker?["models_cache_invalidated"] as? Bool == true
                    ? " Desktop models cache was marked stale."
                    : ""
                self.multiProvider.status.stringValue = "Router configuration saved, but Codex App did not restart.\(cacheNote) Reopen the app, then refresh status."
                self.multiProvider.status.textColor = .systemOrange
            } else {
                self.multiProvider.status.stringValue = "Router configuration failed · \(self.multiProviderPublicDetail(json, fallback: result.output))"
                self.multiProvider.status.textColor = .systemOrange
            }
            if applied {
                self.multiProvider.modelSelectionPending = false
            }
            self.refreshMultiProviderRouterStatus()
            self.refreshRoleModels()
        }
    }

    func synchronizeMultiProviderPopupSelection() {
        let current = multiProvider.model.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if let index = multiProvider.models.firstIndex(of: current) {
            multiProvider.modelPopup.selectItem(at: index + 1)
        } else {
            multiProvider.modelPopup.selectItem(at: 0)
        }
    }

    private func multiProviderRouterInput() -> (baseURL: String, catalogPath: String, model: String) {
        (
            multiProvider.baseURL.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
            multiProvider.catalogPath.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
            multiProvider.model.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    private func multiProviderPublicDetail(_ json: [String: Any]?, fallback: String) -> String {
        if let blockers = json?["blockers"] as? [String], !blockers.isEmpty {
            return "Reason: \(blockers.joined(separator: ", ").replacingOccurrences(of: "_", with: " "))."
        }
        if let hint = json?["hint"] as? String, !hint.isEmpty { return "Next: \(hint)." }
        return "Next: \(NativeView.redactPreview(fallback))"
    }
}
