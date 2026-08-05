#if canImport(XCTest)
import XCTest

final class ProvidersCatalogSyncTests: XCTestCase {
    func testCatalogSyncIsRequiredInEveryV3Report() {
        var json = ProviderV3Fixture.report()
        json.removeValue(forKey: "catalog_sync")
        XCTAssertThrowsError(try DesktopCapabilityReportV3.decode(from: json)) { error in
            XCTAssertTrue(String(describing: error).contains("catalog_sync missing"))
        }
    }

    func testCombinedCatalogDecodesBothProviderCountsAndGeneration() throws {
        let report = try DesktopCapabilityReportV3.decode(from: ProviderV3Fixture.report())
        XCTAssertEqual(report.catalogSync.modelCount, 42)
        XCTAssertEqual(report.catalogSync.routeCount, 42)
        XCTAssertEqual(report.catalogSync.providers["codex-lb"]?.modelCount, 18)
        XCTAssertEqual(report.catalogSync.providers["openrouter"]?.modelCount, 24)
        XCTAssertEqual(report.catalogSync.generation, "catalog-gen-2")
    }

    func testWrongProviderCatalogSchemaIsExplicitlyInvalid() {
        var json = ProviderV3Fixture.report()
        var catalog = json["catalog_sync"] as! [String: Any]
        var providers = catalog["providers"] as! [String: Any]
        var openRouter = providers["openrouter"] as! [String: Any]
        openRouter["schema"] = "sks.catalog-sync-state.v1"
        providers["openrouter"] = openRouter; catalog["providers"] = providers; json["catalog_sync"] = catalog
        XCTAssertThrowsError(try DesktopCapabilityReportV3.decode(from: json))
    }
}
#endif
