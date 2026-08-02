#if canImport(XCTest)
import XCTest

final class ProvidersViewControllerTests: XCTestCase {
    func testUnsignedStructuredCapabilityJSONCannotVerify() {
        let fabricated: [String: Any] = [
            "overall": "verified",
            "image_generation": ["state": "verified", "source": "deep_probe"],
            "computer_use": ["state": "verified", "source": "deep_probe"]
        ]
        XCTAssertFalse(CapabilityVerificationTruth.deepEvidenceTrusted(in: fabricated))
    }

    func testTrustedValidationRequiresExactVerifiedAttestation() {
        let trusted: [String: Any] = [
            "overall": "verified",
            "deep_evidence_validation": [
                "schema": "sks.codex-lb-deep-evidence-validation.v1",
                "state": "verified",
                "trusted": true,
                "blockers": []
            ]
        ]
        XCTAssertTrue(CapabilityVerificationTruth.deepEvidenceTrusted(in: trusted))
    }

    func testStructuredBlockersArePreservedForFailureRendering() {
        let blocked: [String: Any] = [
            "overall": "blocked",
            "image_generation": [
                "state": "blocked",
                "blockers": ["codex_lb_deep_evidence_stale"]
            ]
        ]
        XCTAssertEqual(
            CapabilityVerificationTruth.blockers(in: blocked),
            ["codex_lb_deep_evidence_stale"]
        )
    }

    func testStatusV2BuiltinOpenAISelectionIsChatGPTOauthModeNotLegacyCodexLb() {
        let status: [String: Any] = [
            "schema": "sks.codex-lb-status.v2",
            "ok": true,
            "configured": true,
            "mode": "cli-provider",
            "oauth": [
                "present": true,
                "preserved": true,
                "mode": "chatgpt_oauth"
            ],
            "provider": [
                "id": "openai",
                "built_in": true,
                "contract": "codex-lb-cli",
                "contract_ok": true,
                "selected": true
            ],
            "bridge": [
                "key_fingerprint": "sha256:fixture"
            ]
        ]
        let snapshot = ProviderRoutingTruth.snapshot(from: status)
        XCTAssertEqual(snapshot.mode, "cli-provider")
        XCTAssertFalse(snapshot.desktopFullRouting)
        XCTAssertFalse(snapshot.legacyCodexLbSelected)
        XCTAssertTrue(snapshot.chatgptOauthPresent)
        XCTAssertTrue(snapshot.cliProviderStored)
        XCTAssertTrue(snapshot.cliCredentialsConfigured)
    }

    func testStatusV2DesktopBridgeModeIsSelectableCodexLb() {
        let status: [String: Any] = [
            "schema": "sks.codex-lb-status.v2",
            "configured": true,
            "mode": "desktop-native-bridge",
            "oauth": [
                "present": true,
                "mode": "chatgpt_oauth"
            ],
            "provider": [
                "id": "openai",
                "selected": true,
                "contract": "builtin-openai"
            ]
        ]
        let snapshot = ProviderRoutingTruth.snapshot(from: status)
        XCTAssertTrue(snapshot.desktopFullRouting)
        XCTAssertFalse(snapshot.legacyCodexLbSelected)
        XCTAssertTrue(snapshot.chatgptOauthPresent)
    }

    func testStatusV2DetectsLegacyCodexLbWhenBuiltinProviderNotSelected() {
        let status: [String: Any] = [
            "mode": "cli-provider",
            "configured": true,
            "oauth": ["present": false, "mode": "openai_api_key"],
            "provider": [
                "id": "openai",
                "selected": false,
                "contract": "codex-lb-cli"
            ]
        ]
        let snapshot = ProviderRoutingTruth.snapshot(from: status)
        XCTAssertTrue(snapshot.legacyCodexLbSelected)
        XCTAssertFalse(snapshot.chatgptOauthPresent)
    }

    func testStatusV2DoesNotTreatNestedBridgeStatusAsLegacyDestructive() {
        let status: [String: Any] = [
            "mode": "cli-provider",
            "configured": true,
            "oauth": ["present": true, "mode": "chatgpt_oauth"],
            "provider": ["id": "openai", "selected": true],
            "bridge": ["status": "settings_missing"]
        ]
        let snapshot = ProviderRoutingTruth.snapshot(from: status)
        XCTAssertFalse(snapshot.legacyDestructive)
        XCTAssertFalse(snapshot.legacyCodexLbSelected)
    }

    func testDisabledChatGPTOauthModeIsNotTreatedAsLegacyCodexLbSelection() {
        let status: [String: Any] = [
            "schema": "sks.codex-lb-status.v2",
            "mode": "disabled",
            "configured": false,
            "oauth": ["present": true, "mode": "chatgpt_oauth"],
            "provider": [
                "id": "openai",
                "selected": true,
                "built_in": true,
                "contract": "builtin-openai"
            ]
        ]
        let snapshot = ProviderRoutingTruth.snapshot(from: status)
        XCTAssertEqual(snapshot.mode, "disabled")
        XCTAssertFalse(snapshot.desktopFullRouting)
        XCTAssertFalse(snapshot.legacyCodexLbSelected)
        XCTAssertTrue(snapshot.chatgptOauthPresent)
    }

    func testCodexLbIsActiveOnlyFromSelectedMeasuredFreshSuccessfulTruth() {
        let status: [String: Any] = [
            "routing_truth": [
                "schema": "sks.codex-lb-routing-truth.v1",
                "ok": true,
                "status": "verified",
                "selected": true,
                "measured": true,
                "fresh": true,
                "configured_host": "lb.example.test",
                "actual_host": "lb.example.test",
                "auth_transport": "authorization-bearer",
                "auth_outcome": "accepted",
                "http_status": 200,
                "measured_at": "2026-08-01T00:00:00.000Z",
                "latency_ms": 21,
                "blockers": []
            ]
        ]
        let route = ProviderRoutingTruth.measuredRoute(from: status)
        XCTAssertEqual(route?.state, .active)
        XCTAssertTrue(route?.active == true)
    }

    func testSelectedFailedAndStaleRoutesRemainVisibleButNeverActive() {
        var failedTruth: [String: Any] = [
            "schema": "sks.codex-lb-routing-truth.v1",
            "ok": false,
            "status": "auth_rejected",
            "selected": true,
            "measured": true,
            "fresh": true,
            "auth_outcome": "rejected",
            "http_status": 401,
            "measured_at": "2026-08-01T00:00:00.000Z",
            "blockers": ["codex_lb_auth_rejected"]
        ]
        let failed = ProviderRoutingTruth.measuredRoute(from: ["routing_truth": failedTruth])
        XCTAssertEqual(failed?.state, .degraded)
        XCTAssertFalse(failed?.active == true)
        XCTAssertEqual(failed?.blockers, ["codex_lb_auth_rejected"])

        failedTruth["status"] = "stale"
        failedTruth["fresh"] = false
        failedTruth["blockers"] = ["codex_lb_routing_truth_stale"]
        let stale = ProviderRoutingTruth.measuredRoute(from: ["routing_truth": failedTruth])
        XCTAssertEqual(stale?.state, .unverified)
        XCTAssertFalse(stale?.active == true)
        XCTAssertEqual(stale?.blockers, ["codex_lb_routing_truth_stale"])
    }

    func testConnectTestRequiresExactStructuredLiveResponseEvidence() {
        let proof = connectTestFixture()
        let parsed = CodexLbConnectTestTruth.success(from: proof)
        XCTAssertEqual(parsed?.model, "gpt-5.6-luna")
        XCTAssertEqual(parsed?.latencyMs, 42)
        XCTAssertEqual(parsed?.responseId, "resp_fixture")
        XCTAssertEqual(parsed?.inputTokens, 7)
        XCTAssertEqual(parsed?.outputTokens, 4)
        XCTAssertEqual(parsed?.totalTokens, 11)
        XCTAssertEqual(parsed?.httpStatus, 200)
        XCTAssertEqual(CodexLbConnectTestTruth.validationFailure(from: proof), "none")
    }

    func testConnectTestRejectsMerelyOkTrueOrWrongSchema() {
        XCTAssertNil(CodexLbConnectTestTruth.success(from: ["ok": true]))
        XCTAssertEqual(
            CodexLbConnectTestTruth.validationFailure(from: ["ok": true]),
            "unexpected or missing schema"
        )

        var wrongSchema = connectTestFixture()
        wrongSchema["schema"] = "sks.codex-lb-health.v1"
        XCTAssertNil(CodexLbConnectTestTruth.success(from: wrongSchema))
    }

    func testConnectTestRejectsEmptyReplyAndMalformedTokenUsage() {
        var emptyReply = connectTestFixture()
        emptyReply["result"] = "  \n "
        XCTAssertNil(CodexLbConnectTestTruth.success(from: emptyReply))
        XCTAssertEqual(CodexLbConnectTestTruth.validationFailure(from: emptyReply), "returned reply is empty")

        var inconsistentUsage = connectTestFixture()
        inconsistentUsage["usage"] = ["input_tokens": 7, "output_tokens": 4, "total_tokens": 12]
        XCTAssertNil(CodexLbConnectTestTruth.success(from: inconsistentUsage))
        XCTAssertEqual(CodexLbConnectTestTruth.validationFailure(from: inconsistentUsage), "token usage evidence is invalid")

        var booleanLatency = connectTestFixture()
        booleanLatency["latency_ms"] = true
        XCTAssertNil(CodexLbConnectTestTruth.success(from: booleanLatency))
    }

    func testConnectTestRejectsUnboundedRequestAndBoundsRenderedReply() {
        var unbounded = connectTestFixture()
        unbounded["usage"] = [
            "input_tokens": 7,
            "output_tokens": CodexLbConnectTestTruth.maximumAcceptedOutputTokens + 1,
            "total_tokens": CodexLbConnectTestTruth.maximumAcceptedOutputTokens + 8
        ]
        XCTAssertNil(CodexLbConnectTestTruth.success(from: unbounded))
        XCTAssertEqual(CodexLbConnectTestTruth.validationFailure(from: unbounded), "low-token request evidence is invalid")

        var longReply = connectTestFixture()
        longReply["result"] = String(repeating: "answer ", count: 80)
        longReply["result_truncated"] = true
        let parsed = CodexLbConnectTestTruth.success(from: longReply)
        XCTAssertNotNil(parsed)
        XCTAssertLessThanOrEqual(parsed?.reply.count ?? .max, CodexLbConnectTestTruth.maximumRenderedReplyCharacters + 1)
        XCTAssertTrue(parsed?.renderedSummary.contains("gpt-5.6-luna") == true)
        XCTAssertTrue(parsed?.renderedSummary.contains("42 ms") == true)
        XCTAssertTrue(parsed?.renderedSummary.contains("7 in / 4 out / 11 total") == true)
    }

    private func connectTestFixture() -> [String: Any] {
        [
            "schema": "sks.codex-lb-connect-test.v1",
            "ok": true,
            "status": "connected",
            "model": "gpt-5.6-luna",
            "latency_ms": 42,
            "response_id": "resp_fixture",
            "result": "Connected through Codex LB.",
            "result_truncated": false,
            "http_status": 200,
            "usage": ["input_tokens": 7, "output_tokens": 4, "total_tokens": 11],
            "blockers": []
        ]
    }
}
#endif
