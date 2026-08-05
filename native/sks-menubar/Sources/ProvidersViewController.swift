import Cocoa

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
    let routeModelField: NSTextField = {
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 250, height: 24))
        field.placeholderString = "Select or enter an exact catalog model"
        field.setAccessibilityLabel("Model to explain through the explicit route index")
        field.setAccessibilityIdentifier("sks-provider-route-model")
        return field
    }()

    // Compatibility state used by the remaining role/Fast/connect-test source files.
    let cliConnectConfigurationStage = NativeView.detail("1. Configuration · waiting")
    let cliConnectRequestStage = NativeView.detail("2. One-request low-token test · waiting")
    let cliConnectResponseStage = NativeView.detail("3. Response · not received")
    let cliConnectResult = NativeView.detail("Connection proof has not run.")
    let cliConnectProgress: NSProgressIndicator = { let p = NSProgressIndicator(); p.style = .bar; p.minValue = 0; p.maxValue = 3; return p }()
    let providerApplyStatus = NativeView.detail("Provider apply stages: no operation receipt yet.")
    let codexLbKeychainStatus = NativeView.detail("Codex-LB credential: checking Keychain without UI…")
    let openRouterKeychainStatus = NativeView.detail("OpenRouter credential: checking Keychain without UI…")
    let oauthCredentialStatus = NativeView.detail("ChatGPT OAuth: checking Codex-owned identity…")
    let openRouterActiveStatus = NativeView.detail("OpenRouter enabled state: checking…")
    let openRouterCatalogStatus = NativeView.detail("OpenRouter catalog: checking…")
    let openRouterStatus = NativeView.detail("No OpenRouter action has run.")
    let openRouterModelField = NSTextField()
    let openRouterModelPopup = NSPopUpButton()
    let multiProvider = MultiProviderRouterControls()
    let roleStatus = NativeView.detail("Role model settings are loading…")
    let globalSpinner = NativeView.spinner(label: "Provider operation in progress")
    let fastStatus = NativeView.detail("Codex Fast: checking…")
    let activeProviderBadge = ControlKit.badge("Desktop Bridge · checking", tone: .busy)
    var capabilityRows: [String: NSTextField] = [:]
    var desktopFullRoutingNow = false, codexLbSelectedNow = false, codexLbProvedNow = false
    var chatgptOauthPresentNow = false, openRouterSelectedNow = false, openRouterCredentialValidatedNow = false
    var openRouterActiveModel = "", routerSelectedNow = false, routerActiveModel = ""
    var roleRows: [String: RoleModelControls] = [:]
    var actionButtons: [NSButton] = []
    var openRouterModels: [String] = []
    var supportedRoleProfiles: [(model: String, reasoning: String)] = []
    var roleProfilesLoaded = false
    weak var openRouterRefreshButton: NSButton?, openRouterRestoreButton: NSButton?, roleRefreshButton: NSButton?
    var openRouterRestoreAvailable = false, catalogRefreshInFlight = false, roleRefreshInFlight = false
    var openRouterModelSelectionPending = false, openRouterActionRan = false, connectTestInFlight = false
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
        providerApplyStatus.setAccessibilityIdentifier("sks-center-provider-apply-status")

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
        let card = NativeView.card(title: "Capability Matrix", subtitle: "Each row keeps its own scope, route, OAuth requirement, stage, root cause, and allowlisted recovery. Deep-only work not run is not a failure.", views: [capabilityStatus, capabilityLastCheckedStatus, capabilityStack])
        card.setAccessibilityIdentifier("sks-provider-card-capability-matrix")
        return card
    }

    func setBusy(_ value: Bool) {
        busy = value
        for button in actionButtons where !providerButtons.values.flatMap({ $0 }).contains(where: { $0 === button }) { button.isEnabled = !value }
        openRouterModelField.isEnabled = !value && openRouterCredentialValidatedNow
        updateRoleControlAvailability()
        value ? globalSpinner.startAnimation(nil) : globalSpinner.stopAnimation(nil)
    }

    func setProviderActionBusy(_ providerId: String, _ value: Bool) {
        if value { providerActionInFlight.insert(providerId) } else { providerActionInFlight.remove(providerId) }
        providerButtons[providerId]?.forEach { $0.isEnabled = !value }
        if providerActionInFlight.isEmpty { globalSpinner.stopAnimation(nil) } else { globalSpinner.startAnimation(nil) }
    }

    private func run(_ args: [String], title: String, kind: String, group: String?, timeout: TimeInterval = NativeView.mutationTimeout, completion: (() -> Void)? = nil) {
        guard let snapshot = operations.begin(kind: kind, mutationGroup: group, summary: title) else { fastStatus.stringValue = "Another guarded mutation is running."; return }
        setBusy(true)
        _ = operations.update(snapshot, state: .running, stage: "running", progress: nil, summary: title)
        processClient.run(args, timeout: timeout) { [weak self] result in
            guard let self = self else { return }; self.setBusy(false)
            _ = self.operations.update(snapshot, state: result.code == 0 ? .succeeded : .failed, stage: "complete", progress: 1, summary: result.code == 0 ? "\(title) completed" : "\(title) failed")
            completion?()
        }
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
        let management = (json["management"] as? [String: Any]) ?? (json["bridge"] as? [String: Any])?["management"] as? [String: Any]
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
        label.textColor = state == "verified" ? .systemGreen : .systemRed
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
        for row in CapabilityDisplayRow.rows(from: report) {
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
        let satisfied = report.summary.levelSatisfied
        capabilityStatus.stringValue = "\(report.requestedLevel.capitalized) diagnostic completed · readiness \(satisfied ? "satisfied" : "needs action") · full deep \(report.summary.fullFeatureVerified ? "verified" : "not verified")"
        capabilityStatus.textColor = satisfied ? .systemGreen : .systemOrange
        capabilityLastCheckedStatus.stringValue = "Last feature check: \(report.checkedAt) · report \(report.reportId)"
        renderCatalogStatus(report.catalogSync)
    }

    private func capabilityColor(_ state: CapabilityProbeState) -> NSColor {
        switch state {
        case .verified: return .systemGreen
        case .running: return .systemBlue
        case .blocked, .failed: return .systemRed
        case .unsupported: return .secondaryLabelColor
        case .degraded, .stale, .notAttempted: return .systemOrange
        }
    }

    @objc private func repairDesktopBridge() { run(["bridge", "repair", "--json"], title: "Repair Desktop Bridge", kind: "bridge-repair", group: "codex-config") { [weak self] in self?.refresh() } }

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
    @objc private func fastOn() { run(["fast-mode", "on", "--json"], title: "Codex Fast On", kind: "fast-mode-on", group: "codex-config") }
    @objc private func fastOff() { run(["fast-mode", "off", "--json"], title: "Codex Fast Off", kind: "fast-mode-off", group: "codex-config") }

    func json(_ output: String) -> [String: Any]? { guard let data = output.data(using: .utf8) else { return nil }; return try? JSONSerialization.jsonObject(with: data) as? [String: Any] }
    func jsonObject<T: Encodable>(_ value: T) -> [String: Any] { guard let data = try? JSONEncoder().encode(value) else { return [:] }; return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:] }
    private func yesNo(_ value: Any?) -> String { value as? Bool == true ? "yes" : "no" }

    // Compatibility badge writer for legacy connect-test callbacks only.
    func renderMeasuredRoutingBadge(_ route: ProviderRoutingTruth.MeasuredRoute?, routeExpected: Bool) {
        guard routeExpected else { return }
        ControlKit.setBadge(activeProviderBadge, text: route?.active == true ? "Codex-LB · verified" : "Codex-LB · unverified", tone: route?.active == true ? .ok : .warning)
    }
}
