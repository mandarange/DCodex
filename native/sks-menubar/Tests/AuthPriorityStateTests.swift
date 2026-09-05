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

    func testServiceFailureAfterWriteKeepsObservedSavedPreference() {
        let payload: [String: Any] = ["ok": false, "result": ["auth_priority": [
            "enabled": true, "state": "unavailable", "error": "desktop_bridge_not_running"
        ]]]
        let outcome = AuthPriorityMutationOutcome.resolve(payload: payload, desired: true, commandSucceeded: false, responseComplete: true)
        guard case .savedWithSetupIssue(let observed) = outcome else { return XCTFail("A service failure must not claim the preference rolled back") }
        XCTAssertTrue(observed.enabled)
        XCTAssertEqual(observed.message, "On, unavailable · open Bridge diagnostics and repair the bridge service")
        XCTAssertEqual(outcome.operationSummary, "Codex-LB preference saved; connection setup needs attention")
    }

    func testFailedWriteUsesConfirmedPriorPreference() {
        let payload: [String: Any] = ["ok": false, "status": ["auth_priority": [
            "enabled": false, "state": "off", "error": NSNull()
        ]]]
        let outcome = AuthPriorityMutationOutcome.resolve(payload: payload, desired: true, commandSucceeded: false, responseComplete: true)
        guard case .notApplied(let observed) = outcome else { return XCTFail("A confirmed unchanged preference must remain off") }
        XCTAssertFalse(observed.enabled)
    }

    func testIncompleteResponseRequiresReadbackEvenWithApparentState() {
        let payload: [String: Any] = ["ok": true, "result": ["auth_priority": [
            "enabled": true, "state": "active"
        ]]]
        XCTAssertEqual(AuthPriorityMutationOutcome.resolve(payload: payload, desired: true, commandSucceeded: true, responseComplete: false), .unconfirmed)
        XCTAssertEqual(AuthPriorityMutationOutcome.resolve(payload: nil, desired: true, commandSucceeded: false, responseComplete: true), .unconfirmed)
        XCTAssertEqual(AuthPriorityMutationOutcome.resolve(payload: ["ok": true], desired: true, commandSucceeded: true, responseComplete: true), .unconfirmed)
    }

    func testFinalStatusOverridesEarlierCommandState() {
        let payload: [String: Any] = [
            "result": ["auth_priority": ["enabled": true, "state": "active"]],
            "status": ["auth_priority": ["enabled": true, "state": "unavailable", "error": "desktop_bridge_not_running"]]
        ]
        let outcome = AuthPriorityMutationOutcome.resolve(payload: payload, desired: true, commandSucceeded: false, responseComplete: true)
        XCTAssertEqual(outcome.observedState?.state, "unavailable")
    }

    func testSuccessfulDisableUsesConfirmedOffState() {
        let payload: [String: Any] = ["ok": true, "result": ["auth_priority": ["enabled": false, "state": "off"]]]
        let expected = AuthPriorityState(enabled: false, state: "off", error: nil)
        XCTAssertEqual(AuthPriorityMutationOutcome.resolve(payload: payload, desired: false, commandSucceeded: true, responseComplete: true), .saved(expected))
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
