import Cocoa

extension ProvidersViewController {
    func refreshFastStatus() {
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
}
