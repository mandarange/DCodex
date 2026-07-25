import Cocoa

final class RoleModelControls {
    let role: String
    let model = NSPopUpButton()
    let reasoning = NSPopUpButton()
    let current = NativeView.detail("Current: loading…")
    let save: NSButton
    let reset: NSButton

    init(role: String, target: AnyObject) {
        self.role = role
        save = NativeView.button("Save", target: target, action: #selector(ProvidersViewController.saveRoleModel(_:)))
        reset = NativeView.button("Reset", target: target, action: #selector(ProvidersViewController.resetRoleModel(_:)))
        save.identifier = NSUserInterfaceItemIdentifier(role)
        reset.identifier = NSUserInterfaceItemIdentifier(role)
    }
}

// Role-scoped model overrides (Models by Work Type). Split from
// ProvidersOpenRouter.swift to keep both files inside the release line budget.
extension ProvidersViewController {
    func makeRoleModelsCard() -> NSBox {
        let definitions = [
            ("ui_implementer", "UI implementation"),
            ("native_app_specialist", "Native app"),
            ("implementation_specialist", "Implementation"),
            ("test_engineer", "Testing")
        ]
        var views: [NSView] = [roleStatus]
        for (role, title) in definitions {
            let controls = RoleModelControls(role: role, target: self)
            controls.model.addItem(withTitle: "Loading profiles…")
            controls.model.setAccessibilityLabel("\(title) model")
            controls.model.widthAnchor.constraint(greaterThanOrEqualToConstant: 210).isActive = true
            controls.model.identifier = NSUserInterfaceItemIdentifier(role)
            controls.model.target = self
            controls.model.action = #selector(roleModelSelectionChanged(_:))
            controls.reasoning.addItem(withTitle: "Loading…")
            controls.reasoning.setAccessibilityLabel("\(title) reasoning effort")
            controls.current.setAccessibilityLabel("\(title) current and effective model")
            controls.save.setAccessibilityLabel("Save \(title) model override")
            controls.reset.setAccessibilityLabel("Reset \(title) model override")
            controls.model.isEnabled = false
            controls.reasoning.isEnabled = false
            controls.save.isEnabled = false
            controls.reset.isEnabled = false
            roleRows[role] = controls
            actionButtons += [controls.save, controls.reset]

            let heading = NativeView.sectionTitle(title)
            let roleId = NativeView.detail(role)
            let modelLabel = NSTextField(labelWithString: "Model")
            let reasoningLabel = NSTextField(labelWithString: "Reasoning")
            views.append(NativeView.row([heading, roleId]))
            views.append(controls.current)
            views.append(NativeView.row([modelLabel, controls.model, reasoningLabel, controls.reasoning]))
            views.append(NativeView.row([controls.save, controls.reset]))
            if role != definitions.last?.0 { let separator = NSBox(); separator.boxType = .separator; views.append(separator) }
        }
        let refresh = NativeView.button("Refresh Role Settings", target: self, action: #selector(refreshRoleModelsAction(_:)))
        roleRefreshButton = refresh
        actionButtons.append(refresh)
        views.append(refresh)
        return NativeView.card(
            title: "Models by Work Type",
            subtitle: "Overrides apply only to the selected agent role. Without an override, new work inherits the active main model; if no main model is selected, the managed GPT role default is used. Multi-Provider Router catalog slugs let different roles use different upstream providers.",
            views: views
        )
    }

    @objc func refreshRoleModelsAction(_ sender: NSButton) {
        refreshRoleModels()
    }

    func refreshRoleModels() {
        guard !roleRefreshInFlight else { return }
        roleRefreshInFlight = true
        roleRefreshButton?.isEnabled = false
        roleStatus.stringValue = "Loading role model settings…"
        processClient.run(["codex-app", "role-models", "--json"], timeout: NativeView.statusTimeout) { [weak self] result in
            guard let self = self else { return }
            self.roleRefreshInFlight = false
            self.roleRefreshButton?.isEnabled = !self.busy
            // role-models exits 1 on recoverable preference blockers (an override
            // outside the active catalog, no router selected) while still returning
            // the full roles/supported_profiles payload. Gating on the exit code
            // would disable Reset — the only control that clears such an override.
            // A store-level blocker is different: the preference file could not be
            // read, so every save/reset fails closed and the controls must lock.
            let storeBlockers = (self.json(result.output)?["store_blockers"] as? [String] ?? [])
            guard let json = self.json(result.output), storeBlockers.isEmpty else {
                self.roleProfilesLoaded = false
                self.updateRoleControlAvailability()
                self.roleStatus.stringValue = storeBlockers.isEmpty
                    ? "Role settings unavailable · existing configuration was not changed."
                    : "Role settings unavailable · \(storeBlockers.joined(separator: ", ")) · existing configuration was not changed."
                return
            }
            let roleBlockers = (json["preference_blockers"] as? [String] ?? json["blockers"] as? [String] ?? []).joined(separator: ", ")
            self.configureSupportedRoleProfiles(json)
            var loaded = 0
            for (role, controls) in self.roleRows {
                guard let payload = self.rolePayload(json, role: role) else {
                    controls.current.stringValue = "Current: unavailable · Effective: unavailable"
                    continue
                }
                let configured = (payload["configured"] as? [String: Any]) ?? (payload["override"] as? [String: Any])
                let effective = (payload["effective"] as? [String: Any]) ?? payload
                let configuredModel = (configured?["model"] as? String) ?? (payload["configured_model"] as? String)
                let configuredReasoning = self.reasoningValue(configured) ?? (payload["configured_reasoning"] as? String)
                let configuredProvider = (configured?["provider"] as? String) ?? (payload["configured_provider"] as? String)
                let defaultModel = payload["default_model"] as? String
                let defaultReasoning = payload["default_reasoning_effort"] as? String
                let effectiveModel = (effective["model"] as? String) ?? (payload["effective_model"] as? String) ?? "unavailable"
                let effectiveProvider = (effective["provider"] as? String)
                    ?? (payload["effective_provider"] as? String)
                    ?? "unknown"
                let effectiveReasoning = self.reasoningValue(effective)
                    ?? (payload["effective_reasoning_effort"] as? String)
                    ?? (payload["effective_reasoning"] as? String)
                    ?? "unavailable"
                let effectiveSource = payload["effective_source"] as? String
                let editorModel = configuredModel ?? (effectiveSource == "selected-main-model" ? effectiveModel : (defaultModel ?? effectiveModel))
                let editorReasoning = configuredReasoning ?? (effectiveSource == "selected-main-model" ? effectiveReasoning : (defaultReasoning ?? effectiveReasoning))
                self.selectRoleProfile(model: editorModel, reasoning: editorReasoning, controls: controls)
                let current = configuredModel.map {
                    "\(self.roleModelDisplay(provider: configuredProvider ?? effectiveProvider, model: $0)) / \(configuredReasoning ?? "default")"
                } ?? "default (no override)"
                let effectiveDisplay = self.roleModelDisplay(provider: effectiveProvider, model: effectiveModel)
                let inherited = effectiveSource == "selected-main-model" ? " · inherits active main model" : ""
                controls.current.stringValue = "Current: \(current) · Effective: \(effectiveDisplay) / \(effectiveReasoning)\(inherited)"
                loaded += 1
            }
            self.roleProfilesLoaded = !self.supportedRoleProfiles.isEmpty
            self.updateRoleControlAvailability()
            self.roleStatus.stringValue = roleBlockers.isEmpty
                ? "Loaded \(loaded) of \(self.roleRows.count) role settings. Save creates an override; Reset removes it."
                : "Loaded \(loaded) of \(self.roleRows.count) role settings · needs attention: \(roleBlockers). Reset removes an override."
        }
    }

    func updateRoleControlAvailability() {
        let enabled = !busy && roleProfilesLoaded
        for controls in roleRows.values {
            controls.model.isEnabled = enabled
            controls.reasoning.isEnabled = enabled
            controls.save.isEnabled = enabled
            controls.reset.isEnabled = enabled
        }
    }

    private func configureSupportedRoleProfiles(_ json: [String: Any]) {
        let rows = json["supported_profiles"] as? [[String: Any]] ?? []
        supportedRoleProfiles = rows.compactMap { row in
            guard let model = row["model"] as? String,
                  let reasoning = row["reasoning_effort"] as? String,
                  !model.isEmpty, !reasoning.isEmpty else { return nil }
            return (model, reasoning)
        }
        let models = Array(Set(supportedRoleProfiles.map(\.model))).sorted()
        for controls in roleRows.values {
            controls.model.removeAllItems()
            controls.model.addItems(withTitles: models)
            controls.reasoning.removeAllItems()
        }
    }

    private func rolePayload(_ json: [String: Any], role: String) -> [String: Any]? {
        if let roles = json["roles"] as? [String: Any], let payload = roles[role] as? [String: Any] { return payload }
        if let payload = json[role] as? [String: Any] { return payload }
        if let roles = json["roles"] as? [[String: Any]] {
            return roles.first { ($0["role"] as? String) == role || ($0["id"] as? String) == role }
        }
        return nil
    }

    private func reasoningValue(_ json: [String: Any]?) -> String? {
        (json?["reasoning"] as? String) ?? (json?["reasoning_effort"] as? String) ?? (json?["model_reasoning_effort"] as? String)
    }

    private func roleModelDisplay(provider: String, model: String) -> String { model.contains("/") ? model : "\(provider):\(model)" }

    private func selectRoleProfile(model: String, reasoning: String, controls: RoleModelControls) {
        if !controls.model.itemTitles.contains(model) {
            controls.model.addItem(withTitle: model)
        }
        controls.model.selectItem(withTitle: model)
        updateReasoningChoices(controls, preferred: reasoning)
    }

    @objc private func roleModelSelectionChanged(_ sender: NSPopUpButton) {
        guard let role = sender.identifier?.rawValue, let controls = roleRows[role] else { return }
        updateReasoningChoices(controls, preferred: nil)
    }

    private func updateReasoningChoices(_ controls: RoleModelControls, preferred: String?) {
        let model = controls.model.titleOfSelectedItem ?? ""
        var efforts = supportedRoleProfiles.filter { $0.model == model }.map(\.reasoning)
        if let preferred = preferred, !preferred.isEmpty, !efforts.contains(preferred) {
            efforts.append(preferred)
        }
        controls.reasoning.removeAllItems()
        controls.reasoning.addItems(withTitles: efforts)
        if let preferred = preferred, efforts.contains(preferred) { controls.reasoning.selectItem(withTitle: preferred) }
    }

    @objc func saveRoleModel(_ sender: NSButton) {
        guard let role = sender.identifier?.rawValue, let controls = roleRows[role] else { return }
        let model = controls.model.titleOfSelectedItem ?? ""
        let reasoning = controls.reasoning.titleOfSelectedItem ?? "medium"
        guard !model.isEmpty else { roleStatus.stringValue = "Save blocked for \(role) · enter a model id."; return }
        runRoleMutation(
            ["codex-app", "set-role-model", "--role", role, "--model", model, "--reasoning", reasoning, "--json"],
            role: role,
            kind: "role-model-set",
            running: "Saving \(role) override…",
            success: "Saved \(role) · \(model) / \(reasoning). Next: new tasks for this role use the effective override."
        )
    }

    @objc func resetRoleModel(_ sender: NSButton) {
        guard let role = sender.identifier?.rawValue else { return }
        runRoleMutation(
            ["codex-app", "reset-role-model", "--role", role, "--json"],
            role: role,
            kind: "role-model-reset",
            running: "Resetting \(role) override…",
            success: "Reset \(role). Next: new tasks use the effective default shown below."
        )
    }

    private func runRoleMutation(_ args: [String], role: String, kind: String, running: String, success: String) {
        guard !busy else { roleStatus.stringValue = "Another provider action is already running."; return }
        guard let snapshot = operations.begin(kind: kind, mutationGroup: "codex-config", summary: running) else {
            roleStatus.stringValue = "Another guarded mutation is already running. Wait or open Diagnostics."
            return
        }
        setBusy(true)
        roleStatus.stringValue = running
        _ = operations.update(snapshot, state: .running, stage: "saving", progress: nil, summary: running)
        processClient.run(args, timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.setBusy(false)
            let json = self.json(result.output)
            let ok = result.code == 0 && json?["ok"] as? Bool == true
            _ = self.operations.update(snapshot, state: ok ? .succeeded : .failed, stage: "complete", progress: 1, summary: ok ? "Role model setting saved" : "Role model setting needs action")
            self.roleStatus.stringValue = ok ? success : "\(role) change failed · \(self.structuredPublicDetail(json, fallback: result.output))"
            self.refreshRoleModels()
        }
    }
}
