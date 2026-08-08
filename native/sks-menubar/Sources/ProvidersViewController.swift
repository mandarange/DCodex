import Cocoa

enum ProviderStatusColor {
    static func forState(_ state: String) -> NSColor {
        switch state {
        case "verified", "ready": return .systemGreen
        case "running": return .systemBlue
        case "failed", "blocked", "rejected", "unavailable": return .systemRed
        case "degraded", "stale", "available_unverified", "configured_unverified": return .systemOrange
        case "not_attempted", "unsupported": return .secondaryLabelColor
        default: return .secondaryLabelColor
        }
    }
}

final class ProvidersViewController: NSViewController, ControlCenterPage, NSTextFieldDelegate {
    let processClient: ProcessClient
    let operations: OperationCoordinator

    // The five product cards use these concrete status surfaces.
    let providerStatus = NativeView.detail("Desktop Bridge status has not loaded.")
    let bridgeServiceStatus = NativeView.detail("Service: checking…")
    let bridgeHttpStatus = NativeView.detail("HTTP probe: not attempted")
    let bridgeWebSocketStatus = NativeView.detail("WebSocket probe: not attempted")
    let cliProviderStatus = NativeView.detail("Codex-LB profile: checking…")
    let openRouterCredentialStatus = NativeView.detail("OpenRouter profile: checking…")
    let catalogSyncStatus = NativeView.detail("Combined catalog: checking required v3 state…")
    let routesStatus = NativeView.detail("Routes: checking explicit route policy…")
    let capabilityStatus = NativeView.detail("Capabilities have not been verified.")
    let capabilityLastCheckedStatus = NativeView.detail("Last feature check: never")
    let capabilityStack = NSStackView()
    var capabilityFilterButton: NSButton!
    let routeModelField: NSTextField = {
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 250, height: 24))
        field.placeholderString = "Select or enter an exact catalog model"
        field.setAccessibilityLabel("Model to explain through the explicit route index")
        field.setAccessibilityIdentifier("sks-provider-route-model")
        return field
    }()

    let codexLbKeychainStatus = NativeView.detail("Codex-LB credential: checking Keychain without UI…")
    let openRouterKeychainStatus = NativeView.detail("OpenRouter credential: checking Keychain without UI…")
    let oauthCredentialStatus = NativeView.detail("ChatGPT OAuth: checking Codex-owned identity…")
    let globalSpinner = NativeView.spinner(label: "Provider operation in progress")
    var capabilityRows: [String: NSTextField] = [:]
    var actionButtons: [NSButton] = []
    var catalogRefreshInFlight = false
    var busy = false
    let keychainStore = SKSKeychainStore()

    var providerButtons: [String: [NSButton]] = [:]
    var providerActionInFlight = Set<String>()
    var responseGate = ProviderResponseGate()
    var lastCapabilityReport: DesktopCapabilityReportV3?
    var lastDiagnosticMetadata: DiagnosticOperationMetadata?
    var lastStatusCheckedAt: Date?
    var lastStatusCorrelationId: String?
    var providerEnabled = ["codex-lb": false, "openrouter": false]
    var showAllCapabilities = false

    init(processClient: ProcessClient, operations: OperationCoordinator) {
        self.processClient = processClient; self.operations = operations
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { nil }

    override func loadView() {
        capabilityStack.orientation = .vertical
        capabilityStack.alignment = .width
        capabilityStack.spacing = 6
        capabilityStack.setAccessibilityIdentifier("sks-provider-capability-matrix")
        providerStatus.setAccessibilityIdentifier("sks-provider-bridge-runtime-status")
        bridgeServiceStatus.setAccessibilityIdentifier("sks-provider-bridge-service-status")
        bridgeHttpStatus.setAccessibilityIdentifier("sks-provider-bridge-http-status")
        bridgeWebSocketStatus.setAccessibilityIdentifier("sks-provider-bridge-websocket-status")
        cliProviderStatus.setAccessibilityIdentifier("sks-provider-codex-lb-status")
        openRouterCredentialStatus.setAccessibilityIdentifier("sks-provider-openrouter-status")
        catalogSyncStatus.setAccessibilityIdentifier("sks-provider-combined-catalog-status")
        routesStatus.setAccessibilityIdentifier("sks-provider-routes-status")

        view = NativeView.page([
            NativeView.row([NativeView.title("Providers & Models"), globalSpinner]),
            NativeView.detail("One managed Desktop Bridge routes through independent Codex-LB and OpenRouter profiles. ChatGPT OAuth remains Codex-owned; no silent provider fallback is allowed."),
            makeDesktopBridgeCard(),
            makeProviderCredentialsCard(),
            makeCombinedCatalogCard(),
            makeRoutesCard(),
            makeCapabilityMatrixCard()
        ])
    }

    func refreshOnAppear() { refresh() }

    private func makeDesktopBridgeCard() -> NSBox {
        let repair = NativeView.button("Repair", target: self, action: #selector(repairDesktopBridge))
        let transport = NativeView.button("Verify Transport", target: self, action: #selector(verifyTransport))
        let deep = NativeView.button("Verify Deep", target: self, action: #selector(verifyDeep))
        registerProviderAction(repair, id: "sks-provider-bridge-repair")
        registerProviderAction(transport, id: "sks-provider-verify-transport")
        registerProviderAction(deep, id: "sks-provider-verify-deep")
        actionButtons += [repair, transport, deep]
        let card = NativeView.card(title: "Desktop Bridge", subtitle: "Single managed loopback runtime. HTTP and WebSocket upgrade/protocol/frame facts remain separate.", views: [providerStatus, bridgeServiceStatus, bridgeHttpStatus, bridgeWebSocketStatus, ControlKit.actionRow([repair, transport, deep])])
        card.setAccessibilityIdentifier("sks-provider-card-desktop-bridge")
        return card
    }

    private func makeCapabilityMatrixCard() -> NSBox {
        capabilityFilterButton = NativeView.button("Show All Capabilities", target: self, action: #selector(toggleCapabilityFilter))
        capabilityFilterButton.setAccessibilityIdentifier("sks-provider-capability-filter")
        let card = NativeView.card(title: "Capability Matrix", subtitle: "Issues are shown first. Expand the verified and not-attempted rows only when you need the full diagnostic trace.", views: [capabilityStatus, capabilityLastCheckedStatus, ControlKit.actionRow([capabilityFilterButton]), capabilityStack])
        card.setAccessibilityIdentifier("sks-provider-card-capability-matrix")
        return card
    }

    func setBusy(_ value: Bool) {
        busy = value
        for button in actionButtons where !providerButtons.values.flatMap({ $0 }).contains(where: { $0 === button }) { button.isEnabled = !value }
        value ? globalSpinner.startAnimation(nil) : globalSpinner.stopAnimation(nil)
    }

    func setProviderActionBusy(_ providerId: String, _ value: Bool) {
        if value { providerActionInFlight.insert(providerId) } else { providerActionInFlight.remove(providerId) }
        providerButtons[providerId]?.forEach { $0.isEnabled = !value }
        if providerActionInFlight.isEmpty { globalSpinner.stopAnimation(nil) } else { globalSpinner.startAnimation(nil) }
    }

    func refresh() {
        refreshCredentialHealth()
        processClient.run(["bridge", "status", "--json"], timeout: NativeView.statusTimeout) { [weak self] result in
            guard let self = self, let json = self.json(result.output),
                  let status = try? DesktopBridgeStatusV3Truth.decode(from: json),
                  let checkedAt = SKSTimestamp.date(from: status.checkedAt) else {
                self?.providerStatus.stringValue = "Desktop Bridge status unavailable · no readiness was assumed."
                self?.providerStatus.textColor = .systemRed
                return
            }
            if let previous = self.lastStatusCheckedAt {
                guard checkedAt > previous || checkedAt == previous && status.correlationId == self.lastStatusCorrelationId else { return }
            }
            self.lastStatusCheckedAt = checkedAt
            self.lastStatusCorrelationId = status.correlationId
            self.renderBridgeStatus(status.raw)
            self.renderProviderProfiles(status.raw)
            self.renderCombinedCatalog(status.raw)
            self.renderRoutes(status.raw)
            if let report = status.capabilities, self.statusReportMayMerge(report) {
                self.renderCapabilityReport(report)
            }
        }
    }

    private func renderBridgeStatus(_ json: [String: Any]) {
        let management = json["management"] as? [String: Any]
        let runtime = management?["runtime"] as? String
        let state = management?["state"] as? String ?? "blocked"
        guard runtime == "desktop-bridge" else {
            providerStatus.stringValue = "Desktop Bridge · blocked · managed runtime state missing"
            providerStatus.textColor = .systemRed; return
        }
        providerStatus.stringValue = "Runtime: \(state) · desktop-bridge · last verified \(json["checked_at"] as? String ?? "never")"
        providerStatus.textColor = state == "ready" ? .systemGreen : (state == "blocked" ? .systemRed : .systemOrange)
        let service = json["service"] as? [String: Any]
        bridgeServiceStatus.stringValue = "Service: installed \(yesNo(service?["installed"])) · loaded \(yesNo(service?["loaded"])) · running \(yesNo(service?["running"])) · endpoint \(ProviderSecretRedactor.redactEndpoint(service?["loopback_origin"] as? String ?? "unreported"))"
        renderTransportProbe(json["http_probe"] as? [String: Any], expectedSchema: "sks.desktop-bridge-http-probe.v1", label: bridgeHttpStatus, title: "HTTP")
        renderTransportProbe(json["websocket_probe"] as? [String: Any], expectedSchema: "sks.desktop-bridge-websocket-probe.v2", label: bridgeWebSocketStatus, title: "WebSocket")
    }

    private func renderTransportProbe(_ probe: [String: Any]?, expectedSchema: String, label: NSTextField, title: String) {
        guard probe?["schema"] as? String == expectedSchema else { label.stringValue = "\(title) probe: not attempted"; label.textColor = .secondaryLabelColor; return }
        let state = probe?["state"] as? String ?? "failed"
        let stage = probe?["terminal_stage"] as? String ?? "unknown"
        let cause = (probe?["root_cause"] as? String).map { " · root cause: \(ProviderSecretRedactor.redact($0))" } ?? ""
        label.stringValue = "\(title): \(state) · stage \(stage)\(cause)"
        label.textColor = ProviderStatusColor.forState(state)
    }

    private func statusReportMayMerge(_ report: DesktopCapabilityReportV3) -> Bool {
        let checkedAt = SKSTimestamp.date(from: report.checkedAt) ?? .distantPast
        if let current = lastCapabilityReport, let currentDate = SKSTimestamp.date(from: current.checkedAt) {
            guard checkedAt > currentDate
                    || checkedAt == currentDate && report.reportId == current.reportId
                        && report.maximumAttemptId >= current.maximumAttemptId else { return false }
        }
        return responseGate.statusMayMerge(checkedAt: checkedAt, catalogGeneration: report.catalogSync.generation)
    }

    @objc private func verifyTransport() { verify(level: "transport") }
    @objc private func verifyDeep() { verify(level: "deep") }

    private func verify(level: String) {
        let generation = responseGate.begin()
        guard let snapshot = operations.begin(kind: "bridge-verify-\(level)", mutationGroup: nil, summary: "Verify Desktop Bridge \(level)") else { return }
        capabilityStatus.stringValue = "\(level.capitalized) verification running · previous callbacks will be ignored."
        globalSpinner.startAnimation(nil)
        _ = operations.update(snapshot, state: .running, stage: "verifying", progress: nil, summary: "Verify Desktop Bridge \(level)")
        // Deliberately non-strict: readiness findings stay inside the v3 report.
        processClient.run(["bridge", "verify", "--level", level, "--json"], timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            let decoded = self.json(result.output).flatMap { try? DesktopCapabilityReportV3.decode(from: $0) }
            let executionSucceeded = decoded?.execution.ok == true
            let completed = self.operations.update(snapshot, state: executionSucceeded ? .succeeded : .failed, stage: "complete", progress: 1, summary: executionSucceeded ? "Diagnostic report generated" : "Diagnostic execution failed")
            guard let report = decoded, let checked = SKSTimestamp.date(from: report.checkedAt) else {
                if generation == self.responseGate.activeRequestGeneration {
                    self.capabilityStatus.stringValue = "Capability schema invalid · capability_schema_invalid"
                    self.capabilityStatus.textColor = .systemRed; self.globalSpinner.stopAnimation(nil)
                }
                return
            }
            let identity = ProviderResponseIdentity(requestGeneration: generation, reportId: report.reportId, correlationId: report.correlationId, attemptId: report.maximumAttemptId, checkedAt: checked, catalogGeneration: report.catalogGeneration)
            guard self.responseGate.accept(identity) else { return }
            let metadata = DiagnosticOperationMetadata(
                schema: "sks.operation-diagnostic-metadata.v1", executionOK: report.execution.ok,
                reportGenerated: true, requestedLevel: report.requestedLevel,
                levelSatisfied: report.summary.levelSatisfied,
                fullFeatureVerified: report.summary.fullFeatureVerified, reportId: report.reportId,
                correlationId: report.correlationId, attemptId: report.maximumAttemptId,
                catalogGeneration: report.catalogGeneration
            )
            self.lastDiagnosticMetadata = metadata
            _ = self.operations.recordDiagnostic(completed, metadata: metadata)
            self.globalSpinner.stopAnimation(nil)
            self.renderCapabilityReport(report)
            self.renderCombinedCatalog(["catalog_sync": self.jsonObject(report.catalogSync)])
        }
    }

    private func renderCapabilityReport(_ report: DesktopCapabilityReportV3) {
        lastCapabilityReport = report
        capabilityStack.arrangedSubviews.forEach { capabilityStack.removeArrangedSubview($0); $0.removeFromSuperview() }
        let allRows = CapabilityDisplayRow.rows(from: report)
        let visibleRows = CapabilityDisplayFilter.rows(allRows, showAll: showAllCapabilities)
        for row in visibleRows {
            let cause = row.rootCause.map { " · root cause \(ProviderSecretRedactor.redact($0))" } ?? ""
            let recoveryAction = row.recoveryAction.flatMap(ProviderRecoveryAction.init(rawValue:))
            let recovery = recoveryAction.map { " · recovery \($0.buttonTitle)" } ?? ""
            let value = NativeView.detail("\(row.scope.displayName) · \(row.capability) · \(row.state.rawValue) · route \(row.route) · OAuth \(row.oauthRequirement) · \(row.stage.rawValue) · \(row.checkedAt)\(cause)\(recovery)")
            value.textColor = capabilityColor(row.state)
            value.setAccessibilityIdentifier("sks-capability-\(row.scope.rawValue)-\(row.capability)".replacingOccurrences(of: ":", with: "-"))
            if let recoveryAction = recoveryAction {
                let button = NativeView.button(recoveryAction.buttonTitle, target: self, action: #selector(performRecoveryAction(_:)))
                button.setAccessibilityIdentifier("sks-provider-recovery-\(recoveryAction.rawValue)")
                button.setAccessibilityHelp("Runs only the allowlisted recovery mapped to \(recoveryAction.rawValue).")
                capabilityStack.addArrangedSubview(NativeView.row([value, button]))
            } else {
                capabilityStack.addArrangedSubview(value)
            }
        }
        if visibleRows.isEmpty {
            capabilityStack.addArrangedSubview(NativeView.detail("No capability issues in this report. Show all capabilities to inspect the complete trace."))
        }
        capabilityFilterButton.title = showAllCapabilities ? "Show Issues Only" : "Show All Capabilities"
        capabilityFilterButton.setAccessibilityLabel(capabilityFilterButton.title)
        let issueCount = CapabilityDisplayFilter.issueCount(allRows)
        let satisfied = report.summary.levelSatisfied
        capabilityStatus.stringValue = "\(report.requestedLevel.capitalized) diagnostic completed · \(issueCount) issue\(issueCount == 1 ? "" : "s") · readiness \(satisfied ? "satisfied" : "needs action") · full deep \(report.summary.fullFeatureVerified ? "verified" : "not verified")"
        capabilityStatus.textColor = satisfied ? .systemGreen : .systemOrange
        capabilityLastCheckedStatus.stringValue = "Last feature check: \(report.checkedAt) · report \(report.reportId)"
        renderCatalogStatus(report.catalogSync)
    }

    private func capabilityColor(_ state: CapabilityProbeState) -> NSColor {
        ProviderStatusColor.forState(state.rawValue)
    }

    @objc private func toggleCapabilityFilter() {
        showAllCapabilities.toggle()
        if let report = lastCapabilityReport { renderCapabilityReport(report) }
    }

    @objc private func repairDesktopBridge() {
        guard let snapshot = operations.begin(kind: "bridge-repair", mutationGroup: "codex-config", summary: "Repair Desktop Bridge") else {
            providerStatus.stringValue = "Another guarded mutation is running."
            return
        }
        setBusy(true)
        providerStatus.stringValue = "Desktop Bridge repair running…"
        _ = operations.update(snapshot, state: .running, stage: "repairing", progress: nil, summary: "Repair Desktop Bridge")
        processClient.run(["bridge", "repair", "--json"], timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.setBusy(false)
            let parsed = self.json(result.output)
            let truth = parsed.flatMap {
                try? DesktopBridgeCommandResultTruth.decode(from: $0, expectedOperation: "repair")
            }
            let nativeError = parsed.flatMap { row -> String? in
                row["schema"] as? String == "sks.native-process-error.v1" ? row["error"] as? String : nil
            }
            let completed = result.code == 0 && truth?.completed == true
            let blocker = (truth?.blockers.first ?? nativeError).map(ProviderSecretRedactor.redact)
            let summary = completed
                ? "Repair Desktop Bridge completed"
                : blocker.map { "Repair Desktop Bridge needs action · \($0)" } ?? "Repair Desktop Bridge result schema invalid"
            _ = self.operations.update(snapshot, state: completed ? .succeeded : .failed, stage: "complete", progress: 1, summary: summary)
            self.providerStatus.stringValue = summary
            self.providerStatus.textColor = completed ? .systemGreen : .systemRed
            self.refresh()
        }
    }

    @objc private func performRecoveryAction(_ sender: NSButton) {
        let prefix = "sks-provider-recovery-"
        let id = sender.accessibilityIdentifier()
        guard id.hasPrefix(prefix),
              let action = ProviderRecoveryAction(rawValue: String(id.dropFirst(prefix.count))) else {
            capabilityStatus.stringValue = "Recovery blocked · action is not allowlisted."
            capabilityStatus.textColor = .systemRed; return
        }
        switch action {
        case .repairBridgeService, .restartBridgeAndRetry: repairDesktopBridge()
        case .configureCodexLb, .rotateCodexLb: configureCodexLbProfile()
        case .configureOpenRouter, .rotateOpenRouter: configureOpenRouterProfile()
        case .retryCatalog, .resolveConflict, .refreshCatalog: refreshCombinedCatalog()
        case .runDeep: verifyDeep()
        case .inspectBridgeLogs:
            capabilityStatus.stringValue = "Open Diagnostics from the sidebar, inspect the Desktop Bridge log, then retry Transport verification."
        case .updateBridgeProtocol, .updateMenubar:
            capabilityStatus.stringValue = "Open Updates, install a compatible SKS/Codex version, rebuild the menu bar, then retry."
        case .reviewConfig:
            capabilityStatus.stringValue = "Review user-owned config manually. SKS will not overwrite a conflicting custom provider."
        }
    }
    func json(_ output: String) -> [String: Any]? { guard let data = output.data(using: .utf8) else { return nil }; return try? JSONSerialization.jsonObject(with: data) as? [String: Any] }
    func jsonObject<T: Encodable>(_ value: T) -> [String: Any] { guard let data = try? JSONEncoder().encode(value) else { return [:] }; return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:] }
    private func yesNo(_ value: Any?) -> String { value as? Bool == true ? "yes" : "no" }

}
