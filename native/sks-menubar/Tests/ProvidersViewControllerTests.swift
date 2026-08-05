#if canImport(XCTest)
import XCTest

final class ProvidersViewControllerTests: XCTestCase {
    func testCapabilityV3RejectsUnsignedHistoricalShape() {
        XCTAssertThrowsError(try DesktopCapabilityReportV3.decode(from: ["overall": "verified"]))
    }

    func testCapabilityV3RejectsPayloadAliases() {
        let report = ProviderV3Fixture.report()
        for alias in ["report", "capability_report", "desktop_capabilities", "capabilities"] {
            XCTAssertThrowsError(try DesktopCapabilityReportV3.decode(from: [alias: report]), "Accepted payload alias: \(alias)")
        }
    }

    func testNotAttemptedIsNeutralWhileFailuresRemainRed() {
        XCTAssertEqual(ProviderStatusColor.forState("not_attempted"), .secondaryLabelColor)
        XCTAssertEqual(ProviderStatusColor.forState("failed"), .systemRed)
        XCTAssertEqual(ProviderStatusColor.forState("blocked"), .systemRed)
    }

    func testProviderActionInventoryHasNoDeadOrSilentControls() {
        let items = ProviderActionInventory.items
        XCTAssertEqual(items.count, 13)
        XCTAssertEqual(Set(items.map(\.id)).count, items.count)
        for item in items {
            XCTAssertTrue(item.id.hasPrefix("sks-provider-"))
            XCTAssertFalse(item.handler.isEmpty)
            XCTAssertFalse(item.backend.isEmpty)
            XCTAssertFalse(item.loadingState.isEmpty)
            XCTAssertFalse(item.successState.isEmpty)
            XCTAssertFalse(item.recoveryAction.isEmpty)
        }
    }

    func testProviderActionInventoryCoversBridgeAndIndependentProfiles() {
        let ids = Set(ProviderActionInventory.items.map(\.id))
        for required in [
            "sks-provider-bridge-repair",
            "sks-provider-verify-transport",
            "sks-provider-verify-deep",
            "sks-provider-reconnect-codex-lb",
            "sks-provider-reconnect-openrouter",
            "sks-provider-validate-codex-lb",
            "sks-provider-validate-openrouter",
            "sks-provider-open-codex-sign-in",
            "sks-provider-refresh-catalog",
            "sks-provider-route-explain"
        ] {
            XCTAssertTrue(ids.contains(required), "Missing action inventory row: \(required)")
        }
    }
}
#endif
