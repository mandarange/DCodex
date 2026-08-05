#if canImport(XCTest)
import XCTest

enum ProviderV3Fixture {
    static func probe(_ capability: String, scope: String, state: String = "verified", stage: String = "complete", rootCause: String? = nil, recovery: String? = nil, attempt: Int = 1, checkedAt: String = "2026-08-05T14:00:00.000Z") -> [String: Any] {
        [
            "schema": "sks.capability-probe.v3", "capability": capability, "scope": scope,
            "requested_level": "transport", "stage": stage, "state": state, "checked_at": checkedAt,
            "report_id": "report-1", "correlation_id": "correlation-1", "session_id": "session-1",
            "attempt_id": attempt, "terminal": rootCause != nil, "root_cause": rootCause.map { $0 as Any } ?? NSNull(),
            "blockers": rootCause.map { [$0] } ?? [], "warnings": [], "retryable": recovery != nil,
            "recovery_action": recovery.map { $0 as Any } ?? NSNull(), "source": "transport",
            "evidence": ["route": scope, "oauth_requirement": scope == "native-identity" ? "required" : "not required"]
        ]
    }

    static func scope(_ scope: String, state: String = "verified", probes: [String: [String: Any]]? = nil) -> [String: Any] {
        ["schema": "sks.scope-capability-summary.v1", "scope": scope, "state": state,
         "checked_at": "2026-08-05T14:00:00.000Z",
         "capabilities": probes ?? ["status": probe("status", scope: scope, state: state)],
         "blockers": [], "warnings": []]
    }

    static func providerCatalog(_ id: String, state: String = "verified", count: Int = 12) -> [String: Any] {
        ["schema": "sks.catalog-sync-state.v2", "provider_id": id, "state": state,
         "source": id == "codex-lb" ? "gateway" : "openrouter", "generation": "provider-gen-\(id)",
         "digest": "sha256:redacted", "model_count": count, "checked_at": "2026-08-05T14:00:00.000Z",
         "expires_at": "2026-08-05T15:00:00.000Z", "blockers": [], "warnings": [], "recovery_action": NSNull()]
    }

    static func catalog() -> [String: Any] {
        ["schema": "sks.combined-catalog-sync.v1", "state": "verified", "generation": "catalog-gen-2",
         "digest": "sha256:redacted", "model_count": 42, "route_count": 42, "conflict_count": 0,
         "checked_at": "2026-08-05T14:00:00.000Z",
         "providers": ["codex-lb": providerCatalog("codex-lb", count: 18), "openrouter": providerCatalog("openrouter", count: 24)],
         "blockers": [], "warnings": [], "recovery_action": NSNull()]
    }

    static func report() -> [String: Any] {
        ["schema": "sks.desktop-capabilities.v3", "report_id": "report-1", "correlation_id": "correlation-1",
         "session_id": "session-1", "requested_level": "transport", "catalog_generation": "catalog-gen-2",
         "checked_at": "2026-08-05T14:00:00.000Z",
         "execution": ["ok": true, "status": "completed", "blockers": []],
         "bridge": scope("bridge"), "native_identity": scope("native-identity"),
         "providers": ["codex-lb": scope("provider:codex-lb"), "openrouter": scope("provider:openrouter")],
         "combined_catalog": scope("catalog:combined"),
         "summary": ["bridge_ready": true, "active_routes_ready": true, "level_satisfied": true, "transport_level_satisfied": true,
                     "deep_level_satisfied": false, "full_feature_verified": false,
                     "inactive_provider_failures": [], "blockers": [], "warnings": []],
         "catalog_sync": catalog()]
    }

    static func status() -> [String: Any] {
        func profile(_ id: String) -> [String: Any] {
            ["schema": "sks.bridge-provider-profile-status.v1", "provider_id": id, "enabled": true,
             "credential": ["state": "ready", "source": "keychain", "fingerprint": "sha256:redacted", "checked_at": "2026-08-05T14:00:00.000Z", "blockers": [], "warnings": []],
             "endpoint": ["configured": true, "origin_redacted": "https://example.test", "auth_transport": id == "codex-lb" ? "authorization-bearer" : "openrouter-bearer"],
             "catalog": providerCatalog(id), "capabilities": scope("provider:\(id)")]
        }
        return ["schema": "sks.desktop-bridge-status.v3", "checked_at": "2026-08-05T14:00:00.000Z", "correlation_id": "correlation-1",
                "management": ["managed": true, "runtime": "desktop-bridge", "state": "ready", "reason": NSNull()],
                "service": ["state": "ready", "installed": true, "loaded": true, "running": true, "loopback_origin": "http://127.0.0.1:10100", "pid": 42, "checked_at": "2026-08-05T14:00:00.000Z", "blockers": [], "warnings": []],
                "native_identity": ["state": "verified", "configured": true, "semantic_identity_preserved": true, "checked_at": "2026-08-05T14:00:00.000Z", "blockers": [], "warnings": []],
                "providers": ["codex-lb": profile("codex-lb"), "openrouter": profile("openrouter")],
                "routing": ["policy": ["schema": "sks.bridge-routing-policy.v1", "default_provider_id": "codex-lb", "fallback": "none", "model_routes": [:], "catalog_generation": "catalog-gen-2", "policy_generation": "policy-gen-1", "changed_at": "2026-08-05T14:00:00.000Z"], "selected_model": NSNull(), "selected_route": NSNull(), "session_pin": NSNull(), "fallback": "none", "blockers": [], "warnings": []],
                "catalog_sync": catalog(), "capabilities": report(),
                "readiness": ["ready": true, "state": "ready", "bridge_ready": true, "active_routes_ready": true, "combined_catalog_ready": true, "blockers": [], "warnings": []]]
    }
}

final class ProvidersCapabilityTruthTests: XCTestCase {
    func testTransportKeepsDeepOnlyCapabilityNotAttemptedWithoutBlanketDowngrade() throws {
        var json = ProviderV3Fixture.report()
        var providers = json["providers"] as! [String: Any]
        providers["codex-lb"] = ProviderV3Fixture.scope("provider:codex-lb", probes: [
            "models": ProviderV3Fixture.probe("models", scope: "provider:codex-lb"),
            "voice": ProviderV3Fixture.probe("voice", scope: "provider:codex-lb", state: "not_attempted", stage: "preflight", recovery: "run_deep_verification")
        ])
        json["providers"] = providers
        let report = try DesktopCapabilityReportV3.decode(from: json)
        let rows = CapabilityDisplayRow.rows(from: report)
        XCTAssertEqual(rows.first { $0.capability == "models" }?.state, .verified)
        XCTAssertEqual(rows.first { $0.capability == "voice" }?.state, .notAttempted)
        XCTAssertNil(rows.first { $0.capability == "voice" }?.rootCause)
        XCTAssertTrue(report.summary.transportLevelSatisfied)
    }

    func testStaleDeepEvidenceRemainsInsideCodexLbScope() throws {
        var json = ProviderV3Fixture.report()
        var providers = json["providers"] as! [String: Any]
        providers["codex-lb"] = ProviderV3Fixture.scope("provider:codex-lb", state: "stale", probes: [
            "image": ProviderV3Fixture.probe("image", scope: "provider:codex-lb", state: "stale", stage: "artifact_validation", rootCause: "codex_lb_deep_evidence_stale", recovery: "run_deep_verification")
        ])
        json["providers"] = providers
        let report = try DesktopCapabilityReportV3.decode(from: json)
        XCTAssertEqual(report.providers["codex-lb"]?.state, .stale)
        XCTAssertEqual(report.providers["openrouter"]?.state, .verified)
        XCTAssertTrue(report.summary.activeRoutesReady)
    }

    func testWebSocketRowDisplaysOnlyTerminalRootCause() throws {
        var json = ProviderV3Fixture.report()
        json["bridge"] = ProviderV3Fixture.scope("bridge", state: "blocked", probes: [
            "websocket": ProviderV3Fixture.probe("websocket", scope: "bridge", state: "blocked", stage: "websocket_upgrade", rootCause: "desktop_bridge_websocket_upgrade_failed", recovery: "inspect_bridge_logs_and_retry_transport")
        ])
        let row = try XCTUnwrap(CapabilityDisplayRow.rows(from: DesktopCapabilityReportV3.decode(from: json)).first)
        XCTAssertEqual(row.rootCause, "desktop_bridge_websocket_upgrade_failed")
        XCTAssertEqual(row.stage, .websocketUpgrade)
    }
}
#endif
