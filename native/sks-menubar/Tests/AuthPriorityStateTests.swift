#if canImport(XCTest)
import XCTest

final class AuthPriorityStateTests: XCTestCase {
    func testSavedUnavailablePreferenceRemainsEnabled() {
        let value = AuthPriorityState.decode(["result": ["auth_priority": [
            "enabled": true, "state": "unavailable", "error": "codex_lb_credential_missing"
        ]]])
        XCTAssertEqual(value?.enabled, true)
        XCTAssertEqual(value?.message, "On, unavailable · connect your Codex-LB account below")
    }

    func testStatusAndCommandEnvelopesDecodeTheSameState() {
        let raw: [String: Any] = ["enabled": true, "state": "active", "error": NSNull()]
        let direct = AuthPriorityState.decode(["auth_priority": raw])
        XCTAssertEqual(direct, AuthPriorityState.decode(["status": ["auth_priority": raw]]))
        XCTAssertEqual(direct, AuthPriorityState.decode(["result": ["auth_priority": raw]]))
        XCTAssertEqual(direct?.state, "active")
    }

    func testMalformedAndContradictoryStatesDoNotEnableControl() {
        for raw: [String: Any] in [
            ["state": "off"], ["enabled": true, "state": "off"],
            ["enabled": false, "state": "active"], ["enabled": true, "state": "unknown"]
        ] {
            XCTAssertNil(AuthPriorityState.decode(["auth_priority": raw]))
        }
        XCTAssertNil(AuthPriorityState.decode([:]))
    }

    func testUnknownErrorIsNotRenderedAsPublicContent() {
        let value = AuthPriorityState.decode(["auth_priority": [
            "enabled": true, "state": "unavailable", "error": "unexpected-private-diagnostic"
        ]])
        XCTAssertEqual(value?.message, "On, unavailable · check your Codex-LB connection below")
        XCTAssertFalse(value?.message.contains("unexpected-private-diagnostic") ?? true)
    }
}
#endif
