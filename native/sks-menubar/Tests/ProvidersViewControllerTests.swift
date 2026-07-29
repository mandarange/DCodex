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
}
#endif
