import Foundation

/// Parses `sks.codex-lb-status.v2` / activation payloads without treating
/// `provider.selected` as "codex-lb is selected". In cli-provider and native-
/// bridge modes, `provider.selected == true` means the built-in OpenAI /
/// ChatGPT OAuth provider is selected.
struct ProviderRoutingTruth {
    struct Snapshot {
        let mode: String?
        let desktopFullRouting: Bool
        let legacyCodexLbSelected: Bool
        let chatgptOauthPresent: Bool
        let cliProviderStored: Bool
        let cliCredentialsConfigured: Bool
        let legacyDestructive: Bool
        let oauthPreservedFlag: Bool?
        let authMutated: Bool?
    }

    static func snapshot(from json: [String: Any]) -> Snapshot {
        let mode = desktopMode(json)
        let oauth = json["oauth"] as? [String: Any]
        let provider = json["provider"] as? [String: Any]
        let capabilities = json["capabilities"] as? [String: Any]
        let bridge = json["bridge"] as? [String: Any]
        let legacyPayload = (json["codex_lb"] as? [String: Any]) ?? json
        let chatgptOauthPresent = json["chatgpt_oauth_present"] as? Bool
            ?? (oauth?["present"] as? Bool == true
                || ["chatgpt_oauth", "mixed"].contains(oauth?["mode"] as? String ?? ""))
        let legacyCodexLbSelected = json["legacy_codex_lb_selected"] as? Bool
            ?? isLegacyCodexLbSelected(json: json, mode: mode, provider: provider)
        let cliProviderStored = ["cli-provider", "desktop-native-bridge", "desktop-dual-auth-compat"].contains(mode ?? "")
            || legacyPayload["provider_configured"] as? Bool == true
            || ((provider?["contract"] as? String)?.hasPrefix("codex-lb") == true)
        let keyFingerprint = bridge?["key_fingerprint"] as? String
        let cliCredentialsConfigured = legacyPayload["env_key_configured"] as? Bool == true
            || legacyPayload["key_configured"] as? Bool == true
            || json["configured"] as? Bool == true
            || (keyFingerprint?.isEmpty == false)
        let oauthPreservedFlag = (json["oauth_preserved"] as? Bool)
            ?? (capabilities?["oauth_preserved"] as? Bool)
            ?? (oauth?["preserved"] as? Bool)
        return Snapshot(
            mode: mode,
            desktopFullRouting: mode == "desktop-native-bridge",
            legacyCodexLbSelected: legacyCodexLbSelected,
            chatgptOauthPresent: chatgptOauthPresent,
            cliProviderStored: cliProviderStored,
            cliCredentialsConfigured: cliCredentialsConfigured,
            legacyDestructive: isLegacyDestructive(json),
            oauthPreservedFlag: oauthPreservedFlag,
            authMutated: json["auth_mutated"] as? Bool ?? json["desktop_auth_mutated"] as? Bool
        )
    }

    static func desktopMode(_ json: [String: Any]) -> String? {
        if let mode = json["desktop_mode"] as? String, !mode.isEmpty { return mode }
        if let mode = json["mode"] as? String, !mode.isEmpty { return mode }
        if let routing = json["desktop_routing"] as? [String: Any],
           let mode = routing["mode"] as? String, !mode.isEmpty {
            return mode
        }
        return nil
    }

    private static func isLegacyCodexLbSelected(
        json: [String: Any],
        mode: String?,
        provider: [String: Any]?
    ) -> Bool {
        if let provider = provider {
            let id = provider["id"] as? String
            let selected = provider["selected"] as? Bool
            if id == "codex-lb", selected == true { return true }
            // status.v2 marks built-in OpenAI as selected=false when model_provider is still codex-lb
            // (legacy destructive selection). Do not treat ordinary disabled/OAuth mode as legacy.
            if id == "openai", selected == false,
               ["cli-provider", "desktop-native-bridge"].contains(mode ?? "") {
                return true
            }
            return false
        }
        // Legacy status payloads used a top-level selected flag for codex-lb activation.
        return json["selected"] as? Bool == true
    }

    private static func isLegacyDestructive(_ json: [String: Any]) -> Bool {
        if json["legacy_destructive_state"] as? Bool == true
            || json["legacy_migration_required"] as? Bool == true {
            return true
        }
        if let blockers = json["blockers"] as? [String],
           blockers.contains(where: { $0.contains("legacy") && $0.contains("migration") }) {
            return true
        }
        if let status = json["status"] as? String {
            return status.contains("legacy") && (status.contains("required") || status.contains("destructive"))
        }
        return false
    }
}

struct CapabilityVerificationTruth {
    static func deepEvidenceTrusted(in value: Any) -> Bool {
        if let object = value as? [String: Any] {
            if let validation = object["deep_evidence_validation"] as? [String: Any],
               validation["schema"] as? String == "sks.codex-lb-deep-evidence-validation.v1",
               validation["state"] as? String == "verified",
               validation["trusted"] as? Bool == true,
               (validation["blockers"] as? [Any])?.isEmpty == true { return true }
            return object.values.contains { deepEvidenceTrusted(in: $0) }
        }
        if let array = value as? [Any] { return array.contains { deepEvidenceTrusted(in: $0) } }
        return false
    }

    static func blockers(in value: Any) -> [String] {
        var result: [String] = []
        collectBlockers(value, into: &result)
        return Array(NSOrderedSet(array: result).array.compactMap { $0 as? String })
    }

    private static func collectBlockers(_ value: Any, into result: inout [String]) {
        if let object = value as? [String: Any] {
            if let blockers = object["blockers"] as? [String] { result.append(contentsOf: blockers) }
            for child in object.values { collectBlockers(child, into: &result) }
        } else if let array = value as? [Any] {
            for child in array { collectBlockers(child, into: &result) }
        }
    }
}
