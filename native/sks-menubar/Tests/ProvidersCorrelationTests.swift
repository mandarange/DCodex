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

    func testNewerUnprovedStatusFromDifferentCatalogGenerationCannotReplaceVerifiedDisplay() {
        var gate = ProviderResponseGate()
        let verifiedGeneration = gate.begin()
        let verifiedAt = Date(timeIntervalSince1970: 100)
        XCTAssertTrue(gate.accept(.init(
            requestGeneration: verifiedGeneration,
            reportId: "verified-g1",
            correlationId: "verify-g1",
            attemptId: 1,
            checkedAt: verifiedAt,
            catalogGeneration: "catalog-g1"
        )))

        XCTAssertFalse(gate.statusMayMerge(
            checkedAt: verifiedAt.addingTimeInterval(60),
            catalogGeneration: "catalog-g2"
        ))
        XCTAssertTrue(gate.statusMayMerge(
            checkedAt: verifiedAt.addingTimeInterval(60),
            catalogGeneration: "catalog-g1"
        ))
        XCTAssertTrue(gate.statusMayMerge(
            checkedAt: verifiedAt,
            catalogGeneration: "catalog-g1"
        ))
        XCTAssertFalse(gate.statusMayMerge(
            checkedAt: verifiedAt.addingTimeInterval(-1),
            catalogGeneration: "catalog-g1"
        ))
    }

    func testNewerVerifiedResponseMayAdvanceCatalogGeneration() {
        var gate = ProviderResponseGate()
        let firstGeneration = gate.begin()
        let firstCheckedAt = Date(timeIntervalSince1970: 100)
        XCTAssertTrue(gate.accept(.init(
            requestGeneration: firstGeneration,
            reportId: "verified-g1",
            correlationId: "verify-g1",
            attemptId: 1,
            checkedAt: firstCheckedAt,
            catalogGeneration: "catalog-g1"
        )))

        let nextGeneration = gate.begin()
        XCTAssertTrue(gate.accept(.init(
            requestGeneration: nextGeneration,
            reportId: "verified-g2",
            correlationId: "verify-g2",
            attemptId: 1,
            checkedAt: firstCheckedAt.addingTimeInterval(60),
            catalogGeneration: "catalog-g2"
        )))
        XCTAssertEqual(gate.accepted?.catalogGeneration, "catalog-g2")
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
