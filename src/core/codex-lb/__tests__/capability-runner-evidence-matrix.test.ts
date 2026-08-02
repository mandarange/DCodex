import test from 'node:test'
import assert from 'node:assert/strict'
import {
  runCodexLbDesktopCapabilityReport,
  shapeCodexLbDesktopCapabilityStatus
} from '../capability-runner.js'

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
    slug: 'future-codex-model',
    display_name: 'Future Codex',
    supported_reasoning_levels: [{ effort: 'high' }],
    truncation_policy: { mode: 'tokens' },
    additional_speed_tiers: ['fast'],
    service_tiers: [{ id: 'priority' }],
    use_responses_lite: false,
    future_catalog_field: true
  }]
}

test('API-key routing and missing OAuth do not globally mark independent features unsupported', () => {
  const report = runCodexLbDesktopCapabilityReport({
    mode: 'cli-provider',
    level: 'shallow',
    configured: true,
    oauthPreserved: false,
    checkedAt,
    manifest,
    gatewayAuth: {
      transport: 'x-codex-lb-api-key',
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
      source: 'manifest',
      evidence: { browser_plugin_advertised: true }
    },
    plugins: {
      advertised: true,
      source: 'manifest',
      evidence: { plugin_catalog_advertised: true }
    }
  })

  assert.equal(report.provider_identity.state, 'blocked')
  assert.deepEqual(report.provider_identity.blockers, ['chatgpt_oauth_identity_not_preserved'])
  for (const key of ['image_generation', 'computer_use', 'browser_use', 'voice_mode', 'plugins'] as const) {
    assert.equal(report[key].state, 'available_unverified', key)
    assert.equal(report[key].blockers.length, 0, key)
  }
  assert.equal(report.bridge.state, 'skipped')
})

test('manifest/config and fixture transport evidence never become verified readiness', () => {
  const report = runCodexLbDesktopCapabilityReport({
    mode: 'desktop-native-bridge',
    level: 'transport',
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
      fixture: true,
      configuredServiceTier: 'fast',
      requestServiceTier: 'fast',
      responseActualServiceTier: 'priority'
    },
    imageGeneration: {
      attempted: true,
      fixture: true,
      requestToolsPresent: true,
      events: [{ type: 'response.image_generation_call.completed' }]
    },
    computerUse: {
      attempted: true,
      fixture: true,
      events: [{ type: 'response.computer_call.created' }]
    },
    voiceMode: {
      attempted: true,
      fixture: true,
      createRouteVerified: true,
      locationReceived: true,
      locationRewritten: true,
      websocketUpgraded: true,
      serverEventSeen: true,
      cleanClose: true,
      ownerBindingVerified: true
    },
    browserUse: { verified: true, fixture: true, source: 'transport' },
    plugins: { verified: true, fixture: true, source: 'transport' }
  })
  const status = shapeCodexLbDesktopCapabilityStatus(report)

  assert.equal(report.overall, 'available_unverified')
  assert.equal(status.ready, false)
  assert.equal(status.verified.length, 0)
  assert.ok(status.available_unverified.includes('bridge'))
  assert.ok(status.available_unverified.includes('image_generation'))
})

test('gateway auth distinguishes preferred header from explicit legacy compatibility without silent fallback', () => {
  const preferred = runCodexLbDesktopCapabilityReport({
    mode: 'cli-provider',
    checkedAt,
    gatewayAuth: {
      transport: 'x-codex-lb-api-key',
      configured: true,
      observed: true
    }
  })
  const implicitLegacy = runCodexLbDesktopCapabilityReport({
    mode: 'cli-provider',
    checkedAt,
    gatewayAuth: {
      transport: 'authorization-bearer-compat',
      configured: true,
      observed: true
    }
  })
  const explicitLegacy = runCodexLbDesktopCapabilityReport({
    mode: 'cli-provider',
    checkedAt,
    gatewayAuth: {
      transport: 'authorization-bearer-compat',
      configured: true,
      observed: true,
      legacyCompatibilityExplicit: true
    }
  })

  assert.equal(preferred.gateway_auth_transport.state, 'verified')
  assert.equal(preferred.gateway_auth_transport.evidence.silent_fallback, false)
  assert.equal(implicitLegacy.gateway_auth_transport.state, 'blocked')
  assert.ok(implicitLegacy.gateway_auth_transport.blockers.includes('legacy_gateway_auth_compatibility_not_explicit'))
  assert.equal(explicitLegacy.gateway_auth_transport.state, 'verified')
  assert.deepEqual(explicitLegacy.gateway_auth_transport.warnings, ['legacy_authorization_bearer_compatibility_active'])
})

test('Fast evidence distinguishes configured, catalog-advertised, and effective priority processing', () => {
  const report = runCodexLbDesktopCapabilityReport({
    mode: 'desktop-dual-auth-compat',
    level: 'deep',
    checkedAt,
    catalog: {
      catalog,
      localCatalogBound: true,
      configuredServiceTier: 'fast',
      pickerControlVisible: true,
      pickerSelectedModel: 'future-codex-model',
      requestServiceTier: 'fast',
      responseActualServiceTier: 'priority'
    }
  })

  assert.equal(report.fast_mode.state, 'verified')
  assert.equal(report.fast_mode.evidence.configured, true)
  assert.equal(report.fast_mode.evidence.advertised, true)
  assert.equal(report.fast_mode.evidence.effective, true)
  assert.equal(report.fast_mode.evidence.request_priority_mapping, 'priority')
})

test('cli-provider overall follows the CLI request plane instead of freezing at available_unverified', () => {
  const report = runCodexLbDesktopCapabilityReport({
    mode: 'cli-provider',
    level: 'transport',
    configured: true,
    oauthPreserved: false,
    checkedAt,
    gatewayAuth: {
      transport: 'authorization-bearer',
      configured: true,
      observed: true
    },
    providerIdentity: {
      attempted: true,
      verified: true,
      source: 'transport',
      requiresOauth: false
    },
    catalog: {
      catalog,
      configuredServiceTier: 'fast',
      requestServiceTier: 'priority',
      responseActualServiceTier: 'priority'
    },
    textResponses: {
      attempted: true,
      verified: true,
      source: 'transport'
    },
    imageGeneration: {
      attempted: true,
      toolAdvertised: true,
      requestToolsPresent: true,
      cliTransportAccepted: true,
      route: 'responses_tool',
      events: [{ type: 'response.image_generation_call.completed', result: 'aW1n' }],
      artifactMaterialized: true
    }
  })
  const status = shapeCodexLbDesktopCapabilityStatus(report)

  assert.equal(report.gateway_auth_transport.state, 'verified')
  assert.equal(report.gateway_auth_transport.evidence.standard_authorization_bearer, true)
  assert.equal(report.provider_identity.state, 'verified')
  assert.equal(report.catalog.state, 'verified')
  assert.equal(report.model_picker.state, 'verified')
  assert.equal(status.model_picker, report.model_picker)
  assert.equal(report.fast_mode.state, 'verified')
  assert.equal(report.text_responses.state, 'verified')
  assert.equal(report.image_generation.state, 'verified')
  assert.equal(report.overall, 'verified')
  assert.equal(status.ready, true)
  assert.ok(status.verified.includes('image_generation'))
  // Desktop-plane surfaces stay honestly reported but do not gate the CLI verdict.
  assert.ok(status.available_unverified.includes('computer_use'))
  assert.ok(status.available_unverified.includes('voice_mode'))
})

test('cli-provider overall is blocked when the gateway rejects the image tool', () => {
  const report = runCodexLbDesktopCapabilityReport({
    mode: 'cli-provider',
    level: 'transport',
    configured: true,
    checkedAt,
    gatewayAuth: {
      transport: 'authorization-bearer',
      configured: true,
      observed: true
    },
    providerIdentity: {
      attempted: true,
      verified: true,
      source: 'transport',
      requiresOauth: false
    },
    catalog: {
      catalog,
      configuredServiceTier: 'fast',
      requestServiceTier: 'priority',
      responseActualServiceTier: 'priority'
    },
    textResponses: {
      attempted: true,
      verified: true,
      source: 'transport'
    },
    imageGeneration: {
      attempted: true,
      toolAdvertised: false,
      cliTransportAccepted: false,
      blockers: ['image_generation_tool_rejected_by_gateway']
    }
  })

  assert.equal(report.image_generation.state, 'blocked')
  assert.ok(report.image_generation.blockers.includes('image_generation_tool_rejected_by_gateway'))
  assert.equal(report.overall, 'blocked')
})

test('full overall cannot hide unverified browser and auxiliary Desktop surfaces', () => {
  const report = runCodexLbDesktopCapabilityReport({
    mode: 'desktop-native-bridge',
    level: 'deep',
    configured: true,
    oauthPreserved: true,
    checkedAt,
    manifest,
    gatewayAuth: {
      transport: 'x-codex-lb-api-key',
      configured: true,
      observed: true
    },
    providerIdentity: {
      verified: true,
      source: 'deep_probe'
    },
    bridge: {
      configured: true,
      transportAttempted: true,
      httpRoundTrip: true,
      websocketRoundTrip: true
    },
    catalog: {
      catalog,
      configuredServiceTier: 'fast',
      pickerControlVisible: true,
      pickerSelectedModel: 'future-codex-model',
      requestServiceTier: 'fast',
      responseActualServiceTier: 'priority'
    },
    imageGeneration: {
      attempted: true,
      requestToolsPresent: true,
      events: [{ type: 'response.image_generation_call.completed' }],
      artifactMaterialized: true
    },
    computerUse: {
      attempted: true,
      events: [{ type: 'response.computer_call.created' }],
      localExecutorCompleted: true,
      outputSubmitted: true,
      followUpCompleted: true,
      sessionAffinityPreserved: true
    },
    voiceMode: {
      attempted: true,
      createRouteVerified: true,
      locationReceived: true,
      locationRewritten: true,
      websocketUpgraded: true,
      serverEventSeen: true,
      cleanClose: true,
      ownerBindingVerified: true
    },
    plugins: {
      verified: true,
      source: 'deep_probe'
    }
  })

  assert.equal(report.browser_use.state, 'available_unverified')
  assert.equal(report.auxiliary_surfaces.state, 'available_unverified')
  assert.equal(report.overall, 'available_unverified')
})
