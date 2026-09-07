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
        guard let raw = (status?["auth_priority"] ?? result?["auth_priority"] ?? payload["auth_priority"]) as? [String: Any],
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
            case "desktop_bridge_not_running", "desktop_bridge_runtime_not_ready": return "On, unavailable · open Bridge diagnostics and repair the bridge service"
            case "codex_lb_route_not_ready", "codex_lb_eligible_route_missing": return "On, unavailable · validate Codex-LB and refresh its model catalog"
            default: return "On, unavailable · check your Codex-LB connection below"
            }
        }
    }
}

/// Command execution and the persisted preference are separate facts. A service
/// failure after the write must never be presented as a preference rollback.
enum AuthPriorityMutationOutcome: Equatable {
    case saved(AuthPriorityState)
    case savedWithSetupIssue(AuthPriorityState)
    case notApplied(AuthPriorityState)
    case unconfirmed

    static func resolve(payload: [String: Any]?, desired: Bool, commandSucceeded: Bool, responseComplete: Bool) -> AuthPriorityMutationOutcome {
        guard responseComplete, let payload = payload, let state = AuthPriorityState.decode(payload) else { return .unconfirmed }
        guard state.enabled == desired else { return .notApplied(state) }
        return commandSucceeded ? .saved(state) : .savedWithSetupIssue(state)
    }

    var observedState: AuthPriorityState? {
        switch self {
        case .saved(let state), .savedWithSetupIssue(let state), .notApplied(let state): return state
        case .unconfirmed: return nil
        }
    }

    var operationSummary: String {
        switch self {
        case .saved: return "Codex-LB preference saved"
        case .savedWithSetupIssue: return "Codex-LB preference saved; connection setup needs attention"
        case .notApplied: return "Requested Codex-LB preference was not saved; current setting confirmed"
        case .unconfirmed: return "Codex-LB saved preference could not be confirmed"
        }
    }
}
