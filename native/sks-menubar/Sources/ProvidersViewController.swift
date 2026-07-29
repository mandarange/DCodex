import Cocoa
final class ProvidersViewController: NSViewController, ControlCenterPage, NSTextFieldDelegate {
    private let capabilityDefinitions: [(label: String, keys: [String])] = [
        ("OAuth Identity", ["oauth_identity", "provider_identity"]), ("Built-in Provider", ["built_in_provider", "provider_identity"]),
        ("Bridge", ["bridge"]), ("Models", ["models", "model_picker", "catalog"]), ("Fast", ["fast", "fast_mode"]),
        ("Image", ["image", "image_generation"]), ("Computer", ["computer", "computer_use"]), ("Browser", ["browser", "browser_use"]),
        ("Voice", ["voice", "voice_mode"]), ("Plugins", ["plugins"])
    ]
    private let capabilityStates = Set(["verified", "available_unverified", "blocked", "unsupported", "skipped"])
    private let cliLaunchCommand = "codex --config model_provider='\"codex-lb\"'"
    let processClient: ProcessClient
    let operations: OperationCoordinator
    let providerStatus = NativeView.detail("Desktop routing status unchecked.")
    let cliProviderStatus = NativeView.detail("CLI provider status unchecked.")
    let capabilityStatus = NativeView.detail("Capabilities have not been verified.")
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
    var chatgptOauthPresentNow = false
    var openRouterSelectedNow = false
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
    var busy = false
    init(processClient: ProcessClient, operations: OperationCoordinator) {
        self.processClient = processClient
        self.operations = operations
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { nil }
    override func loadView() {
        let enableDesktop = ControlKit.primaryButton("Use Codex LB", target: self, action: #selector(enableDesktopFull))
        let verifyDesktop = NativeView.button("Verify Capabilities", target: self, action: #selector(verifyDesktopCapabilities))
        let disableDesktop = NativeView.button("Use ChatGPT OAuth Only", target: self, action: #selector(disableDesktopRouting))
        enableDesktop.setAccessibilityLabel("Use Codex LB Desktop Full Capability routing while keeping ChatGPT OAuth, then restart Codex App")
        verifyDesktop.setAccessibilityLabel("Verify Desktop transport capabilities")
        disableDesktop.setAccessibilityLabel("Disable Codex LB Desktop routing and keep ordinary ChatGPT OAuth, then restart Codex App")
        // Keep the mode CTAs discoverable: never hide Use Codex LB / Use ChatGPT OAuth Only based on status parsing.
        let configureCli = NativeView.button("Configure / Update…", target: self, action: #selector(setDomainAndKey))
        let useCli = NativeView.button("Use Saved CLI Provider", target: self, action: #selector(useCliProvider))
        let testCli = NativeView.button("Test", target: self, action: #selector(testConnection))
        let copyCli = NativeView.button("Copy CLI Command", target: self, action: #selector(copyCliCommand))
        let fastOn = NativeView.button("Codex Fast On", target: self, action: #selector(fastOn))
        let fastOff = NativeView.button("Codex Fast Off", target: self, action: #selector(fastOff))
        actionButtons = [enableDesktop, verifyDesktop, disableDesktop, configureCli, useCli, testCli, copyCli, fastOn, fastOff]
        let desktop = NativeView.card(
            title: "Codex LB · Desktop Full Capability (Recommended)",
            subtitle: "Selectable Codex LB mode: keeps ChatGPT OAuth identity and the built-in OpenAI provider while routing model traffic through the local codex-lb bridge. Use ChatGPT OAuth Only removes LB routing without touching login.",
            views: [providerStatus, ControlKit.actionRow([enableDesktop, verifyDesktop], trailing: [disableDesktop])]
        )
        let cli = NativeView.card(
            title: "Codex LB · Credentials & CLI Provider",
            subtitle: "Saves the official Center Codex LB host and API key (sks-codex-lb store). Desktop routing buttons above consume that same store automatically — no shell source or twin env files.",
            views: [
                cliProviderStatus,
                NativeView.detail("One-off command: \(cliLaunchCommand)"),
                ControlKit.actionRow([configureCli, useCli]),
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
            NativeView.detail("Codex LB and ChatGPT OAuth are explicit Desktop modes below. CLI automation and Fast stay independent. Secrets are sent through stdin and redacted from logs."),
            makeActiveProviderCard(), desktop, cli, makeCapabilityMatrixCard(), makeOpenRouterCard(),
            makeMultiProviderRouterCard(), makeRoleModelsCard(), fast
        ])
    }
    func refreshOnAppear() { refresh() }
    func setBusy(_ value: Bool) {
        busy = value
        for button in actionButtons { button.isEnabled = !value }
        openRouterModelField.isEnabled = !value
        openRouterModelPopup.isEnabled = !value && !openRouterModels.isEmpty
        openRouterRefreshButton?.isEnabled = !value && !catalogRefreshInFlight
        openRouterRestoreButton?.isEnabled = !value && openRouterRestoreAvailable
        roleRefreshButton?.isEnabled = !value && !roleRefreshInFlight
        setMultiProviderRouterBusy(value)
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
            self.desktopFullRoutingNow = snapshot.desktopFullRouting
            self.codexLbSelectedNow = snapshot.legacyCodexLbSelected
            self.chatgptOauthPresentNow = snapshot.chatgptOauthPresent
            self.renderActiveProviderSummary()
            if !self.busy {
                self.providerStatus.stringValue = self.describeDesktopStatus(snapshot)
                self.cliProviderStatus.stringValue = self.describeCliStatus(snapshot)
            }
        }
        refreshOpenRouterStatus()
        refreshMultiProviderRouterStatus()
        if openRouterModels.isEmpty { refreshOpenRouterModels() }
        refreshRoleModels()
        refreshFastStatus()
    }
    private func makeCapabilityMatrixCard() -> NSBox {
        var views: [NSView] = [capabilityStatus]
        for definition in capabilityDefinitions {
            let value = NativeView.detail("skipped")
            value.setAccessibilityLabel("\(definition.label) capability state")
            capabilityRows[definition.label] = value
            views.append(ControlKit.keyValueRow(definition.label, value))
        }
        return NativeView.card(title: "Capability Matrix", subtitle: "States come from capability evidence, not configuration alone: verified, available_unverified, blocked, unsupported, or skipped.", views: views)
    }
    private func describeDesktopStatus(_ snapshot: ProviderRoutingTruth.Snapshot) -> String {
        if snapshot.legacyDestructive {
            return "Legacy destructive provider/auth state detected · choose Use Codex LB for migration guidance, or Use ChatGPT OAuth Only to remove SKS-owned routing."
        }
        if snapshot.mode == "desktop-native-bridge" {
            let oauth = snapshot.chatgptOauthPresent
                ? "ChatGPT OAuth present"
                : "ChatGPT OAuth missing — sign in with ChatGPT, then Use Codex LB"
            return "Codex LB mode: enabled · \(oauth) · built-in OpenAI via bridge. Run Verify Capabilities for evidence."
        }
        if snapshot.mode == "disabled" {
            return snapshot.chatgptOauthPresent
                ? "ChatGPT OAuth mode: active · Codex LB Desktop routing disabled. Choose Use Codex LB to switch."
                : "ChatGPT OAuth mode: selected, but ChatGPT sign-in is missing · run codex login."
        }
        return snapshot.chatgptOauthPresent
            ? "ChatGPT OAuth mode: active · Codex LB Desktop routing not enabled. Choose Use Codex LB to switch."
            : "ChatGPT OAuth mode available · ChatGPT sign-in is missing · run codex login, then Use Codex LB if needed."
    }
    private func describeCliStatus(_ snapshot: ProviderRoutingTruth.Snapshot) -> String {
        if snapshot.cliCredentialsConfigured && snapshot.cliProviderStored {
            return "CLI provider: configured · availability remains unverified until Test succeeds."
        }
        if snapshot.cliProviderStored {
            return "CLI provider: configured, but credentials are incomplete · choose Configure / Update…"
        }
        return "CLI provider: not configured · choose Configure / Update…"
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
            label?.stringValue = state
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
        AlertFactory.textSheet(window: window, title: "Codex LB Domain", message: "Enter a hostname or full base URL. https:// is optional — SKS adds https:// and /backend-api/codex when missing.\nExamples: lb.example.com  or  https://lb.example.com", secure: false, placeholder: "https://lb.example.com") { [weak self] host in
            guard let self = self, let host = host else { return }
            // The transport is an explicit operator choice, never guessed: a gateway
            // that wants `Authorization: Bearer` rejects the custom header with 401,
            // which Desktop surfaces as "codex-lb auth not recognized".
            AlertFactory.choiceSheet(
                window: window,
                title: "Codex LB Gateway Key Transport",
                message: "How does this codex-lb gateway expect the API key? Choose Authorization bearer if the gateway answers 401 \"Missing API key in Authorization header\" to the custom header.",
                choices: [
                    ("custom-header", "X-Codex-LB-API-Key custom header (default)"),
                    ("bearer-compat", "Authorization: Bearer compatibility")
                ]
            ) { [weak self] transport in
                guard let self = self, let transport = transport else { return }
                self.promptForKey(window: window, args: ["codex-lb", "setup", "--host", host, "--gateway-auth", transport, "--api-key-stdin", "--yes", "--write-env-file", "--keychain", "--json"], kind: "codex-lb-center-setup", title: "Save Codex LB credentials")
            }
        }
    }
    private func promptForKey(window: NSWindow, args: [String], kind: String, title: String) {
        promptForSecretKey(window: window, sheetTitle: "Codex LB API Key", sheetMessage: "Paste your Codex LB API key (usually starts with sk-clb-). The field stays masked; the key is sent through stdin and stored as the official SKS Center credential Desktop uses automatically.", placeholder: "sk-clb-…", args: args, kind: kind, title: title, statusLabel: cliProviderStatus, successSummary: "Codex LB credentials saved for Center/Desktop", failSummary: "Codex LB credential save failed")
    }
    func promptForSecretKey(window: NSWindow, sheetTitle: String, sheetMessage: String, placeholder: String, args: [String], kind: String, title: String, statusLabel: NSTextField, successSummary: String, failSummary: String) {
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
                let ok = result.code == 0 && parsed?["ok"] as? Bool == true
                _ = self.operations.update(snapshot, state: ok ? .succeeded : .failed, stage: "complete", progress: 1, summary: ok ? successSummary : failSummary)
                statusLabel.stringValue = ok
                    ? "\(successSummary). Next: test the saved configuration."
                    : "\(failSummary) · \(self.structuredPublicDetail(parsed, fallback: result.output))"
                self.refresh()
            }
        }
    }
    @objc private func enableDesktopFull() {
        performDesktopRouting(["codex-lb", "use-desktop-full", "--restart-app", "--json"], title: "Use Codex LB", kind: "codex-lb-use-desktop-full", expectedMode: "desktop-native-bridge")
    }
    @objc private func disableDesktopRouting() {
        performDesktopRouting(["codex-lb", "disable", "--restart-app", "--json"], title: "Use ChatGPT OAuth Only", kind: "codex-lb-disable-desktop", expectedMode: "disabled")
    }
    private func performDesktopRouting(_ args: [String], title: String, kind: String, expectedMode: String) {
        guard !busy else { providerStatus.stringValue = "Another provider action is already running."; return }
        guard let snapshot = operations.begin(kind: kind, mutationGroup: "codex-config", summary: title) else {
            providerStatus.stringValue = "Another guarded mutation is already running. Wait or open Diagnostics."
            return
        }
        setBusy(true)
        providerStatus.stringValue = "\(title)…"
        _ = operations.update(snapshot, state: .running, stage: "routing", progress: nil, summary: title)
        processClient.run(args, timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.setBusy(false)
            let parsed = self.json(result.output)
            let routing = parsed.map(ProviderRoutingTruth.snapshot(from:))
            let mode = routing?.mode
            let oauthPreserved = routing.flatMap { $0.oauthPreservedFlag }
            let ok = result.code == 0 && parsed?["ok"] as? Bool == true && mode == expectedMode && oauthPreserved != false
            _ = self.operations.update(snapshot, state: ok ? .succeeded : .failed, stage: "complete", progress: 1, summary: ok ? "\(title) completed" : "\(title) needs action")
            guard ok else {
                self.providerStatus.stringValue = "\(title) was not confirmed · \(self.structuredPublicDetail(parsed, fallback: result.output)) No routing or OAuth change was assumed."
                return
            }
            self.desktopFullRoutingNow = expectedMode == "desktop-native-bridge"
            self.codexLbSelectedNow = false
            self.chatgptOauthPresentNow = routing?.chatgptOauthPresent ?? self.chatgptOauthPresentNow
            self.renderActiveProviderSummary()
            self.providerStatus.stringValue = self.desktopFullRoutingNow
                ? "Codex LB mode enabled · OAuth preserved · capability verification still required."
                : "ChatGPT OAuth mode active · Codex LB Desktop routing disabled."
            self.refresh()
        }
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
        performCliCommand(["codex-lb", "use-cli", "--json"], title: "Configure saved CLI provider", kind: "codex-lb-use-cli")
    }
    private func performCliCommand(_ args: [String], title: String, kind: String) {
        guard !busy else { cliProviderStatus.stringValue = "Another provider action is already running."; return }
        guard let snapshot = operations.begin(kind: kind, mutationGroup: "codex-config", summary: title) else {
            cliProviderStatus.stringValue = "Another guarded mutation is already running. Wait or open Diagnostics."
            return
        }
        setBusy(true)
        cliProviderStatus.stringValue = "\(title)…"
        _ = operations.update(snapshot, state: .running, stage: "configuring", progress: nil, summary: title)
        processClient.run(args, timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.setBusy(false)
            let parsed = self.json(result.output)
            let routing = parsed.map(ProviderRoutingTruth.snapshot(from:))
            let mode = routing?.mode
            let oauthPreserved = routing.flatMap { $0.oauthPreservedFlag }
            let authMutated = routing.flatMap { $0.authMutated }
            let ok = result.code == 0 && parsed?["ok"] as? Bool == true && mode == "cli-provider" && oauthPreserved != false && authMutated != true
            _ = self.operations.update(snapshot, state: ok ? .succeeded : .failed, stage: "complete", progress: 1, summary: ok ? "CLI provider configured" : "CLI provider configuration needs action")
            self.cliProviderStatus.stringValue = ok
                ? "CLI provider configured · Desktop OAuth and global provider selection unchanged · Test still required."
                : "CLI provider was not confirmed · \(self.structuredPublicDetail(parsed, fallback: result.output))"
            if ok { self.refresh() }
        }
    }
    @objc private func testConnection() {
        guard !busy else { cliProviderStatus.stringValue = "Another provider action is already running."; return }
        guard let snapshot = operations.begin(kind: "codex-lb-health", mutationGroup: nil, summary: "Test CLI provider") else {
            cliProviderStatus.stringValue = "Another guarded operation is already running. Wait or open Diagnostics."
            return
        }
        setBusy(true)
        cliProviderStatus.stringValue = "Testing CLI provider transport…"
        _ = operations.update(snapshot, state: .running, stage: "testing", progress: nil, summary: "Test CLI provider")
        processClient.run(["codex-lb", "health", "--json"], timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.setBusy(false)
            let parsed = self.json(result.output)
            let ok = result.code == 0 && parsed?["ok"] as? Bool == true
            let status = parsed?["status"] as? String ?? (ok ? "verified" : "failed")
            _ = self.operations.update(snapshot, state: ok ? .succeeded : .failed, stage: "complete", progress: 1, summary: ok ? "CLI provider transport verified" : "CLI provider test needs action")
            self.cliProviderStatus.stringValue = ok
                ? "CLI provider transport verified (\(status)). Desktop routing and OAuth were not changed."
                : "CLI provider test failed (\(status)) · \(self.structuredPublicDetail(parsed, fallback: result.output))"
        }
    }
    @objc private func copyCliCommand() {
        NSPasteboard.general.clearContents()
        let copied = NSPasteboard.general.setString(cliLaunchCommand, forType: .string)
        cliProviderStatus.stringValue = copied
            ? "Copied CLI command: \(cliLaunchCommand)"
            : "Could not copy the CLI command. Select it above and copy manually."
    }
    private func refreshFastStatus() {
        if !busy { fastStatus.stringValue = "Codex Fast: checking the official service-tier setting…" }
        processClient.run(["fast-mode", "status", "--json"], timeout: NativeView.statusTimeout) { [weak self] result in
            guard let self = self else { return }
            guard result.code == 0, let json = self.json(result.output),
                  let global = json["global"] as? [String: Any], let on = global["on"] as? Bool else {
                self.fastStatus.stringValue = "Codex Fast: unavailable — no state was assumed."
                return
            }
            let tier = global["service_tier"] as? String ?? (on ? "fast" : "default")
            self.fastStatus.stringValue = "Codex Fast: \(on ? "On" : "Off") · official service_tier=\(tier) · model and reasoning remain separate."
        }
    }
    @objc private func fastOn() { run(["fast-mode", "on", "--json"], title: "Codex Fast On", kind: "fast-mode-on", group: "codex-config", timeout: NativeView.statusTimeout) { [weak self] in self?.refreshFastStatus() } }
    @objc private func fastOff() { run(["fast-mode", "off", "--json"], title: "Codex Fast Off", kind: "fast-mode-off", group: "codex-config", timeout: NativeView.statusTimeout) { [weak self] in self?.refreshFastStatus() } }
}
