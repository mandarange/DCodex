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
    case frameRoundTrip = "frame_round_trip", cleanClose = "clean_close"
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
        guard json["schema"] as? String == "sks.desktop-capabilities.v3",
              json["catalog_sync"] is [String: Any] else {
            throw ProviderFacadeError.schemaInvalid("capability_schema_invalid: catalog_sync missing")
        }
        do {
            let report = try JSONDecoder().decode(Self.self, from: JSONSerialization.data(withJSONObject: json))
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
    private static let keys: Set<String> = [
        "schema", "checked_at", "correlation_id", "management", "service",
        "http_probe", "websocket_probe", "native_identity", "providers", "routing",
        "catalog_sync", "capabilities", "readiness", "recovery_actions",
        "ok", "execution_ok", "command_summary"
    ]
    let raw: [String: Any]
    let checkedAt: String
    let correlationId: String
    let capabilities: DesktopCapabilityReportV3?

    // The envelope trio (ok/execution_ok/command_summary) exists on top-level
    // `bridge status` output but NOT on the status object nested inside a
    // command result, so it is allowed and type-checked — never required.
    private static let envelopeKeys: Set<String> = ["ok", "execution_ok", "command_summary"]

    static func decode(from json: [String: Any]) throws -> DesktopBridgeStatusV3Truth {
        let required = keys.subtracting(envelopeKeys)
        guard required.isSubset(of: Set(json.keys)), Set(json.keys).isSubset(of: keys),
              json["schema"] as? String == "sks.desktop-bridge-status.v3",
              let checkedAt = nonempty(json["checked_at"]), let correlationId = nonempty(json["correlation_id"]),
              let management = json["management"] as? [String: Any],
              let service = json["service"] as? [String: Any],
              let identity = json["native_identity"] as? [String: Any],
              let providers = json["providers"] as? [String: Any],
              let routing = json["routing"] as? [String: Any],
              let catalog = json["catalog_sync"] as? [String: Any],
              let readiness = json["readiness"] as? [String: Any],
              json["recovery_actions"] is [String],
              json["ok"] == nil || json["ok"] is Bool,
              json["execution_ok"] == nil || json["execution_ok"] is Bool,
              json["command_summary"] == nil || nonempty(json["command_summary"]) != nil else {
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
              profileValid(providers["openrouter"], id: "openrouter"),
              transportProbeValid(json["http_probe"], websocket: false),
              transportProbeValid(json["websocket_probe"], websocket: true) else {
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
        else if let capabilities = json["capabilities"] as? [String: Any] {
            report = try DesktopCapabilityReportV3.decode(from: capabilities)
        } else { throw ProviderFacadeError.schemaInvalid("desktop_bridge_status_schema_invalid: capabilities") }
        return DesktopBridgeStatusV3Truth(raw: json, checkedAt: checkedAt, correlationId: correlationId, capabilities: report)
    }

    private static func transportProbeValid(_ value: Any?, websocket: Bool) -> Bool {
        if value is NSNull { return true }
        guard let probe = value as? [String: Any] else { return false }
        let expected: Set<String> = websocket
            ? ["schema", "state", "terminal_stage", "root_cause", "status_code", "negotiated_protocol",
               "upgrade_verified", "protocol_verified", "frame_round_trip_verified", "clean_close_verified",
               "latency_ms", "blockers", "warnings"]
            : ["schema", "state", "terminal_stage", "root_cause", "status_code", "latency_ms", "blockers", "warnings"]
        guard Set(probe.keys) == expected,
              probe["schema"] as? String == (websocket ? "sks.desktop-bridge-websocket-probe.v2" : "sks.desktop-bridge-http-probe.v1"),
              let state = probe["state"] as? String,
              let stage = probe["terminal_stage"] as? String,
              probe["root_cause"] is NSNull || probe["root_cause"] is String,
              probe["status_code"] is NSNull || probe["status_code"] is NSNumber,
              probe["latency_ms"] is NSNull || probe["latency_ms"] is NSNumber,
              probe["blockers"] is [String], probe["warnings"] is [String] else { return false }
        if websocket {
            guard ["not_attempted", "verified", "degraded", "blocked", "failed", "unsupported"].contains(state),
                  ["tcp_connect", "websocket_upgrade", "websocket_protocol", "frame_round_trip", "clean_close", "complete"].contains(stage),
                  probe["negotiated_protocol"] is NSNull || probe["negotiated_protocol"] is String,
                  probe["upgrade_verified"] is Bool, probe["protocol_verified"] is Bool,
                  probe["frame_round_trip_verified"] is Bool, probe["clean_close_verified"] is Bool else { return false }
            if state == "verified" {
                return stage == "complete" && probe["root_cause"] is NSNull
                    && probe["upgrade_verified"] as? Bool == true
                    && probe["protocol_verified"] as? Bool == true
                    && probe["frame_round_trip_verified"] as? Bool == true
                    && probe["clean_close_verified"] as? Bool == true
            }
            return state != "not_attempted"
                || probe["root_cause"] is NSNull && (probe["blockers"] as? [String])?.isEmpty == true
        }
        guard ["verified", "blocked", "failed", "unsupported"].contains(state),
              ["tcp_connect", "http_health", "complete"].contains(stage) else { return false }
        return state != "verified" || stage == "complete" && probe["root_cause"] is NSNull
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

struct DesktopBridgeCommandResultTruth: Equatable {
    private static let keys: Set<String> = [
        "schema", "operation", "operation_id", "correlation_id", "checked_at", "ok",
        "execution", "readiness", "status", "result", "recovery_action",
        "execution_ok", "command_summary"
    ]
    let completed: Bool
    let blockers: [String]
    let recoveryAction: String?

    static func decode(from json: [String: Any], expectedOperation: String) throws -> DesktopBridgeCommandResultTruth {
        guard Set(json.keys) == keys,
              json["schema"] as? String == "sks.desktop-bridge-command-result.v1",
              json["operation"] as? String == expectedOperation,
              nonempty(json["operation_id"]) != nil,
              nonempty(json["correlation_id"]) != nil,
              nonempty(json["checked_at"]) != nil,
              let topLevelOK = json["ok"] as? Bool,
              let execution = json["execution"] as? [String: Any],
              Set(execution.keys) == ["ok", "status", "blockers"],
              let executionOK = execution["ok"] as? Bool,
              let executionStatus = execution["status"] as? String,
              ["completed", "partial", "failed"].contains(executionStatus),
              let blockers = execution["blockers"] as? [String],
              let readiness = json["readiness"] as? [String: Any],
              Set(readiness.keys) == ["ready", "blockers", "warnings"],
              readiness["ready"] is Bool,
              readiness["blockers"] is [String],
              readiness["warnings"] is [String],
              (json["status"] is NSNull || json["status"] is [String: Any]),
              let result = json["result"] as? [String: Any],
              (json["recovery_action"] is NSNull || json["recovery_action"] is String),
              json["execution_ok"] as? Bool == executionOK,
              nonempty(json["command_summary"]) != nil,
              topLevelOK == executionOK else {
            throw ProviderFacadeError.schemaInvalid("desktop_bridge_command_result_schema_invalid")
        }
        let completed = topLevelOK && executionStatus == "completed" && blockers.isEmpty
        let partial = topLevelOK && executionStatus == "partial" && !blockers.isEmpty
        let failed = !topLevelOK && executionStatus == "failed"
        guard completed || partial || failed else {
            throw ProviderFacadeError.schemaInvalid("desktop_bridge_command_result_execution_invalid")
        }
        if completed && expectedOperation == "repair" {
            guard let service = result["service"] as? [String: Any],
                  service["ok"] as? Bool == true,
                  service["running"] as? Bool == true else {
                throw ProviderFacadeError.schemaInvalid("desktop_bridge_command_result_service_invalid")
            }
        }
        return DesktopBridgeCommandResultTruth(
            completed: completed,
            blockers: blockers,
            recoveryAction: json["recovery_action"] as? String
        )
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

enum CapabilityDisplayFilter {
    static func rows(_ rows: [CapabilityDisplayRow], showAll: Bool) -> [CapabilityDisplayRow] {
        showAll ? rows : rows.filter { isIssue($0.state) }
    }

    static func issueCount(_ rows: [CapabilityDisplayRow]) -> Int {
        rows.filter { isIssue($0.state) }.count
    }

    private static func isIssue(_ state: CapabilityProbeState) -> Bool {
        switch state {
        case .degraded, .blocked, .failed, .stale: return true
        case .notAttempted, .running, .verified, .unsupported: return false
        }
    }
}
