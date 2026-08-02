import Cocoa

extension ProvidersViewController {
    func makeCliConnectProgressView() -> NSStackView {
        cliConnectConfigurationStage.setAccessibilityLabel("Codex LB configuration stage: waiting")
        cliConnectConfigurationStage.setAccessibilityIdentifier("sks-center-codex-lb-configuration-stage")
        cliConnectRequestStage.setAccessibilityLabel("Codex LB one-request low-token test stage: waiting")
        cliConnectRequestStage.setAccessibilityIdentifier("sks-center-codex-lb-request-stage")
        cliConnectResponseStage.setAccessibilityLabel("Codex LB response stage: not received")
        cliConnectResponseStage.setAccessibilityIdentifier("sks-center-codex-lb-response-stage")
        cliConnectResult.setAccessibilityLabel("Codex LB connection proof result: not run")
        cliConnectResult.setAccessibilityIdentifier("sks-center-codex-lb-connect-result")
        let title = NativeView.sectionTitle("Connection Proof")
        title.setAccessibilityIdentifier("sks-center-codex-lb-connect-heading")
        let stack = NSStackView(views: [title, cliConnectProgress, cliConnectConfigurationStage, cliConnectRequestStage, cliConnectResponseStage, cliConnectResult])
        stack.orientation = .vertical
        stack.alignment = .width
        stack.spacing = 6
        stack.setAccessibilityRole(.group)
        stack.setAccessibilityLabel("Codex LB connection proof")
        stack.setAccessibilityIdentifier("sks-center-codex-lb-connect-proof")
        return stack
    }

    func renderCliConnectStages(
        progress: Double,
        configuration: String,
        request: String,
        response: String,
        result: String,
        tone: NSColor
    ) {
        cliConnectProgress.doubleValue = min(3, max(0, progress))
        cliConnectProgress.setAccessibilityValue("Stage \(Int(cliConnectProgress.doubleValue)) of 3")
        cliConnectConfigurationStage.stringValue = "1. Configuration · \(configuration)"
        cliConnectConfigurationStage.setAccessibilityLabel("Codex LB configuration stage: \(configuration)")
        cliConnectRequestStage.stringValue = "2. One-request low-token test · \(request)"
        cliConnectRequestStage.setAccessibilityLabel("Codex LB one-request low-token test stage: \(request)")
        cliConnectResponseStage.stringValue = "3. Response · \(response)"
        cliConnectResponseStage.setAccessibilityLabel("Codex LB response stage: \(response)")
        cliConnectResult.stringValue = result
        cliConnectResult.textColor = tone
        cliConnectResult.setAccessibilityLabel("Codex LB connection proof result: \(result)")
    }

    @objc func testConnection() {
        runConnectTest()
    }

    func runConnectTest() {
        guard !connectTestInFlight else {
            cliProviderStatus.stringValue = "A Codex LB connection proof is already running."
            return
        }
        guard !busy else { cliProviderStatus.stringValue = "Another provider action is already running."; return }
        guard let snapshot = operations.begin(kind: "codex-lb-connect-test", mutationGroup: nil, summary: "Run Codex LB connect test") else {
            cliProviderStatus.stringValue = "Another guarded operation is already running. Wait or open Diagnostics."
            return
        }
        connectTestInFlight = true
        setBusy(true)
        cliProviderStatus.stringValue = "Codex LB mode \(codexLbSelectedNow ? "selected" : "selection unconfirmed") · sending one bounded low-token request…"
        renderCliConnectStages(
            progress: 2,
            configuration: codexLbSelectedNow ? "CLI provider selected" : "selection unconfirmed",
            request: "sending one bounded request…",
            response: "waiting",
            result: "Waiting for structured proof. Connectivity has not been claimed.",
            tone: .secondaryLabelColor
        )
        _ = operations.update(snapshot, state: .running, stage: "one-request-low-token-test", progress: 2.0 / 3.0, summary: "Run Codex LB connect test")
        processClient.run(["codex-lb", "connect-test", "--json"], timeout: NativeView.mutationTimeout) { [weak self] result in
            guard let self = self else { return }
            self.connectTestInFlight = false
            self.setBusy(false)
            let parsed = self.json(result.output)
            let proof = parsed.flatMap(CodexLbConnectTestTruth.success(from:))
            let proved = result.code == 0 && proof != nil
            _ = self.operations.update(snapshot, state: proved ? .succeeded : .failed, stage: "complete", progress: 1, summary: proved ? "Codex LB connection proved" : "Codex LB connection proof failed")
            if let proof = proof, result.code == 0 {
                self.codexLbSelectedNow = true
                self.cliProviderStatus.stringValue = "Codex LB mode selected · connection proved by one live response."
                ControlKit.setBadge(self.activeProviderBadge, text: "Codex LB · active · model \(proof.model) · \(proof.latencyMs) ms", tone: .ok)
                self.renderCliConnectStages(
                    progress: 3,
                    configuration: "CLI provider selected",
                    request: "completed · \(proof.outputTokens) output tokens",
                    response: "received · id \(proof.responseId)",
                    result: proof.renderedSummary,
                    tone: .systemGreen
                )
                return
            }
            let selected = self.codexLbSelectedNow
            let failure = parsed.map(CodexLbConnectTestTruth.validationFailure(from:))
                ?? "structured connect-test JSON was not returned"
            self.cliProviderStatus.stringValue = selected
                ? "Codex LB mode is selected, but connection proof failed · \(failure)."
                : "Codex LB connection proof failed and provider selection is unconfirmed · \(failure)."
            if selected {
                ControlKit.setBadge(self.activeProviderBadge, text: "Codex LB · selected · connection proof failed", tone: .warning)
            }
            self.renderCliConnectStages(
                progress: 3,
                configuration: selected ? "CLI provider remains selected" : "selection unconfirmed",
                request: "completed without valid proof",
                response: "failed",
                result: selected
                    ? "Mode is selected, but connection proof failed · \(failure). Use Run Connect Test to retry."
                    : "Connection proof failed · \(failure). Confirm the provider, then retry.",
                tone: .systemRed
            )
        }
    }
}
