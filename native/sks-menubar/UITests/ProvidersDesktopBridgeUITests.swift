#if canImport(XCTest)
import XCTest

final class ProvidersDesktopBridgeUITests: XCTestCase {
    func testFiveProviderCardsAndIndependentActionsExposeStableIdentifiers() throws {
        let app = XCUIApplication()
        app.launch()
        let providerSettings = app.menuItems["Open Provider Settings"]
        XCTAssertTrue(providerSettings.waitForExistence(timeout: 5))
        providerSettings.click()
        for id in ["sks-provider-card-desktop-bridge", "sks-provider-card-credentials", "sks-provider-card-combined-catalog", "sks-provider-card-routes", "sks-provider-card-capability-matrix"] {
            XCTAssertTrue(app.groups[id].waitForExistence(timeout: 2), "Missing provider card: \(id)")
        }
        XCTAssertTrue(app.buttons["sks-provider-verify-transport"].exists)
        XCTAssertTrue(app.buttons["sks-provider-verify-deep"].exists)
        XCTAssertTrue(app.buttons["sks-provider-validate-codex-lb"].exists)
        XCTAssertTrue(app.buttons["sks-provider-validate-openrouter"].exists)
    }
}
#endif
