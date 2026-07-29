import type { CapabilityEvidence, CapabilityProbeLevel } from '../capability-types.js'
import { probeEvidence } from './probe-evidence.js'

export interface ImageGenerationProbeInput {
  level: CapabilityProbeLevel
  checkedAt: string
  route?: 'responses_tool' | 'images_api' | null
  manifestRouteAdvertised?: boolean | undefined
  toolAdvertised?: boolean | undefined
  requestToolsPresent?: boolean | undefined
  events?: readonly unknown[]
  artifactMaterialized?: boolean | undefined
  attempted?: boolean | undefined
  cliTransportAccepted?: boolean | undefined
  fixture?: boolean | undefined
  blockers?: string[]
}

export function runImageGenerationProbe(input: ImageGenerationProbeInput): CapabilityEvidence {
  const outputEventSeen = (input.events || []).some(isImageOutputEvent)
  const attempted = input.attempted === true || Boolean(input.events?.length)
  const cliTransportVerified = input.cliTransportAccepted === true
    && outputEventSeen
    && input.artifactMaterialized === true
  const blockers = [
    ...(input.blockers || []),
    ...(attempted && input.toolAdvertised === false ? ['image_tool_not_advertised'] : []),
    ...(attempted && input.requestToolsPresent === false ? ['image_tools_omitted_by_responses_lite'] : []),
    ...(attempted && !outputEventSeen ? ['image_output_event_filtered'] : []),
    ...((input.level === 'deep' || input.cliTransportAccepted === true)
      && outputEventSeen && input.artifactMaterialized !== true
      ? ['image_artifact_not_materialized']
      : [])
  ]
  return probeEvidence({
    advertised: input.manifestRouteAdvertised === true || input.toolAdvertised === true,
    attempted,
    verified: (input.level === 'deep'
      && outputEventSeen
      && input.artifactMaterialized === true)
      || cliTransportVerified,
    fixture: input.fixture,
    source: input.level === 'deep' ? 'deep_probe' : attempted ? 'transport' : 'manifest',
    unsupported: input.manifestRouteAdvertised === false && input.toolAdvertised === false,
    blockers,
    warnings: outputEventSeen && input.level !== 'deep' && !cliTransportVerified
      ? ['image_event_transport_seen_without_real_desktop_artifact']
      : [],
    evidence: {
      route: input.route || null,
      tool_advertised: input.toolAdvertised === true,
      request_tools_present: input.requestToolsPresent === true,
      output_image_event_seen: outputEventSeen,
      artifact_materialized: input.artifactMaterialized === true,
      cli_transport_accepted: input.cliTransportAccepted === true,
      fixture: input.fixture === true
    }
  }, input.checkedAt)
}

export function isImageOutputEvent(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  const type = String(event.type || '')
  if (/image_generation.*(?:completed|output|done)|output_image/i.test(type)) return true
  const item = event.item
  return Boolean(item && typeof item === 'object' && !Array.isArray(item)
    && /image_generation|output_image/i.test(String((item as Record<string, unknown>).type || '')))
}
