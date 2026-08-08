import Foundation

enum CodexLifecyclePolicy {
    static func followsCodex(from config: [String: Any]?) -> Bool {
        if let current = config?["follow_codex_lifecycle"] as? Bool { return current }
        return config?["quit_with_codex"] as? Bool == true
    }

    static func initialVisibility(followCodex: Bool, codexRunning: Bool) -> Bool {
        !followCodex || codexRunning
    }

    static func visibilityAfterCodexLaunch() -> Bool { true }

    static func visibilityAfterCodexTermination(followCodex: Bool) -> Bool {
        !followCodex
    }
}
