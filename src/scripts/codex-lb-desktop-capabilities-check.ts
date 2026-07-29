#!/usr/bin/env node
import {
  runCodexLbDesktopCapabilityReport,
  shapeCodexLbDesktopCapabilityStatus
} from '../core/codex-lb/capability-runner.js'
import type { CodexLbCapabilityKey } from '../core/codex-lb/capability-types.js'
import { assertGate, emitGate } from './gate-lib.js'

const checkedAt = '2026-07-28T00:00:00.000Z'
const manifest = {
  schema_version: 'codex-lb.desktop-capabilities.v1',
  routes: {
    responses_http: true,
    models: true,
    images_generations: true,
    realtime_calls: true,
    files: true,
    transcribe: true,
    images_edits: true,
    thread_goal: true,
    memories_trace_summarize: true,
    safety_arc: true,
    agent_identities_jwks: true
  },
  tools: {
    image_generation: true,
    computer_use_passthrough: true,
    web_search: true
  }
}
const catalog = {
  models: [{
    id: 'future-codex-model',
    display_name: 'Future Codex',
    supported_reasoning_levels: [{ effort: 'high' }],
    truncation_policy: { mode: 'tokens' },
    additional_speed_tiers: ['fast'],
    service_tiers: [{ id: 'priority' }],
    use_responses_lite: false,
    future_catalog_field: true
  }]
}

const advertisedOnly = runCodexLbDesktopCapabilityReport({
  mode: 'desktop-native-bridge',
  level: 'shallow',
  configured: true,
  oauthPreserved: true,
  checkedAt,
  manifest,
  gatewayAuth: {
    transport: 'x-codex-lb-api-key',
    configured: true,
    observed: false
  },
  providerIdentity: {
    configured: true,
    source: 'config'
  },
  browserUse: {
    advertised: true,
    source: 'manifest'
  },
  plugins: {
    advertised: true,
    source: 'manifest'
  }
})
const advertisedStatus = shapeCodexLbDesktopCapabilityStatus(advertisedOnly)

const fixtureOnly = runCodexLbDesktopCapabilityReport({
  mode: 'desktop-native-bridge',
  level: 'deep',
  configured: true,
  oauthPreserved: true,
  checkedAt,
  manifest,
  gatewayAuth: {
    transport: 'x-codex-lb-api-key',
    configured: true,
    observed: true,
    fixture: true
  },
  providerIdentity: {
    verified: true,
    fixture: true,
    source: 'transport'
  },
  bridge: {
    configured: true,
    processRunning: true,
    transportAttempted: true,
    httpRoundTrip: true,
    websocketRoundTrip: true,
    fixture: true
  },
  catalog: {
    catalog,
    configuredServiceTier: 'fast',
    pickerControlVisible: true,
    pickerSelectedModel: 'future-codex-model',
    requestServiceTier: 'fast',
    responseActualServiceTier: 'priority',
    fixture: true
  },
  imageGeneration: {
    attempted: true,
    requestToolsPresent: true,
    events: [{ type: 'response.image_generation_call.completed' }],
    artifactMaterialized: true,
    fixture: true
  },
  computerUse: {
    attempted: true,
    events: [{ type: 'response.computer_call.created' }],
    localExecutorCompleted: true,
    outputSubmitted: true,
    followUpCompleted: true,
    sessionAffinityPreserved: true,
    fixture: true
  },
  browserUse: {
    verified: true,
    fixture: true,
    source: 'deep_probe'
  },
  voiceMode: {
    attempted: true,
    createRouteVerified: true,
    locationReceived: true,
    locationRewritten: true,
    websocketUpgraded: true,
    serverEventSeen: true,
    cleanClose: true,
    ownerBindingVerified: true,
    fixture: true
  },
  plugins: {
    verified: true,
    fixture: true,
    source: 'deep_probe'
  },
  auxiliarySurfaces: {
    attempted: true,
    inputEvents: [{ type: 'future.desktop.event', payload: { keep: true } }],
    outputEvents: [{ type: 'future.desktop.event', payload: { keep: true } }],
    requestBodyHashPreserved: true,
    sessionAffinityPreserved: true,
    fixture: true
  }
})
const fixtureStatus = shapeCodexLbDesktopCapabilityStatus(fixtureOnly)

const textOnly = runCodexLbDesktopCapabilityReport({
  mode: 'cli-provider',
  level: 'transport',
  configured: true,
  oauthPreserved: false,
  checkedAt,
  manifest,
  textResponses: {
    attempted: true,
    verified: true,
    source: 'transport',
    evidence: { response_completed: true }
  },
  browserUse: {
    advertised: true,
    source: 'manifest'
  },
  plugins: {
    advertised: true,
    source: 'manifest'
  }
})

const authIndependentBase = {
  mode: 'cli-provider' as const,
  level: 'shallow' as const,
  configured: true,
  checkedAt,
  manifest,
  gatewayAuth: {
    transport: 'x-codex-lb-api-key' as const,
    configured: true,
    observed: false
  },
  providerIdentity: {
    requiresOauth: true,
    configured: true
  },
  catalog: {
    catalog,
    configuredServiceTier: 'fast'
  },
  browserUse: {
    advertised: true,
    source: 'manifest' as const
  },
  plugins: {
    advertised: true,
    source: 'manifest' as const
  }
}
const oauthAvailable = runCodexLbDesktopCapabilityReport({
  ...authIndependentBase,
  oauthPreserved: true
})
const oauthMissing = runCodexLbDesktopCapabilityReport({
  ...authIndependentBase,
  oauthPreserved: false
})

const fixtureVerifiableKeys: CodexLbCapabilityKey[] = [
  'gateway_auth_transport',
  'provider_identity',
  'bridge',
  'catalog',
  'model_picker',
  'fast_mode',
  'image_generation',
  'computer_use',
  'browser_use',
  'voice_mode',
  'plugins',
  'auxiliary_surfaces'
]
const authIndependentKeys: CodexLbCapabilityKey[] = [
  'gateway_auth_transport',
  'catalog',
  'model_picker',
  'fast_mode',
  'image_generation',
  'computer_use',
  'browser_use',
  'voice_mode',
  'plugins',
  'auxiliary_surfaces'
]
const textIndependentKeys: CodexLbCapabilityKey[] = [
  'image_generation',
  'computer_use',
  'browser_use',
  'voice_mode',
  'plugins',
  'auxiliary_surfaces'
]

const advertisedNotVerified = advertisedStatus.ready === false
  && advertisedOnly.overall === 'available_unverified'
  && capabilityEntries(advertisedOnly).every(([, evidence]) => evidence.state !== 'verified')
const fixtureNotVerified = fixtureStatus.ready === false
  && fixtureOnly.overall === 'available_unverified'
  && fixtureVerifiableKeys.every((key) => fixtureOnly[key].state === 'available_unverified')
const textDoesNotPromoteOtherCapabilities = textOnly.text_responses.state === 'verified'
  && textIndependentKeys.every((key) => textOnly[key].state !== 'verified')
const independentFromAuthMode = oauthAvailable.provider_identity.state === 'available_unverified'
  && oauthMissing.provider_identity.state === 'blocked'
  && authIndependentKeys.every((key) => (
    oauthAvailable[key].state === oauthMissing[key].state
    && JSON.stringify(oauthAvailable[key].blockers) === JSON.stringify(oauthMissing[key].blockers)
  ))

const report = {
  schema: 'sks.codex-lb-desktop-capabilities-check.v1',
  ok: advertisedNotVerified
    && fixtureNotVerified
    && textDoesNotPromoteOtherCapabilities
    && independentFromAuthMode,
  advertised_not_verified: advertisedNotVerified,
  fixture_not_verified: fixtureNotVerified,
  text_does_not_promote_other_capabilities: textDoesNotPromoteOtherCapabilities,
  independent_from_auth_mode: independentFromAuthMode,
  states: {
    advertised_only: advertisedOnly.overall,
    fixture_only: fixtureOnly.overall,
    text_only: textOnly.overall,
    oauth_available_provider_identity: oauthAvailable.provider_identity.state,
    oauth_missing_provider_identity: oauthMissing.provider_identity.state
  },
  blockers: [
    ...(advertisedNotVerified ? [] : ['manifest_or_config_promoted_to_verified']),
    ...(fixtureNotVerified ? [] : ['fixture_evidence_promoted_to_verified']),
    ...(textDoesNotPromoteOtherCapabilities ? [] : ['text_response_evidence_promoted_other_capability']),
    ...(independentFromAuthMode ? [] : ['independent_capability_changed_with_auth_mode'])
  ]
}

assertGate(report.ok, 'codex-lb Desktop capability evidence gate failed', report)
emitGate('codex-lb:desktop-capabilities', {
  advertised_not_verified: report.advertised_not_verified,
  fixture_not_verified: report.fixture_not_verified,
  text_does_not_promote_other_capabilities: report.text_does_not_promote_other_capabilities,
  independent_from_auth_mode: report.independent_from_auth_mode
})

function capabilityEntries(
  report: ReturnType<typeof runCodexLbDesktopCapabilityReport>
): Array<[CodexLbCapabilityKey, ReturnType<typeof runCodexLbDesktopCapabilityReport>[CodexLbCapabilityKey]]> {
  return Object.entries(report)
    .filter((entry): entry is [CodexLbCapabilityKey, ReturnType<typeof runCodexLbDesktopCapabilityReport>[CodexLbCapabilityKey]] => {
      const value = entry[1]
      return Boolean(value && typeof value === 'object' && 'state' in value && 'evidence' in value)
    })
}
