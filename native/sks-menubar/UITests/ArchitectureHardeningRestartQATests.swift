#if canImport(XCTest)
import Foundation
import XCTest

final class ArchitectureHardeningRestartQATests: XCTestCase {
    private let app = XCUIApplication()

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard ProcessInfo.processInfo.environment["SKS_SIGNED_QA_APPROVED"] == "1" else {
            throw XCTSkip("signed_app_qa_approval_required")
        }
        app.launchEnvironment["SKS_SIGNED_QA_ACTIVE"] = "1"
    }

    func testRepeatedRelaunchKeepsRecoverySurfaceAndDoesNotOpenAuthenticationUI() throws {
        for cycle in 0..<5 {
            app.launch()
            XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10) || app.state == .runningBackground,
                          "menu bar app failed to launch at cycle \(cycle)")

            let providerSettings = app.menuItems["Open Provider Settings"]
            let retry = app.menuItems["Retry Last Operation"]
            XCTAssertTrue(providerSettings.waitForExistence(timeout: 5), "provider settings recovery entry is unavailable")
            XCTAssertTrue(retry.exists, "retry recovery entry is unavailable")

            XCTAssertFalse(app.sheets.matching(NSPredicate(format: "label CONTAINS[c] 'password'")).firstMatch.exists)
            XCTAssertFalse(app.dialogs.matching(NSPredicate(format: "label CONTAINS[c] 'authenticate'")).firstMatch.exists)
            app.terminate()
            XCTAssertTrue(app.wait(for: .notRunning, timeout: 10), "menu bar app did not terminate cleanly")
        }
    }

    func testProviderActionsExposeStableAccessibilitySelectors() throws {
        app.launch()
        let providerSettings = app.menuItems["Open Provider Settings"]
        guard providerSettings.waitForExistence(timeout: 5) else {
            XCTFail("provider settings menu item unavailable")
            return
        }
        providerSettings.click()
        XCTAssertTrue(app.buttons["sks-provider-reconnect-codex-lb"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["sks-provider-verify-transport"].exists)
        XCTAssertTrue(app.staticTexts["sks-center-provider-apply-status"].exists)
    }
}
#endif
