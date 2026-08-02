import Foundation

/// Parses `sks.codex-lb-status.v2` / activation payloads without treating
/// `provider.selected` as "codex-lb is selected". In cli-provider and native-
/// bridge modes, `provider.selected == true` means the built-in OpenAI /
/// ChatGPT OAuth provider is selected.
struct ProviderRoutingTruth {
    enum MeasuredState: Equatable {
        case inactive
        case active
        case degraded
        case unverified
    }

    struct MeasuredRoute {
        let selected: Bool
        let measured: Bool
        let fresh: Bool
        let ok: Bool
        let status: String
        let configuredHost: String?
        let actualHost: String?
        let authTransport: String?
        let authOutcome: String?
        let httpStatus: Int?
        let measuredAt: String?
        let latencyMs: Int?
        let blockers: [String]

        var active: Bool {
            selected && measured && fresh && ok && status == "verified"
        }

        var state: MeasuredState {
            guard selected else { return .inactive }
            if active { return .active }
            if !measured || !fresh || status == "selected_unmeasured" || status == "stale" {
                return .unverified
            }
            return .degraded
        }
    }

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

    static func measuredRoute(from json: [String: Any]) -> MeasuredRoute? {
        guard let truth = json["routing_truth"] as? [String: Any],
              truth["schema"] as? String == "sks.codex-lb-routing-truth.v1" else {
            return nil
        }
        return MeasuredRoute(
            selected: truth["selected"] as? Bool == true,
            measured: truth["measured"] as? Bool == true,
            fresh: truth["fresh"] as? Bool == true,
            ok: truth["ok"] as? Bool == true,
            status: truth["status"] as? String ?? "unavailable",
            configuredHost: truth["configured_host"] as? String,
            actualHost: truth["actual_host"] as? String,
            authTransport: truth["auth_transport"] as? String,
            authOutcome: truth["auth_outcome"] as? String,
            httpStatus: (truth["http_status"] as? NSNumber)?.intValue,
            measuredAt: truth["measured_at"] as? String ?? truth["checked_at"] as? String,
            latencyMs: (truth["latency_ms"] as? NSNumber)?.intValue,
            blockers: truth["blockers"] as? [String] ?? []
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

extension ProvidersViewController {
    func describeRoutingTruth(_ route: ProviderRoutingTruth.MeasuredRoute?) -> String {
        guard let route = route else { return "measured route unavailable · blocker=codex_lb_routing_truth_unavailable" }
        let host = route.actualHost ?? route.configuredHost ?? "host unavailable"
        let auth = route.authOutcome ?? "auth unmeasured"
        let measuredAt = route.measuredAt ?? "time unavailable"
        let latency = route.latencyMs.map { "\($0) ms" } ?? "latency unavailable"
        let http = route.httpStatus.map { " · HTTP \($0)" } ?? ""
        let blockers = route.blockers.isEmpty ? "" : " · blockers=\(route.blockers.prefix(3).joined(separator: ", "))"
        return "status=\(route.status) · host=\(host) · auth=\(auth) · measured=\(measuredAt) · latency=\(latency)\(http)\(blockers)"
    }

    func renderMeasuredRoutingBadge(_ route: ProviderRoutingTruth.MeasuredRoute?, routeExpected: Bool) {
        guard let route = route else {
            if routeExpected {
                ControlKit.setBadge(activeProviderBadge, text: "Codex LB · unverified · blocker=codex_lb_routing_truth_unavailable", tone: .warning)
            }
            return
        }
        guard route.selected else { return }
        switch route.state {
        case .active:
            ControlKit.setBadge(activeProviderBadge, text: "Codex LB · active · \(describeRoutingTruth(route))", tone: .ok)
        case .degraded:
            ControlKit.setBadge(activeProviderBadge, text: "Codex LB · degraded · \(describeRoutingTruth(route))", tone: .warning)
        case .unverified:
            ControlKit.setBadge(activeProviderBadge, text: "Codex LB · unverified · \(describeRoutingTruth(route))", tone: .warning)
        case .inactive:
            break
        }
    }
}

struct CodexLbConnectTestTruth {
    static let schema = "sks.codex-lb-connect-test.v1"
    static let maximumAcceptedOutputTokens = 128
    static let maximumRenderedReplyCharacters = 240

    struct Success {
        let model: String
        let latencyMs: Int
        let responseId: String
        let reply: String
        let inputTokens: Int
        let outputTokens: Int
        let totalTokens: Int
        let httpStatus: Int

        var renderedSummary: String {
            "Model \(model) · latency \(latencyMs) ms · tokens \(inputTokens) in / \(outputTokens) out / \(totalTokens) total · reply: \(reply)"
        }
    }

    static func success(from json: [String: Any]) -> Success? {
        guard validationFailure(from: json) == "none",
              let model = nonemptyString(json["model"]),
              let latencyMs = integer(json["latency_ms"]),
              let responseId = nonemptyString(json["response_id"]),
              let rawReply = nonemptyString(json["result"]),
              let usage = json["usage"] as? [String: Any],
              let inputTokens = integer(usage["input_tokens"]),
              let outputTokens = integer(usage["output_tokens"]),
              let totalTokens = integer(usage["total_tokens"]),
              let httpStatus = integer(json["http_status"]) else { return nil }
        return Success(
            model: model,
            latencyMs: latencyMs,
            responseId: responseId,
            reply: boundedReply(rawReply),
            inputTokens: inputTokens,
            outputTokens: outputTokens,
            totalTokens: totalTokens,
            httpStatus: httpStatus
        )
    }

    static func validationFailure(from json: [String: Any]) -> String {
        guard json["schema"] as? String == schema else { return "unexpected or missing schema" }
        guard json["ok"] as? Bool == true else { return publicFailure(from: json) }
        guard json["status"] as? String == "connected" else { return "status is not connected" }
        guard nonemptyString(json["model"]) != nil else { return "model evidence is missing" }
        guard let latencyMs = integer(json["latency_ms"]), latencyMs >= 0 else { return "latency evidence is invalid" }
        guard nonemptyString(json["response_id"]) != nil else { return "response id is missing" }
        guard nonemptyString(json["result"]) != nil else { return "returned reply is empty" }
        guard json["result_truncated"] as? Bool != nil else { return "result bound evidence is missing" }
        guard let httpStatus = integer(json["http_status"]), (200..<300).contains(httpStatus) else {
            return "HTTP success evidence is invalid"
        }
        guard let blockers = json["blockers"] as? [String], blockers.isEmpty else {
            return "success blockers are not empty"
        }
        guard let usage = json["usage"] as? [String: Any],
              let inputTokens = integer(usage["input_tokens"]), inputTokens >= 0,
              let outputTokens = integer(usage["output_tokens"]), outputTokens >= 0,
              let totalTokens = integer(usage["total_tokens"]), totalTokens >= 0,
              totalTokens == inputTokens + outputTokens else { return "token usage evidence is invalid" }
        guard outputTokens <= maximumAcceptedOutputTokens else { return "low-token request evidence is invalid" }
        return "none"
    }

    static func boundedReply(_ value: String) -> String {
        let compact = value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard compact.count > maximumRenderedReplyCharacters else { return compact }
        return String(compact.prefix(maximumRenderedReplyCharacters)) + "…"
    }

    private static func publicFailure(from json: [String: Any]) -> String {
        if let blockers = json["blockers"] as? [String], !blockers.isEmpty {
            return "blocked: \(blockers.prefix(3).joined(separator: ", "))"
        }
        if let error = nonemptyString(json["error"]) { return boundedReply(error) }
        if let status = nonemptyString(json["status"]) { return "status=\(boundedReply(status))" }
        return "ok was not true"
    }

    private static func nonemptyString(_ value: Any?) -> String? {
        guard let raw = value as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func integer(_ value: Any?) -> Int? {
        guard !(value is Bool), let number = value as? NSNumber else { return nil }
        let double = number.doubleValue
        guard double.isFinite,
              double.rounded(.towardZero) == double,
              double >= Double(Int.min),
              double <= Double(Int.max) else { return nil }
        return number.intValue
    }
}
