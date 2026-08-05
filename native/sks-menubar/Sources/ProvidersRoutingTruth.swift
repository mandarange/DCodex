import Foundation

enum ProviderFacadeError: Error, Equatable, CustomStringConvertible {
    case schemaInvalid(String)

    var description: String {
        switch self { case .schemaInvalid(let reason): return reason }
    }
}

enum CapabilityProbeState: String, Codable, CaseIterable {
    case notAttempted = "not_attempted", running, verified, degraded, blocked, failed, unsupported, stale
}

enum CapabilityProbeStage: String, Codable {
    case preflight, process, tcpConnect = "tcp_connect", httpHealth = "http_health"
    case websocketUpgrade = "websocket_upgrade", websocketProtocol = "websocket_protocol"
    case providerAuth = "provider_auth", catalogSync = "catalog_sync", modelRoute = "model_route"
    case featureRequest = "feature_request", featureResponse = "feature_response"
    case artifactValidation = "artifact_validation", complete
}

enum CapabilityScope: String, Codable, CaseIterable {
    case bridge
    case nativeIdentity = "native-identity"
    case codexLb = "provider:codex-lb"
    case openRouter = "provider:openrouter"
    case combinedCatalog = "catalog:combined"

    var displayName: String {
        switch self {
        case .bridge: return "Bridge"
        case .nativeIdentity: return "OAuth Identity"
        case .codexLb: return "Codex-LB"
        case .openRouter: return "OpenRouter"
        case .combinedCatalog: return "Combined Catalog"
        }
    }
}

enum JSONValue: Codable, Equatable {
    case string(String), number(Double), boolean(Bool), object([String: JSONValue]), array([JSONValue]), null

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let boolean = try? value.decode(Bool.self) { self = .boolean(boolean) }
        else if let number = try? value.decode(Double.self) { self = .number(number) }
        else if let string = try? value.decode(String.self) { self = .string(string) }
        else if let object = try? value.decode([String: JSONValue].self) { self = .object(object) }
        else { self = .array(try value.decode([JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .string(let raw): try value.encode(raw)
        case .number(let raw): try value.encode(raw)
        case .boolean(let raw): try value.encode(raw)
        case .object(let raw): try value.encode(raw)
        case .array(let raw): try value.encode(raw)
        case .null: try value.encodeNil()
        }
    }
}

struct CapabilityProbeResultV3: Codable, Equatable {
    let schema: String
    let capability: String
    let scope: CapabilityScope
    let requestedLevel: String
    let stage: CapabilityProbeStage
    let state: CapabilityProbeState
    let checkedAt: String
    let reportId: String
    let correlationId: String
    let sessionId: String
    let attemptId: Int
    let terminal: Bool
    let rootCause: String?
    let blockers: [String]
    let warnings: [String]
    let retryable: Bool
    let recoveryAction: String?
    let source: String
    let evidence: [String: JSONValue]

    enum CodingKeys: String, CodingKey {
        case schema, capability, scope, stage, state, terminal, blockers, warnings, retryable, source, evidence
        case requestedLevel = "requested_level", checkedAt = "checked_at", reportId = "report_id"
        case correlationId = "correlation_id", sessionId = "session_id", attemptId = "attempt_id"
        case rootCause = "root_cause", recoveryAction = "recovery_action"
    }
}

struct ScopeCapabilitySummaryV3: Codable, Equatable {
    let schema: String
    let scope: CapabilityScope
    let state: CapabilityProbeState
    let checkedAt: String
    let capabilities: [String: CapabilityProbeResultV3]
    let blockers: [String]
    let warnings: [String]

    enum CodingKeys: String, CodingKey { case schema, scope, state, capabilities, blockers, warnings; case checkedAt = "checked_at" }
}

struct CatalogSyncStateV2: Codable, Equatable {
    let schema: String
    let providerId: String
    let state: String
    let source: String?
    let generation: String?
    let digest: String?
    let modelCount: Int?
    let checkedAt: String?
    let expiresAt: String?
    let blockers: [String]
    let warnings: [String]
    let recoveryAction: String?

    enum CodingKeys: String, CodingKey {
        case schema, state, source, generation, digest, blockers, warnings
        case providerId = "provider_id", modelCount = "model_count", checkedAt = "checked_at"
        case expiresAt = "expires_at", recoveryAction = "recovery_action"
    }
}

struct CombinedCatalogSyncStatusV1: Codable, Equatable {
    let schema: String
    let state: String
    let generation: String?
    let digest: String?
    let modelCount: Int?
    let routeCount: Int?
    let conflictCount: Int
    let checkedAt: String?
    let providers: [String: CatalogSyncStateV2]
    let blockers: [String]
    let warnings: [String]
    let recoveryAction: String?

    enum CodingKeys: String, CodingKey {
        case schema, state, generation, digest, providers, blockers, warnings
        case modelCount = "model_count", routeCount = "route_count", conflictCount = "conflict_count"
        case checkedAt = "checked_at", recoveryAction = "recovery_action"
    }
}

struct DesktopCapabilityReportV3: Codable, Equatable {
    struct Execution: Codable, Equatable { let ok: Bool; let status: String; let blockers: [String] }
    struct Summary: Codable, Equatable {
        let bridgeReady: Bool
        let activeRoutesReady: Bool
        let levelSatisfied: Bool
        let transportLevelSatisfied: Bool
        let deepLevelSatisfied: Bool
        let fullFeatureVerified: Bool
        let inactiveProviderFailures: [String]
        let blockers: [String]
        let warnings: [String]
        enum CodingKeys: String, CodingKey {
            case blockers, warnings
            case bridgeReady = "bridge_ready", activeRoutesReady = "active_routes_ready", levelSatisfied = "level_satisfied"
            case transportLevelSatisfied = "transport_level_satisfied", deepLevelSatisfied = "deep_level_satisfied"
            case fullFeatureVerified = "full_feature_verified", inactiveProviderFailures = "inactive_provider_failures"
        }
    }

    let schema: String
    let reportId: String
    let correlationId: String
    let sessionId: String
    let requestedLevel: String
    let checkedAt: String
    let catalogGeneration: String?
    let execution: Execution
    let bridge: ScopeCapabilitySummaryV3
    let nativeIdentity: ScopeCapabilitySummaryV3
    let providers: [String: ScopeCapabilitySummaryV3]
    let combinedCatalog: ScopeCapabilitySummaryV3
    let summary: Summary
    let catalogSync: CombinedCatalogSyncStatusV1

    enum CodingKeys: String, CodingKey {
        case schema, execution, bridge, providers, summary
        case reportId = "report_id", correlationId = "correlation_id", sessionId = "session_id"
        case requestedLevel = "requested_level", checkedAt = "checked_at", catalogGeneration = "catalog_generation"
        case nativeIdentity = "native_identity", combinedCatalog = "combined_catalog", catalogSync = "catalog_sync"
    }

    var maximumAttemptId: Int { allProbes.map(\.attemptId).max() ?? 0 }
    var allProbes: [CapabilityProbeResultV3] { scopeSummaries.flatMap { $0.capabilities.values } }
    var scopeSummaries: [ScopeCapabilitySummaryV3] {
        [bridge, nativeIdentity, providers["codex-lb"], providers["openrouter"], combinedCatalog].compactMap { $0 }
    }

    static func decode(from json: [String: Any]) throws -> DesktopCapabilityReportV3 {
        let payload: [String: Any]
        if json["schema"] as? String == "sks.desktop-capabilities.v3" { payload = json }
        else if let nested = ["report", "capability_report", "desktop_capabilities", "capabilities"].compactMap({ json[$0] as? [String: Any] }).first(where: { $0["schema"] as? String == "sks.desktop-capabilities.v3" }) { payload = nested }
        else { throw ProviderFacadeError.schemaInvalid("capability_schema_invalid") }
        guard payload["catalog_sync"] is [String: Any] else {
            throw ProviderFacadeError.schemaInvalid("capability_schema_invalid: catalog_sync missing")
        }
        do {
            let report = try JSONDecoder().decode(Self.self, from: JSONSerialization.data(withJSONObject: payload))
            try report.validate()
            return report
        } catch let error as ProviderFacadeError { throw error }
        catch { throw ProviderFacadeError.schemaInvalid("capability_schema_invalid: \(error)") }
    }

    private func validate() throws {
        guard schema == "sks.desktop-capabilities.v3", !reportId.isEmpty, !correlationId.isEmpty, !sessionId.isEmpty,
              ["shallow", "transport", "deep"].contains(requestedLevel),
              providers["codex-lb"] != nil, providers["openrouter"] != nil,
              bridge.scope == .bridge, nativeIdentity.scope == .nativeIdentity,
              providers["codex-lb"]?.scope == .codexLb, providers["openrouter"]?.scope == .openRouter,
              combinedCatalog.scope == .combinedCatalog else {
            throw ProviderFacadeError.schemaInvalid("capability_schema_invalid")
        }
        guard catalogSync.schema == "sks.combined-catalog-sync.v1",
              catalogSync.providers["codex-lb"]?.schema == "sks.catalog-sync-state.v2",
              catalogSync.providers["openrouter"]?.schema == "sks.catalog-sync-state.v2" else {
            throw ProviderFacadeError.schemaInvalid("capability_schema_invalid: catalog_sync invalid")
        }
        for scope in scopeSummaries {
            guard scope.schema == "sks.scope-capability-summary.v1" else { throw ProviderFacadeError.schemaInvalid("capability_schema_invalid: scope summary invalid") }
            for (key, probe) in scope.capabilities {
                guard probe.schema == "sks.capability-probe.v3", probe.scope == scope.scope,
                      probe.capability == key, probe.reportId == reportId,
                      probe.correlationId == correlationId, probe.sessionId == sessionId, probe.attemptId >= 0 else {
                    throw ProviderFacadeError.schemaInvalid("capability_schema_invalid: probe identity invalid")
                }
            }
        }
        let correlations = Set(allProbes.map(\.correlationId))
        guard correlations.count == 1 else {
            throw ProviderFacadeError.schemaInvalid("capability_schema_invalid: correlation mismatch")
        }
        guard catalogGeneration == catalogSync.generation else {
            throw ProviderFacadeError.schemaInvalid("capability_schema_invalid: catalog generation mismatch")
        }
    }
}

struct DesktopBridgeStatusV3Truth {
    let raw: [String: Any]
    let checkedAt: String
    let correlationId: String
    let capabilities: DesktopCapabilityReportV3?

    static func decode(from json: [String: Any]) throws -> DesktopBridgeStatusV3Truth {
        guard json["schema"] as? String == "sks.desktop-bridge-status.v3",
              let checkedAt = nonempty(json["checked_at"]), let correlationId = nonempty(json["correlation_id"]),
              let management = json["management"] as? [String: Any],
              let service = json["service"] as? [String: Any],
              let identity = json["native_identity"] as? [String: Any],
              let providers = json["providers"] as? [String: Any],
              let routing = json["routing"] as? [String: Any],
              let catalog = json["catalog_sync"] as? [String: Any],
              let readiness = json["readiness"] as? [String: Any] else {
            throw ProviderFacadeError.schemaInvalid("desktop_bridge_status_schema_invalid")
        }
        let managed = management["managed"] as? Bool == true
        let managementValid = managed
            ? management["runtime"] as? String == "desktop-bridge" && management["reason"] is NSNull
            : management["runtime"] is NSNull && ["not_installed", "stopped"].contains(management["state"] as? String ?? "")
        guard managementValid,
              service["installed"] is Bool, service["loaded"] is Bool, service["running"] is Bool,
              nonempty(service["checked_at"]) != nil, identity["configured"] is Bool,
              routing["fallback"] as? String == "none", readiness["ready"] is Bool,
              ["ready", "awaiting_provider", "degraded", "blocked", "unmanaged"].contains(readiness["state"] as? String ?? ""),
              profileValid(providers["codex-lb"], id: "codex-lb"),
              profileValid(providers["openrouter"], id: "openrouter") else {
            throw ProviderFacadeError.schemaInvalid("desktop_bridge_status_schema_invalid")
        }
        if let policy = routing["policy"] as? [String: Any] {
            guard policy["schema"] as? String == "sks.bridge-routing-policy.v1", policy["fallback"] as? String == "none" else {
                throw ProviderFacadeError.schemaInvalid("desktop_bridge_status_schema_invalid: routing policy")
            }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: catalog),
              let decodedCatalog = try? JSONDecoder().decode(CombinedCatalogSyncStatusV1.self, from: data),
              decodedCatalog.schema == "sks.combined-catalog-sync.v1" else {
            throw ProviderFacadeError.schemaInvalid("desktop_bridge_status_schema_invalid: catalog_sync")
        }
        let report: DesktopCapabilityReportV3?
        if json["capabilities"] is NSNull || json["capabilities"] == nil { report = nil }
        else {
            report = try DesktopCapabilityReportV3.decode(from: json)
            guard report?.correlationId == correlationId else {
                throw ProviderFacadeError.schemaInvalid("desktop_bridge_status_schema_invalid: correlation mismatch")
            }
        }
        return DesktopBridgeStatusV3Truth(raw: json, checkedAt: checkedAt, correlationId: correlationId, capabilities: report)
    }

    private static func profileValid(_ value: Any?, id: String) -> Bool {
        guard let profile = value as? [String: Any], profile["schema"] as? String == "sks.bridge-provider-profile-status.v1",
              profile["provider_id"] as? String == id, profile["enabled"] is Bool,
              profile["credential"] is [String: Any], profile["endpoint"] is [String: Any],
              let catalog = profile["catalog"] as? [String: Any],
              let capabilities = profile["capabilities"] as? [String: Any] else { return false }
        return catalog["schema"] as? String == "sks.catalog-sync-state.v2"
            && capabilities["schema"] as? String == "sks.scope-capability-summary.v1"
            && capabilities["scope"] as? String == "provider:\(id)"
    }

    private static func nonempty(_ value: Any?) -> String? {
        guard let string = value as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

struct CapabilityDisplayRow: Equatable {
    let scope: CapabilityScope
    let capability: String
    let state: CapabilityProbeState
    let route: String
    let oauthRequirement: String
    let checkedAt: String
    let stage: CapabilityProbeStage
    let rootCause: String?
    let recoveryAction: String?

    static func rows(from report: DesktopCapabilityReportV3) -> [CapabilityDisplayRow] {
        report.scopeSummaries.flatMap { summary in
            summary.capabilities.keys.sorted().compactMap { key in
                guard let probe = summary.capabilities[key] else { return nil }
                let route = evidenceString(probe.evidence["route"]) ?? evidenceString(probe.evidence["provider_route"]) ?? "none"
                let oauth = evidenceString(probe.evidence["oauth_requirement"]) ?? (summary.scope == .nativeIdentity ? "required" : "not required")
                return CapabilityDisplayRow(scope: summary.scope, capability: key, state: probe.state, route: route,
                    oauthRequirement: oauth, checkedAt: probe.checkedAt, stage: probe.stage,
                    rootCause: probe.rootCause, recoveryAction: probe.recoveryAction)
            }
        }
    }

    private static func evidenceString(_ value: JSONValue?) -> String? {
        if case .string(let raw)? = value { return raw }
        return nil
    }
}

// Compatibility adapter for the 8.1.2 status facade. Active v3 rendering does not
// use mode strings, recurse through blockers, or infer provider ownership.
struct ProviderRoutingTruth {
    enum MeasuredState: Equatable { case inactive, active, degraded, unverified }
    struct MeasuredRoute {
        let selected: Bool, measured: Bool, fresh: Bool, ok: Bool
        let status: String
        let configuredHost: String?, actualHost: String?, authTransport: String?, authOutcome: String?
        let httpStatus: Int?, measuredAt: String?, latencyMs: Int?
        let blockers: [String]
        var active: Bool { selected && measured && fresh && ok && status == "verified" }
        var state: MeasuredState { !selected ? .inactive : active ? .active : (!measured || !fresh || status == "stale") ? .unverified : .degraded }
    }
    struct Snapshot {
        let mode: String?, desktopFullRouting: Bool, legacyCodexLbSelected: Bool, chatgptOauthPresent: Bool
        let cliProviderStored: Bool, cliCredentialsConfigured: Bool, legacyDestructive: Bool
        let oauthPreservedFlag: Bool?, authMutated: Bool?
    }
    static func snapshot(from json: [String: Any]) -> Snapshot {
        let mode = (json["desktop_mode"] as? String) ?? (json["mode"] as? String)
        let oauth = json["oauth"] as? [String: Any], provider = json["provider"] as? [String: Any], bridge = json["bridge"] as? [String: Any]
        let oauthPresent = json["chatgpt_oauth_present"] as? Bool ?? (oauth?["present"] as? Bool == true)
        let providerId = provider?["id"] as? String
        let providerSelected = provider?["selected"] as? Bool
        let legacy = (providerId == "codex-lb" && providerSelected == true)
            || (providerId == "openai" && providerSelected == false && ["cli-provider", "desktop-native-bridge"].contains(mode ?? ""))
        return Snapshot(mode: mode, desktopFullRouting: mode == "desktop-native-bridge", legacyCodexLbSelected: legacy,
            chatgptOauthPresent: oauthPresent, cliProviderStored: mode == "cli-provider" || mode == "desktop-native-bridge",
            cliCredentialsConfigured: json["configured"] as? Bool == true || (bridge?["key_fingerprint"] as? String)?.isEmpty == false,
            legacyDestructive: json["legacy_destructive_state"] as? Bool == true,
            oauthPreservedFlag: json["oauth_preserved"] as? Bool ?? oauth?["preserved"] as? Bool,
            authMutated: json["auth_mutated"] as? Bool)
    }
    static func measuredRoute(from json: [String: Any]) -> MeasuredRoute? {
        guard let value = json["routing_truth"] as? [String: Any], value["schema"] as? String == "sks.codex-lb-routing-truth.v1" else { return nil }
        return MeasuredRoute(selected: value["selected"] as? Bool == true, measured: value["measured"] as? Bool == true,
            fresh: value["fresh"] as? Bool == true, ok: value["ok"] as? Bool == true, status: value["status"] as? String ?? "unavailable",
            configuredHost: value["configured_host"] as? String, actualHost: value["actual_host"] as? String,
            authTransport: value["auth_transport"] as? String, authOutcome: value["auth_outcome"] as? String,
            httpStatus: (value["http_status"] as? NSNumber)?.intValue, measuredAt: value["measured_at"] as? String,
            latencyMs: (value["latency_ms"] as? NSNumber)?.intValue, blockers: value["blockers"] as? [String] ?? [])
    }
}

struct CodexLbConnectTestTruth {
    static let maximumAcceptedOutputTokens = 128, maximumRenderedReplyCharacters = 240
    struct Success { let model: String, latencyMs: Int, responseId: String, reply: String, inputTokens: Int, outputTokens: Int, totalTokens: Int, httpStatus: Int; var renderedSummary: String { "Model \(model) · latency \(latencyMs) ms · tokens \(inputTokens) in / \(outputTokens) out / \(totalTokens) total · reply: \(reply)" } }
    static func success(from json: [String: Any]) -> Success? {
        guard validationFailure(from: json) == "none", let model = string(json["model"]), let latency = integer(json["latency_ms"]),
              let response = string(json["response_id"]), let reply = string(json["result"]), let usage = json["usage"] as? [String: Any],
              let input = integer(usage["input_tokens"]), let output = integer(usage["output_tokens"]), let total = integer(usage["total_tokens"]),
              let http = integer(json["http_status"]) else { return nil }
        return Success(model: model, latencyMs: latency, responseId: response, reply: boundedReply(reply), inputTokens: input, outputTokens: output, totalTokens: total, httpStatus: http)
    }
    static func validationFailure(from json: [String: Any]) -> String {
        guard json["schema"] as? String == "sks.codex-lb-connect-test.v1" else { return "unexpected or missing schema" }
        guard json["ok"] as? Bool == true, json["status"] as? String == "connected" else { return "ok was not true" }
        guard string(json["model"]) != nil, let latency = integer(json["latency_ms"]), latency >= 0, string(json["response_id"]) != nil else { return "model evidence is missing" }
        guard string(json["result"]) != nil else { return "returned reply is empty" }
        guard json["result_truncated"] as? Bool != nil, let http = integer(json["http_status"]), (200..<300).contains(http) else { return "HTTP success evidence is invalid" }
        guard let blockers = json["blockers"] as? [String], blockers.isEmpty, let usage = json["usage"] as? [String: Any],
              let input = integer(usage["input_tokens"]), let output = integer(usage["output_tokens"]), let total = integer(usage["total_tokens"]),
              input >= 0, output >= 0, total == input + output else { return "token usage evidence is invalid" }
        return output <= maximumAcceptedOutputTokens ? "none" : "low-token request evidence is invalid"
    }
    static func boundedReply(_ value: String) -> String { let compact = value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " "); return compact.count <= maximumRenderedReplyCharacters ? compact : String(compact.prefix(maximumRenderedReplyCharacters)) + "…" }
    private static func string(_ value: Any?) -> String? { guard let raw = value as? String else { return nil }; let clean = raw.trimmingCharacters(in: .whitespacesAndNewlines); return clean.isEmpty ? nil : clean }
    private static func integer(_ value: Any?) -> Int? { guard !(value is Bool), let number = value as? NSNumber, number.doubleValue.rounded(.towardZero) == number.doubleValue else { return nil }; return number.intValue }
}
