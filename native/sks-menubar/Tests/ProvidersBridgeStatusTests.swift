#if canImport(XCTest)
import XCTest

final class ProvidersBridgeStatusTests: XCTestCase {
    func testAggregateStatusRequiresExactV3EnvelopeAndRootCorrelation() throws {
        let status = try DesktopBridgeStatusV3Truth.decode(from: ProviderV3Fixture.status())
        XCTAssertEqual(status.correlationId, "correlation-1")
        XCTAssertEqual(status.capabilities?.catalogGeneration, "catalog-gen-2")
    }

    func testAggregateStatusRejectsMissingRequiredCatalog() {
        var status = ProviderV3Fixture.status()
        status.removeValue(forKey: "catalog_sync")
        XCTAssertThrowsError(try DesktopBridgeStatusV3Truth.decode(from: status))
    }

    func testDiagnosticExecutionAndReadinessAreIndependent() throws {
        var json = ProviderV3Fixture.report()
        var summary = json["summary"] as! [String: Any]
        summary["bridge_ready"] = false; summary["transport_level_satisfied"] = false
        summary["blockers"] = ["desktop_bridge_tcp_connect_failed"]
        json["summary"] = summary
        let report = try DesktopCapabilityReportV3.decode(from: json)
        XCTAssertTrue(report.execution.ok)
        XCTAssertFalse(report.summary.transportLevelSatisfied)
    }

    func testRecoveryActionsAreAllowlisted() {
        XCTAssertEqual(ProviderRecoveryAction(rawValue: "repair_bridge_service")?.buttonTitle, "Repair Bridge")
        XCTAssertNil(ProviderRecoveryAction(rawValue: "rm -rf /"))
    }

    func testProviderErrorTextRedactsKeyLikeValues() {
        let raw = "Authorization: Bearer token-supersecret api_key=token-anothersecret"
        let redacted = ProviderSecretRedactor.redact(raw)
        XCTAssertFalse(redacted.contains("supersecret"))
        XCTAssertFalse(redacted.contains("anothersecret"))
        XCTAssertTrue(redacted.contains("[REDACTED]"))
        XCTAssertEqual(ProviderSecretRedactor.redactEndpoint("https://user:pass@example.test/v1?api_key=secret#fragment"), "https://example.test/v1")
    }

}
#endif
