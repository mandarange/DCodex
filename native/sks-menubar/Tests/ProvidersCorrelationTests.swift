#if canImport(XCTest)
import XCTest

final class ProvidersCorrelationTests: XCTestCase {
    func testOlderConcurrentCallbackCannotOverwriteLatestRequest() {
        var gate = ProviderResponseGate()
        let old = gate.begin()
        let latest = gate.begin()
        let now = Date()
        XCTAssertFalse(gate.accept(.init(requestGeneration: old, reportId: "old", correlationId: "old", attemptId: 9, checkedAt: now.addingTimeInterval(10), catalogGeneration: "g9")))
        XCTAssertTrue(gate.accept(.init(requestGeneration: latest, reportId: "new", correlationId: "new", attemptId: 1, checkedAt: now, catalogGeneration: "g10")))
        XCTAssertEqual(gate.accepted?.reportId, "new")
    }

    func testAttemptAndCheckedAtOrderingRejectsStaleResponse() {
        var gate = ProviderResponseGate()
        let generation = gate.begin(), now = Date()
        XCTAssertTrue(gate.accept(.init(requestGeneration: generation, reportId: "new", correlationId: "same", attemptId: 2, checkedAt: now, catalogGeneration: "g2")))
        XCTAssertFalse(gate.accept(.init(requestGeneration: generation, reportId: "old", correlationId: "same", attemptId: 1, checkedAt: now.addingTimeInterval(-1), catalogGeneration: "g1")))
        XCTAssertFalse(gate.statusMayMerge(checkedAt: now.addingTimeInterval(-10), catalogGeneration: "g1"))
    }

    func testMixedCorrelationReportIsSchemaInvalid() {
        var json = ProviderV3Fixture.report()
        var bridge = json["bridge"] as! [String: Any]
        var capabilities = bridge["capabilities"] as! [String: Any]
        var status = capabilities["status"] as! [String: Any]
        status["correlation_id"] = "other-correlation"
        capabilities["status"] = status; bridge["capabilities"] = capabilities; json["bridge"] = bridge
        XCTAssertThrowsError(try DesktopCapabilityReportV3.decode(from: json))
    }
}
#endif
