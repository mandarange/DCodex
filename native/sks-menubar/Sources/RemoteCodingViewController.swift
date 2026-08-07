import Cocoa

final class RemoteCodingViewController: NSViewController {
    private static let websiteURL = URL(string: "https://paseo.sh/")!
    private static let docsURL = URL(string: "https://paseo.sh/docs")!

    override func loadView() {
        let websiteButton = NativeView.button(
            "Visit Paseo",
            target: self,
            action: #selector(openWebsite)
        )
        websiteButton.setAccessibilityLabel("Visit Paseo website")
        websiteButton.setAccessibilityHelp("Open the independent Paseo website in your default browser.")

        let docsButton = NativeView.button(
            "Read Paseo Docs",
            target: self,
            action: #selector(openDocs)
        )
        docsButton.setAccessibilityLabel("Read Paseo documentation")
        docsButton.setAccessibilityHelp("Open the official Paseo documentation in your default browser.")

        let recommendation = NativeView.card(
            title: "Paseo (recommended)",
            subtitle: "Run Codex from your desktop, phone, web browser, or terminal.",
            views: [
                NativeView.detail(
                    "Paseo is an independent open-source project. Sneakoscope does not install it, bundle its daemon, configure its authentication or relay, monitor it, or depend on it. Review Paseo's own documentation and security guidance before connecting devices."
                ),
                NativeView.row([websiteButton, docsButton])
            ]
        )

        view = NativeView.page([
            NativeView.title("Remote Coding"),
            NativeView.detail(
                "For remote and cross-device coding, Sneakoscope recommends evaluating Paseo as a separate companion for Codex."
            ),
            recommendation
        ])
    }

    @objc private func openWebsite() {
        NSWorkspace.shared.open(Self.websiteURL)
    }

    @objc private func openDocs() {
        NSWorkspace.shared.open(Self.docsURL)
    }
}
