import Cocoa

extension ProvidersViewController {
    func makeCombinedCatalogCard() -> NSBox {
        let refresh = NativeView.button("Refresh", target: self, action: #selector(refreshCombinedCatalog))
        let report = NativeView.button("Open Report", target: self, action: #selector(openCatalogReport))
        registerProviderAction(refresh, id: "sks-provider-refresh-catalog")
        registerProviderAction(report, id: "sks-provider-open-catalog-report")
        actionButtons += [refresh, report]
        let card = NativeView.card(title: "Combined Model Catalog", subtitle: "Codex-LB and OpenRouter catalogs activate atomically with one explicit route index. A failed build keeps the prior verified generation.", views: [catalogSyncStatus, ControlKit.actionRow([refresh, report])])
        card.setAccessibilityIdentifier("sks-provider-card-combined-catalog")
        return card
    }

    func makeRoutesCard() -> NSBox {
        let explain = NativeView.button("Explain Route", target: self, action: #selector(explainRoute))
        registerProviderAction(explain, id: "sks-provider-route-explain")
        actionButtons.append(explain)
        let card = NativeView.card(title: "Routes", subtitle: "Routes come only from the canonical model index or a validated session pin. Fallback is always none.", views: [routesStatus, NativeView.row([routeModelField, explain])])
        card.setAccessibilityIdentifier("sks-provider-card-routes")
        return card
    }

    func renderCombinedCatalog(_ json: [String: Any]) {
        let catalog = json["catalog_sync"] as? [String: Any]
        guard catalog?["schema"] as? String == "sks.combined-catalog-sync.v1",
              let data = try? JSONSerialization.data(withJSONObject: catalog as Any),
              let decoded = try? JSONDecoder().decode(CombinedCatalogSyncStatusV1.self, from: data),
              decoded.providers["codex-lb"]?.schema == "sks.catalog-sync-state.v2",
              decoded.providers["openrouter"]?.schema == "sks.catalog-sync-state.v2" else {
            catalogSyncStatus.stringValue = "Capability schema invalid · catalog_sync missing · capability_schema_invalid"
            catalogSyncStatus.textColor = .systemRed
            return
        }
        renderCatalogStatus(decoded)
    }

    func renderCatalogStatus(_ catalog: CombinedCatalogSyncStatusV1) {
        func providerText(_ id: String) -> String {
            guard let state = catalog.providers[id] else { return "invalid" }
            return state.modelCount.map(String.init) ?? state.state
        }
        let modelText = catalog.modelCount.map { " · \($0) models" } ?? ""
        let routeText = catalog.routeCount.map { " · \($0) routes" } ?? ""
        let conflictText = catalog.conflictCount > 0 ? " · \(catalog.conflictCount) conflicts" : ""
        let cause = catalog.blockers.first.map { " · \(ProviderSecretRedactor.redact($0))" } ?? ""
        let recovery = catalog.recoveryAction.flatMap(ProviderRecoveryAction.init(rawValue:)).map { " · recovery \($0.buttonTitle)" } ?? ""
        catalogSyncStatus.stringValue = "Combined catalog · \(catalog.state)\(modelText)\(routeText) · Codex-LB \(providerText("codex-lb")) / OpenRouter \(providerText("openrouter"))\(conflictText)\(cause)\(recovery)"
        switch catalog.state {
        case "verified": catalogSyncStatus.textColor = .systemGreen
        case "failed": catalogSyncStatus.textColor = .systemRed
        default: catalogSyncStatus.textColor = .systemOrange
        }
    }

    func renderRoutes(_ json: [String: Any]) {
        guard let routing = json["routing"] as? [String: Any],
              let policy = routing["policy"] as? [String: Any],
              policy["schema"] as? String == "sks.bridge-routing-policy.v1",
              policy["fallback"] as? String == "none" else {
            routesStatus.stringValue = "Routes · schema invalid or fallback is not none"
            routesStatus.textColor = .systemRed
            return
        }
        let provider = policy["default_provider_id"] as? String ?? "none"
        let generation = policy["policy_generation"] as? String ?? "unreported"
        let catalogGeneration = policy["catalog_generation"] as? String ?? "unreported"
        let pin = routing["session_pin"] as? [String: Any]
        let pinText = pin.map { "\($0["provider_id"] as? String ?? "invalid") / \($0["public_model"] as? String ?? "invalid")" } ?? "none"
        let selected = routing["selected_route"] as? [String: Any]
        let selectedModel = routing["selected_model"] as? String ?? "unknown"
        let selectedText = selected.map { "\(selectedModel) → \($0["provider_id"] as? String ?? "unknown")" } ?? "none"
        routesStatus.stringValue = "Default provider: \(provider) · selected model: \(selectedText) · session pin: \(pinText) · fallback: none · policy \(generation) · catalog \(catalogGeneration)"
        routesStatus.textColor = .secondaryLabelColor
    }

    @objc func refreshCombinedCatalog() {
        runCatalogCommand(["bridge", "catalog", "sync", "--json"], title: "Refresh combined catalog", mutationGroup: "codex-config")
    }

    @objc func openCatalogReport() {
        runCatalogCommand(["bridge", "catalog", "status", "--json"], title: "Load combined catalog report", mutationGroup: nil)
    }

    private func runCatalogCommand(_ args: [String], title: String, mutationGroup: String?) {
        guard !catalogRefreshInFlight, let snapshot = operations.begin(kind: "bridge-catalog", mutationGroup: mutationGroup, summary: title) else { return }
        catalogRefreshInFlight = true
        catalogSyncStatus.stringValue = "Combined catalog · syncing"
        _ = operations.update(snapshot, state: .running, stage: "catalog_sync", progress: nil, summary: title)
        processClient.run(args, timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.catalogRefreshInFlight = false
            guard let json = self.json(result.output) else {
                _ = self.operations.update(snapshot, state: .failed, stage: "complete", progress: 1, summary: "Catalog report schema invalid")
                self.catalogSyncStatus.stringValue = "Capability schema invalid · catalog_sync missing · capability_schema_invalid"
                self.catalogSyncStatus.textColor = .systemRed
                return
            }
            guard json["schema"] as? String == "sks.desktop-bridge-command-result.v1",
                  ["catalog.sync", "catalog.status"].contains(json["operation"] as? String ?? ""),
                  let statusJSON = json["status"] as? [String: Any],
                  let status = try? DesktopBridgeStatusV3Truth.decode(from: statusJSON) else {
                _ = self.operations.update(snapshot, state: .failed, stage: "complete", progress: 1, summary: "Catalog command envelope invalid")
                self.catalogSyncStatus.stringValue = "Capability schema invalid · current Desktop Bridge status missing"
                self.catalogSyncStatus.textColor = .systemRed
                return
            }
            self.renderCombinedCatalog(status.raw)
            let valid = !self.catalogSyncStatus.stringValue.contains("schema invalid")
            _ = self.operations.update(snapshot, state: valid ? .succeeded : .failed, stage: "complete", progress: 1, summary: valid ? "Catalog report generated" : "Catalog report schema invalid")
            self.refresh()
        }
    }

    @objc func explainRoute() {
        let model = routeModelField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !model.isEmpty, let snapshot = operations.begin(kind: "bridge-route-explain", mutationGroup: nil, summary: "Explain model route") else {
            routesStatus.stringValue = "Route explain blocked · choose an exact model from the combined catalog."
            routesStatus.textColor = .systemOrange
            return
        }
        routesStatus.stringValue = "Explaining \(model) through the explicit route index…"
        _ = operations.update(snapshot, state: .running, stage: "model_route", progress: nil, summary: "Explain model route")
        processClient.run(["bridge", "route", "explain", model, "--json"], timeout: NativeView.statusTimeout) { [weak self] result in
            guard let self = self else { return }
            let json = self.json(result.output)
            let explanation = json.flatMap(ProviderRouteExplanation.decode(from:))
            let explainedRoute = explanation.flatMap { explanation in
                explanation.fallback == "none"
                    ? "\(model) → \(explanation.providerId) / \(explanation.upstreamModel) · fallback none"
                    : nil
            }
            let valid = explainedRoute != nil
            _ = self.operations.update(snapshot, state: valid ? .succeeded : .failed, stage: "complete", progress: 1, summary: valid ? "Route explained" : "Route unavailable")
            self.routesStatus.stringValue = explainedRoute
                ?? "\(model) · route missing or ambiguous · no fallback · \(self.structuredPublicDetail(json, fallback: result.output, fallbackNext: "Refresh catalog or choose a supported model"))"
            self.routesStatus.textColor = valid ? .systemGreen : .systemRed
        }
    }
}
