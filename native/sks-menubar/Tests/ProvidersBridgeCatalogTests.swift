#if canImport(XCTest)
import XCTest

final class ProvidersBridgeCatalogTests: XCTestCase {
    func testRouteExplanationDecodesRepresentativeCLIEnvelope() throws {
        let fixture = #"""
        {
          "schema": "sks.desktop-bridge-command-result.v1",
          "operation": "route.explain",
          "operation_id": "operation-route-1",
          "correlation_id": "correlation-route-1",
          "checked_at": "2026-08-06T01:02:03.000Z",
          "ok": true,
          "execution": { "ok": true, "status": "completed", "blockers": [] },
          "readiness": { "ready": true, "blockers": [], "warnings": [] },
          "status": null,
          "result": {
            "route": { "provider_id": "wrong-legacy-location", "upstream_model": "wrong-model" },
            "fallback": "wrong-legacy-location",
            "explanation": {
              "schema": "sks.bridge-request-route-resolution.v1",
              "ok": true,
              "requested_model": "openrouter/public-model",
              "route": { "provider_id": "openrouter", "upstream_model": "vendor/upstream-model" },
              "endpoint_url": "https://openrouter.ai/api/v1",
              "source": "route_index",
              "fallback": "none",
              "catalog_generation": "catalog-g2",
              "route_policy_generation": "policy-g2",
              "proposed_session_pin": null,
              "blockers": [],
              "warnings": [],
              "recovery_action": null
            }
          },
          "recovery_action": null
        }
        """#
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(fixture.utf8)) as? [String: Any]
        )

        let explanation = try XCTUnwrap(ProviderRouteExplanation.decode(from: object))
        XCTAssertEqual(explanation.providerId, "openrouter")
        XCTAssertEqual(explanation.upstreamModel, "vendor/upstream-model")
        XCTAssertEqual(explanation.fallback, "none")
    }
}
#endif
