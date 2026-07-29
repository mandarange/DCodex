import Cocoa

final class RemoteCodingViewController: NSViewController {
    private static let websiteURL = URL(string: "https://www.onorca.dev")!
    private static let sourceURL = URL(string: "https://github.com/stablyai/orca")!

    override func loadView() {
        let websiteButton = NativeView.button(
            "Visit Orca Website",
            target: self,
            action: #selector(openWebsite)
        )
        websiteButton.setAccessibilityHelp("Open the external Orca website in your default browser.")

        let sourceButton = NativeView.button(
            "View Orca on GitHub",
            target: self,
            action: #selector(openSource)
        )
        sourceButton.setAccessibilityHelp("Open the external Orca source repository in your default browser.")

        let recommendation = NativeView.card(
            title: "Explore Orca",
            subtitle: "A remote coding option maintained outside Sneakoscope.",
            views: [
                NativeView.detail(
                    "Orca is an external beta project from Stably AI. It is not part of Sneakoscope, and SKS does not install, configure, authenticate, monitor, or depend on it."
                ),
                NativeView.row([websiteButton, sourceButton])
            ]
        )

        view = NativeView.page([
            NativeView.title("Remote Coding"),
            NativeView.detail(
                "Looking for a remote coding companion? You can evaluate Orca independently using its website and open-source repository."
            ),
            recommendation
        ])
    }

    @objc private func openWebsite() {
        NSWorkspace.shared.open(Self.websiteURL)
    }

    @objc private func openSource() {
        NSWorkspace.shared.open(Self.sourceURL)
    }
}
