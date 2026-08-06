import Foundation

struct ProviderRouteExplanation: Equatable {
    let providerId: String
    let upstreamModel: String
    let fallback: String

    static func decode(from commandEnvelope: [String: Any]) -> ProviderRouteExplanation? {
        guard let result = commandEnvelope["result"] as? [String: Any],
              let explanation = result["explanation"] as? [String: Any],
              let route = explanation["route"] as? [String: Any],
              let providerId = route["provider_id"] as? String,
              let upstreamModel = route["upstream_model"] as? String,
              let fallback = explanation["fallback"] as? String else { return nil }
        return ProviderRouteExplanation(
            providerId: providerId,
            upstreamModel: upstreamModel,
            fallback: fallback
        )
    }
}
