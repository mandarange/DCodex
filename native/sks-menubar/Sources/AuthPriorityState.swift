import Foundation

/// The preference can be saved even when the selected provider is unavailable.
/// Preserve that distinction instead of presenting an unavailable connection as off.
struct AuthPriorityState: Equatable {
    let enabled: Bool
    let state: String
    let error: String?

    static func decode(_ payload: [String: Any]) -> AuthPriorityState? {
        let result = payload["result"] as? [String: Any]
        let status = payload["status"] as? [String: Any]
        guard let raw = (result?["auth_priority"] ?? status?["auth_priority"] ?? payload["auth_priority"]) as? [String: Any],
              let enabled = raw["enabled"] as? Bool,
              let state = raw["state"] as? String,
              ["off", "active", "unavailable"].contains(state),
              enabled ? state != "off" : state == "off" else { return nil }
        return AuthPriorityState(enabled: enabled, state: state, error: raw["error"] as? String)
    }

    var message: String {
        switch state {
        case "active": return "On · Codex-LB is the preferred connection"
        case "off": return "Off · use the configured model route"
        default:
            switch error {
            case "codex_lb_provider_disabled": return "On, unavailable · enable Codex-LB below"
            case "codex_lb_credential_missing": return "On, unavailable · connect your Codex-LB account below"
            case "codex_lb_route_not_ready", "codex_lb_eligible_route_missing": return "On, unavailable · validate Codex-LB and refresh its model catalog"
            default: return "On, unavailable · check your Codex-LB connection below"
            }
        }
    }
}
