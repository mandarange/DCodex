import Cocoa

final class ProvidersViewController: NSViewController, ControlCenterPage, NSTextFieldDelegate {
    private let capabilityDefinitions: [(label: String, keys: [String])] = [
        ("OAuth Identity", ["oauth_identity", "provider_identity"]), ("Built-in Provider", ["built_in_provider", "provider_identity"]),
        ("Bridge", ["bridge"]), ("Models", ["models", "model_picker", "catalog"]), ("Fast", ["fast", "fast_mode"]),
        ("Image", ["image", "image_generation"]), ("Computer", ["computer", "computer_use"]), ("Browser", ["browser", "browser_use"]),
        ("Voice", ["voice", "voice_mode"]), ("Plugins", ["plugins"])
    ]
    private let capabilityStates = Set(["verified", "available_unverified", "blocked", "unsupported", "skipped"])
    private let cliLaunchCommand = "codex"
    let processClient: ProcessClient
    let operations: OperationCoordinator
    let providerStatus = NativeView.detail("Desktop routing status unchecked.")
    let cliProviderStatus = NativeView.detail("CLI provider status unchecked.")
    let cliConnectConfigurationStage = NativeView.detail("1. Configuration · waiting")
    let cliConnectRequestStage = NativeView.detail("2. One-request low-token test · waiting")
    let cliConnectResponseStage = NativeView.detail("3. Response · not received")
    let cliConnectResult = NativeView.detail("Connection proof has not run.")
    let cliConnectProgress: NSProgressIndicator = {
        let progress = NSProgressIndicator()
        progress.style = .bar
        progress.isIndeterminate = false
        progress.minValue = 0
        progress.maxValue = 3
        progress.doubleValue = 0
        progress.setAccessibilityLabel("Codex LB connection proof progress")
        progress.setAccessibilityIdentifier("sks-center-codex-lb-connect-progress")
        return progress
    }()
    let capabilityStatus = NativeView.detail("Capabilities have not been verified.")
    let capabilityLastCheckedStatus = NativeView.detail("Last feature check: never · choose Verify Capabilities.")
    let catalogSyncStatus = NativeView.detail("Native Codex catalog sync: not reported yet.")
    let providerApplyStatus = NativeView.detail("Provider apply stages: no operation receipt yet.")
    let codexLbKeychainStatus = NativeView.detail("Codex LB credential: checking Keychain without UI…")
    let openRouterKeychainStatus = NativeView.detail("OpenRouter credential: checking Keychain without UI…")
    let oauthCredentialStatus = NativeView.detail("ChatGPT OAuth credential: checking Codex-owned auth state…")
    let openRouterCredentialStatus = NativeView.detail("Credential: checking…")
    let openRouterActiveStatus = NativeView.detail("Active provider: checking…")
    let openRouterCatalogStatus = NativeView.detail("Model catalog has not loaded yet.")
    let openRouterStatus = NativeView.detail("No OpenRouter action has run yet.")
    let openRouterModelField: NSTextField = {
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.placeholderString = "z-ai/glm-5.2"
        field.setAccessibilityLabel("Manual OpenRouter model id")
        field.setAccessibilityPlaceholderValue("provider/model")
        return field
    }()
    let openRouterModelPopup = NSPopUpButton()
    let multiProvider = MultiProviderRouterControls()
    let roleStatus = NativeView.detail("Role model settings are loading…")
    let globalSpinner = NativeView.spinner(label: "Provider operation in progress")
    let fastStatus = NativeView.detail("Codex Fast: checking the official service-tier setting…")
    let activeProviderBadge = ControlKit.badge("Checking the active Codex provider…", tone: .busy)
    var capabilityRows: [String: NSTextField] = [:]
    var desktopFullRoutingNow = false
    var codexLbSelectedNow = false
    // True only after a measured verified route or a live connection proof, so
    // unrelated status probes never downgrade a proven badge to "unproved".
    var codexLbProvedNow = false
    var chatgptOauthPresentNow = false
    var openRouterSelectedNow = false
    var openRouterCredentialValidatedNow = false
    var openRouterActiveModel = ""
    var routerSelectedNow = false
    var routerActiveModel = ""
    var roleRows: [String: RoleModelControls] = [:]
    var actionButtons: [NSButton] = []
    var openRouterModels: [String] = []
    var supportedRoleProfiles: [(model: String, reasoning: String)] = []
    var roleProfilesLoaded = false
    weak var openRouterRefreshButton: NSButton?
    weak var openRouterRestoreButton: NSButton?
    var openRouterRestoreAvailable = false
    weak var roleRefreshButton: NSButton?
    var catalogRefreshInFlight = false
    var roleRefreshInFlight = false
    var openRouterModelSelectionPending = false
    var openRouterActionRan = false
    var connectTestInFlight = false
    var busy = false
    let keychainStore = SKSKeychainStore()
    init(processClient: ProcessClient, operations: OperationCoordinator) {
        self.processClient = processClient
        self.operations = operations
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { nil }
    override func loadView() {
        let enableDesktop = NativeView.button("Desktop Bridge Mode (keeps ChatGPT sign-in)", target: self, action: #selector(enableDesktopFull))
        let verifyDesktop = NativeView.button("Verify Capabilities", target: self, action: #selector(verifyDesktopCapabilities))
        let disableDesktop = NativeView.button("Use ChatGPT OAuth Only", target: self, action: #selector(disableDesktopRouting))
        enableDesktop.setAccessibilityLabel("Advanced Desktop Bridge Mode that keeps ChatGPT sign-in, then restarts Codex App")
        verifyDesktop.setAccessibilityLabel("Verify Desktop transport capabilities")
        disableDesktop.setAccessibilityLabel("Disable Codex LB Desktop routing and keep ordinary ChatGPT OAuth, then restart Codex App")
        // Keep the mode CTAs discoverable: never hide the advanced bridge or ChatGPT OAuth actions based on status parsing.
        let configureCli = NativeView.button("Reconnect Codex LB credential…", target: self, action: #selector(setDomainAndKey))
        let useCli = ControlKit.primaryButton("Use Codex LB", target: self, action: #selector(useCliProvider))
        useCli.setAccessibilityLabel("Use Codex LB through the atomic CLI provider path")
        let testCli = NativeView.button("Run Connect Test", target: self, action: #selector(testConnection))
        testCli.setAccessibilityHelp("Send one bounded low-token request through the selected Codex LB provider and show the returned proof.")
        let copyCli = NativeView.button("Copy CLI Command", target: self, action: #selector(copyCliCommand))
        let fastOn = NativeView.button("Codex Fast On", target: self, action: #selector(fastOn))
        let fastOff = NativeView.button("Codex Fast Off", target: self, action: #selector(fastOff))
        let reconnectOpenRouter = NativeView.button("Reconnect OpenRouter credential…", target: self, action: #selector(saveOpenRouterKey))
        let openCodexSignIn = NativeView.button("Open Codex sign-in…", target: self, action: #selector(openCodexSignInAction))
        registerProviderAction(enableDesktop, id: "sks-provider-desktop-bridge-mode")
        registerProviderAction(verifyDesktop, id: "sks-provider-verify-capabilities")
        registerProviderAction(disableDesktop, id: "sks-provider-use-chatgpt-oauth")
        registerProviderAction(configureCli, id: "sks-provider-reconnect-codex-lb")
        registerProviderAction(testCli, id: "sks-provider-run-connect-test")
        registerProviderAction(copyCli, id: "sks-provider-copy-cli-command")
        registerProviderAction(useCli, id: "sks-provider-activate-codex-lb")
        registerProviderAction(reconnectOpenRouter, id: "sks-provider-reconnect-openrouter")
        registerProviderAction(openCodexSignIn, id: "sks-provider-open-codex-signin")
        registerProviderAction(fastOn, id: "sks-provider-fast-on")
        registerProviderAction(fastOff, id: "sks-provider-fast-off")
        providerApplyStatus.setAccessibilityIdentifier("sks-center-provider-apply-status")
        providerApplyStatus.setAccessibilityLabel("Provider apply stage receipts")
        actionButtons = [enableDesktop, verifyDesktop, disableDesktop, configureCli, reconnectOpenRouter, openCodexSignIn, useCli, testCli, copyCli, fastOn, fastOff]
        let cli = NativeView.card(
            title: "Codex LB · Credentials & Primary Provider",
            subtitle: "Saves host + API key, then Use Codex LB selects the atomic CLI provider (Authorization: Bearer via CODEX_LB_API_KEY). No transport picker.",
            views: [
                cliProviderStatus, codexLbKeychainStatus,
                ControlKit.actionRow([configureCli, useCli]),
                makeCliConnectProgressView(),
                ControlKit.actionRow([testCli, copyCli])
            ]
        )
        let fast = NativeView.card(
            title: "Codex Fast",
            subtitle: "Official Codex speed option: 1.5× faster on supported models. It changes the service tier, not the selected model, Codex-Spark, or reasoning effort.",
            views: [
                fastStatus,
                NativeView.detail("ChatGPT sign-in: GPT-5.6 and GPT-5.5 use credits at 2.5× Standard; GPT-5.4 uses 2× Standard. API-key Codex uses API token pricing instead, and API Priority processing is a separate billing path."),
                NativeView.row([fastOn, fastOff])
            ]
        )
        view = NativeView.page([
            NativeView.row([NativeView.title("Providers & Models"), globalSpinner]),
            NativeView.detail("SKS selects one provider path: Codex LB (Authorization: Bearer), OpenRouter, or ChatGPT OAuth. Secrets go through stdin and are never written to operation logs."),
            makeActiveProviderCard(),
            cli,
            makeOpenRouterCard(),
            NativeView.card(
                title: "Advanced",
                subtitle: "Desktop Bridge keeps ChatGPT sign-in while routing traffic. Capability matrix and apply receipts appear after you run Verify or a provider mutation.",
                views: [
                    oauthCredentialStatus,
                    NativeView.row([openCodexSignIn]),
                    providerStatus,
                    ControlKit.actionRow([enableDesktop, verifyDesktop], trailing: [disableDesktop]),
                    providerApplyStatus,
                    makeCapabilityMatrixCard()
                ]
            ),
            makeRoleModelsCard(),
            fast
        ])
    }
    func refreshOnAppear() { refresh() }
    func setBusy(_ value: Bool) {
        busy = value
        for button in actionButtons { button.isEnabled = !value }
        openRouterModelField.isEnabled = !value && openRouterCredentialValidatedNow
        openRouterModelPopup.isEnabled = !value && openRouterCredentialValidatedNow && !openRouterModels.isEmpty
        openRouterRefreshButton?.isEnabled = !value && !catalogRefreshInFlight
        openRouterRestoreButton?.isEnabled = !value && openRouterRestoreAvailable
        roleRefreshButton?.isEnabled = !value && !roleRefreshInFlight
        updateRoleControlAvailability()
        if value { globalSpinner.startAnimation(nil) }
        else { globalSpinner.stopAnimation(nil) }
    }
    private func run(_ args: [String], title: String, kind: String, group: String?, timeout: TimeInterval = NativeView.mutationTimeout, completion: (() -> Void)? = nil) {
        guard !busy else { fastStatus.stringValue = "Another provider action is already running."; return }
        guard let snapshot = operations.begin(kind: kind, mutationGroup: group, summary: title) else {
            fastStatus.stringValue = "Another guarded mutation is already running. Wait or open Diagnostics."
            return
        }
        setBusy(true); fastStatus.stringValue = "\(title)…"
        _ = operations.update(snapshot, state: .running, stage: "running", progress: nil, summary: title)
        processClient.run(args, timeout: timeout) { [weak self] result in
            guard let self = self else { return }
            self.setBusy(false)
            _ = self.operations.update(snapshot, state: result.code == 0 ? .succeeded : .failed, stage: "complete", progress: 1, summary: result.code == 0 ? "\(title) completed" : "\(title) failed")
            if result.code != 0 { self.fastStatus.stringValue = "\(title) failed · \(NativeView.redactPreview(result.output))" }
            completion?()
        }
    }
    func refresh() {
        refreshCredentialHealth()
        renderLatestProviderApply()
        processClient.run(["codex-lb", "status", "--json"], timeout: NativeView.statusTimeout) { [weak self] result in
            guard let self = self else { return }
            guard let json = self.json(result.output) else {
                if !self.busy {
                    self.providerStatus.stringValue = "Desktop routing status unavailable. No routing mode was assumed."
                    self.cliProviderStatus.stringValue = "CLI provider status unavailable. No configuration was assumed."
                }
                return
            }
            let snapshot = ProviderRoutingTruth.snapshot(from: json)
            let measuredRoute = ProviderRoutingTruth.measuredRoute(from: json)
            let measuredRoutingOk = measuredRoute?.selected == true
                && measuredRoute?.measured == true
                && measuredRoute?.ok == true
            self.desktopFullRoutingNow = snapshot.desktopFullRouting && measuredRoutingOk
            self.codexLbSelectedNow = snapshot.legacyCodexLbSelected || measuredRoute?.selected == true
            self.chatgptOauthPresentNow = snapshot.chatgptOauthPresent
            self.oauthCredentialStatus.stringValue = snapshot.chatgptOauthPresent
                ? "ChatGPT OAuth: connected · refresh token remains Codex-owned and is never copied by SKS."
                : "Authentication Required: ChatGPT OAuth is not connected. Choose Open Codex sign-in; no login window was opened automatically."
            self.oauthCredentialStatus.textColor = snapshot.chatgptOauthPresent ? .secondaryLabelColor : .systemOrange
            self.renderCatalogSyncStatus(json)
            self.codexLbProvedNow = snapshot.mode == "cli-provider" && measuredRoute?.active == true
            // Single decision ladder — exactly one badge writer per refresh.
            if snapshot.legacyCodexLbSelected {
                ControlKit.setBadge(self.activeProviderBadge, text: "E-LB-LEGACY-MIGRATE · run migrate-legacy-desktop", tone: .warning)
            } else if snapshot.mode == "cli-provider", let route = measuredRoute, route.selected, !route.active {
                let authFail = route.status == "auth_rejected" || route.blockers.contains(where: { $0.contains("auth") })
                let code = authFail ? "E-LB-AUTH" : "E-LB-DEGRADED"
                let http = route.httpStatus.map { "HTTP \($0)" } ?? route.status
                ControlKit.setBadge(self.activeProviderBadge, text: "Codex LB · CLI · \(code) · \(http)", tone: .warning)
            } else if snapshot.desktopFullRouting {
                self.renderMeasuredRoutingBadge(measuredRoute, routeExpected: true)
            } else {
                self.renderActiveProviderSummary()
            }
            if !self.busy {
                self.providerStatus.stringValue = self.describeDesktopStatus(snapshot)
                self.cliProviderStatus.stringValue = self.describeCliStatus(snapshot, measuredRoute: measuredRoute)
            }
        }
        refreshOpenRouterStatus()
        if openRouterModels.isEmpty { refreshOpenRouterModels() }
        refreshRoleModels()
        refreshFastStatus()
    }

    private func makeCapabilityMatrixCard() -> NSBox {
        var views: [NSView] = [capabilityStatus, capabilityLastCheckedStatus, catalogSyncStatus]
        for definition in capabilityDefinitions {
            let value = NativeView.detail("skipped")
            value.setAccessibilityLabel("\(definition.label) capability state")
            capabilityRows[definition.label] = value
            views.append(ControlKit.keyValueRow(definition.label, value))
        }
        return NativeView.card(title: "Latest Codex Feature Compatibility", subtitle: "Every feature reports availability, direct proxy or OAuth auxiliary path, OAuth requirement, last check, failure reason, and recovery. Missing metadata is shown as unverified; SKS never hides the feature or silently falls back.", views: views)
    }
    private func describeDesktopStatus(_ snapshot: ProviderRoutingTruth.Snapshot) -> String {
        if snapshot.legacyDestructive {
            return "Legacy destructive provider/auth state detected · choose Desktop Bridge Mode or Use Codex LB for migration guidance, or Use ChatGPT OAuth Only to remove SKS-owned routing."
        }
        if snapshot.mode == "desktop-native-bridge" {
            let oauth = snapshot.chatgptOauthPresent
                ? "ChatGPT OAuth present"
                : "ChatGPT OAuth missing — sign in with ChatGPT"
            return "Desktop Bridge mode: enabled · \(oauth) · built-in OpenAI via bridge. Run Verify Capabilities for evidence."
        }
        if snapshot.mode == "cli-provider" {
            return "Desktop Bridge: off · the Codex LB CLI provider path handles routing, so the bridge is not used. Desktop Bridge Mode stays an optional alternative."
        }
        if snapshot.mode == "disabled" {
            return snapshot.chatgptOauthPresent
                ? "ChatGPT OAuth mode: active · Codex LB Desktop routing disabled. Choose Desktop Bridge Mode (keeps ChatGPT sign-in) to switch."
                : "ChatGPT OAuth mode: selected, but ChatGPT sign-in is missing · run codex login."
        }
        return snapshot.chatgptOauthPresent
            ? "ChatGPT OAuth mode: active · Codex LB Desktop routing not enabled. Choose Desktop Bridge Mode (keeps ChatGPT sign-in) to switch."
            : "ChatGPT OAuth mode available · ChatGPT sign-in is missing · run codex login, then Desktop Bridge Mode or Use Codex LB if needed."
    }
    private func describeCliStatus(_ snapshot: ProviderRoutingTruth.Snapshot, measuredRoute: ProviderRoutingTruth.MeasuredRoute?) -> String {
        if let route = measuredRoute, route.selected {
            switch route.state {
            case .active:
                return "CLI provider: active · \(describeRoutingTruth(route))"
            case .degraded:
                return "CLI provider: degraded · \(describeRoutingTruth(route))"
            case .unverified:
                return "CLI provider: selected but unverified · \(describeRoutingTruth(route))"
            case .inactive:
                break
            }
        }
        if snapshot.cliCredentialsConfigured && snapshot.cliProviderStored {
            return "CLI provider: configured · availability remains unverified until Run Connect Test succeeds."
        }
        if snapshot.cliProviderStored {
            return "CLI provider: configured, but credentials are incomplete · choose Reconnect Codex LB credential…"
        }
        return "CLI provider: not configured · choose Reconnect Codex LB credential…"
    }
    private func capabilityPayload(_ json: [String: Any]) -> [String: Any] {
        for key in ["report", "capabilities", "desktop_capabilities", "capability_report"] { if let payload = json[key] as? [String: Any] { return payload } }
        return json
    }
    @discardableResult
    private func renderCapabilityMatrix(_ json: [String: Any]) -> String? {
        let payload = capabilityPayload(json)
        let trustVerified = CapabilityVerificationTruth.deepEvidenceTrusted(in: json)
        var recognized = false
        var rendered: [String] = []
        for definition in capabilityDefinitions {
            let states = definition.keys.compactMap { capabilityState($0, payload: payload, allowVerified: trustVerified) }
            if !states.isEmpty { recognized = true }
            let state = states.max { capabilityStateRank($0) < capabilityStateRank($1) } ?? "skipped"
            rendered.append(state)
            let label = capabilityRows[definition.label]
            label?.stringValue = capabilityCompatibilityDetail(
                definition: definition,
                payload: payload,
                state: state,
                trustVerified: trustVerified
            )
            label?.textColor = capabilityColor(state)
        }
        guard recognized else { capabilityStatus.stringValue = "Capability response did not contain recognized evidence. No state was assumed."; return nil }
        let reportedOverall = normalizedCapabilityState(payload["overall"] as? String, source: nil)
            ?? normalizedCapabilityState(payload["state"] as? String, source: nil)
        let overall = reportedOverall == "verified" ? (trustVerified ? "verified" : "available_unverified") : (reportedOverall ?? "available_unverified")
        let verifiedCount = rendered.filter { $0 == "verified" }.count
        let blockers = CapabilityVerificationTruth.blockers(in: json)
        let blockerText = blockers.isEmpty ? "" : " · blockers: \(blockers.prefix(3).joined(separator: ", "))"
        let trustText = reportedOverall == "verified" && !trustVerified ? " · trusted deep evidence missing" : ""
        capabilityStatus.stringValue = "Capabilities: \(overall) · \(verifiedCount)/\(rendered.count) verified\(trustText)\(blockerText)."
        let checkedAt = (payload["checked_at"] as? String)
            ?? (payload["updated_at"] as? String)
            ?? ISO8601DateFormatter().string(from: Date())
        capabilityLastCheckedStatus.stringValue = "Last feature check: \(checkedAt) · result \(overall)."
        return overall
    }
    private func capabilityState(_ key: String, payload: [String: Any], allowVerified: Bool) -> String? {
        let state: String?
        if let evidence = payload[key] as? [String: Any] {
            state = normalizedCapabilityState(evidence["state"] as? String, source: evidence["source"] as? String)
        } else if let rawState = payload[key] as? String {
            state = normalizedCapabilityState(rawState, source: nil)
        } else {
            var listedState: String?
            for candidate in ["verified", "available_unverified", "unsupported", "skipped"] { if let keys = payload[candidate] as? [String], keys.contains(key) { listedState = candidate } }
            if let blocked = payload["blocked"] as? [String: Any], blocked[key] != nil { listedState = "blocked" }
            if key == "oauth_identity", let preserved = payload["oauth_preserved"] as? Bool { listedState = preserved ? "available_unverified" : "blocked" }
            state = listedState
        }
        return state == "verified" && !allowVerified ? "available_unverified" : state
    }
    private func normalizedCapabilityState(_ state: String?, source: String?) -> String? {
        guard let state = state?.lowercased(), capabilityStates.contains(state) else { return nil }
        if state == "verified", source == "config" || source == "manifest" { return "available_unverified" }
        return state
    }
    private func capabilityStateRank(_ state: String) -> Int {
        switch state {
        case "blocked": return 5
        case "unsupported": return 4
        case "skipped": return 3
        case "available_unverified": return 2
        case "verified": return 1
        default: return 0
        }
    }
    private func capabilityColor(_ state: String) -> NSColor {
        switch state {
        case "verified": return .systemGreen
        case "blocked": return .systemRed
        case "unsupported", "skipped": return .secondaryLabelColor
        default: return .systemOrange
        }
    }
    func json(_ output: String) -> [String: Any]? {
        guard let data = output.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
    @objc private func setDomainAndKey() {
        guard let window = view.window else { return }
        AlertFactory.textSheet(window: window, title: "Codex LB Domain", message: "Enter a hostname or full base URL. https:// is optional — SKS adds https:// and /backend-api/codex when missing.\nExamples: lb.example.com  or  https://lb.example.com\n\nSKS always sends the API key as Authorization: Bearer (Codex env_key). There is no custom-header transport picker.", secure: false, placeholder: "https://lb.example.com") { [weak self] host in
            guard let self = self, let host = host else { return }
            self.promptForKey(window: window, args: ["codex-lb", "setup", "--host", host, "--gateway-auth", "bearer-compat", "--api-key-stdin", "--yes", "--write-env-file", "--json"], kind: "codex-lb-center-setup", title: "Save Codex LB credentials")
        }
    }
    private func promptForKey(window: NSWindow, args: [String], kind: String, title: String) {
        promptForSecretKey(window: window, sheetTitle: "Codex LB API Key", sheetMessage: "Paste your Codex LB API key (usually starts with sk-clb-). This explicit reconnect is the only action allowed to update Keychain. The field stays masked and the key is never written to operation logs.", placeholder: "sk-clb-…", args: args, kind: kind, title: title, credential: .codexLbApiKey, statusLabel: cliProviderStatus, successSummary: "Codex LB credentials saved for Center/Desktop", failSummary: "Codex LB credential save failed")
    }
    @objc private func enableDesktopFull() {
        performDesktopRouting(["codex-lb", "use-desktop-full", "--restart-app", "--json"], title: "Desktop Bridge Mode (keeps ChatGPT sign-in)", kind: "codex-lb-use-desktop-full", expectedMode: "desktop-native-bridge")
    }
    @objc private func disableDesktopRouting() {
        performDesktopRouting(["codex-lb", "disable", "--restart-app", "--json"], title: "Use ChatGPT OAuth Only", kind: "codex-lb-disable-desktop", expectedMode: "disabled")
    }
    @objc private func verifyDesktopCapabilities() {
        guard !busy else { capabilityStatus.stringValue = "Another provider action is already running."; return }
        guard let snapshot = operations.begin(kind: "codex-lb-capabilities", mutationGroup: nil, summary: "Verify Desktop capabilities") else {
            capabilityStatus.stringValue = "Another guarded operation is already running. Wait or open Diagnostics."
            return
        }
        setBusy(true)
        capabilityStatus.stringValue = "Verifying transport capabilities…"
        _ = operations.update(snapshot, state: .running, stage: "verifying", progress: nil, summary: "Verify Desktop capabilities")
        processClient.run(["codex-lb", "capabilities", "--level", "transport", "--json"], timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.setBusy(false)
            let parsed = self.json(result.output)
            let overall = parsed.flatMap(self.renderCapabilityMatrix)
            let verified = result.code == 0
                && parsed?["ok"] as? Bool != false
                && overall == "verified"
                && parsed.map(CapabilityVerificationTruth.deepEvidenceTrusted) == true
            _ = self.operations.update(snapshot, state: verified ? .succeeded : .failed, stage: "complete", progress: 1, summary: verified ? "Desktop capabilities verified" : "Desktop capability verification blocked")
            if overall == nil {
                self.capabilityStatus.stringValue = "Capability verification unavailable · structured evidence was not returned. No capability was assumed."
            } else if !verified {
                let blockers = parsed.map(CapabilityVerificationTruth.blockers) ?? []
                let detail = blockers.isEmpty ? "overall=\(overall ?? "available_unverified")" : blockers.prefix(3).joined(separator: ", ")
                self.capabilityStatus.stringValue = "Capability verification blocked · \(detail). No readiness was assumed."
            }
        }
    }
    @objc private func useCliProvider() {
        performCliCommand(["codex-lb", "use-cli", "--json"], title: "Use Codex LB", kind: "codex-lb-use-cli")
    }
    private func performCliCommand(_ args: [String], title: String, kind: String) {
        guard !busy else { cliProviderStatus.stringValue = "Another provider action is already running."; return }
        guard let snapshot = operations.begin(kind: kind, mutationGroup: "codex-config", summary: title) else {
            cliProviderStatus.stringValue = "Another guarded mutation is already running. Wait or open Diagnostics."
            return
        }
        setBusy(true)
        cliProviderStatus.stringValue = "\(title)…"
        renderCliConnectStages(
            progress: 0,
            configuration: "applying CLI provider…",
            request: "waiting for configuration",
            response: "not received",
            result: "Selecting Codex LB mode. Connectivity has not been claimed.",
            tone: .secondaryLabelColor
        )
        _ = operations.update(snapshot, state: .running, stage: "configuring", progress: nil, summary: title)
        processClient.run(args, timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            let parsed = self.json(result.output)
            let routing = parsed.map(ProviderRoutingTruth.snapshot(from:))
            let mode = routing?.mode
            let oauthPreserved = routing.flatMap { $0.oauthPreservedFlag }
            let authMutated = routing.flatMap { $0.authMutated }
            let ok = result.code == 0
                && parsed?["ok"] as? Bool == true
                && mode == "cli-provider"
                && oauthPreserved != false
                && authMutated != true
            _ = self.operations.update(snapshot, state: ok ? .succeeded : .failed, stage: "complete", progress: 1, summary: ok ? "CLI provider configured" : "CLI provider configuration needs action")
            guard ok else {
                self.setBusy(false)
                // structuredPublicDetail already leads with the stable code.
                let detail = self.structuredPublicDetail(parsed, fallback: result.output, fallbackNext: "Reconnect Codex LB credential, then Use Codex LB / Run Connect Test")
                let code = self.publicFailureCode(parsed)
                self.cliProviderStatus.stringValue = "CLI provider was not confirmed · \(detail)"
                self.renderCliConnectStages(
                    progress: 1,
                    configuration: "failed · \(code)",
                    request: "not run",
                    response: "not received",
                    result: detail,
                    tone: .systemRed
                )
                return
            }
            self.setBusy(false)
            self.codexLbSelectedNow = true
            self.codexLbProvedNow = false
            self.desktopFullRoutingNow = false
            self.openRouterSelectedNow = false
            self.routerSelectedNow = false
            ControlKit.setBadge(self.activeProviderBadge, text: "Codex LB · selected · connection proof running", tone: .busy)
            self.cliProviderStatus.stringValue = "Codex LB mode selected · running the required one-request connection proof…"
            self.renderCliConnectStages(
                progress: 1,
                configuration: "CLI provider selected",
                request: "starting…",
                response: "not received",
                result: "Mode is selected. Connectivity remains unproved until a structured response is received.",
                tone: .secondaryLabelColor
            )
            self.runConnectTest()
        }
    }
    @objc private func copyCliCommand() {
        NSPasteboard.general.clearContents()
        let copied = NSPasteboard.general.setString(cliLaunchCommand, forType: .string)
        cliProviderStatus.stringValue = copied
            ? "Copied CLI command: \(cliLaunchCommand)"
            : "Could not copy the CLI command. Select it above and copy manually."
    }
    @objc private func fastOn() { run(["fast-mode", "on", "--json"], title: "Codex Fast On", kind: "fast-mode-on", group: "codex-config", timeout: NativeView.statusTimeout) { [weak self] in self?.refreshFastStatus() } }
    @objc private func fastOff() { run(["fast-mode", "off", "--json"], title: "Codex Fast Off", kind: "fast-mode-off", group: "codex-config", timeout: NativeView.statusTimeout) { [weak self] in self?.refreshFastStatus() } }
}
