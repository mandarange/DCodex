import { isComputerCallEvent } from './probes/computer-use-probe.js'
import { isImageOutputEvent } from './probes/image-generation-probe.js'
import {
  validateCodexLbDesktopDeepEvidence,
  type CodexLbDeepEvidenceTrustAnchor,
  type CodexLbDeepEvidenceValidation
} from './trusted-deep-evidence.js'
import type { CodexLbDesktopMode } from './desktop-mode.js'
import { uniqueValues as unique } from '../text/strings.js'

export const CODEX_LB_DESKTOP_REAL_EVIDENCE_CHECK_SCHEMA = 'sks.codex-lb-desktop-real-evidence-check.v1' as const

export const CODEX_LB_DESKTOP_REAL_EVIDENCE_REQUIRED_TRUE_FIELDS = Object.freeze([
  'provider_identity_verified',
  'picker_control_visible',
  'bridge_websocket_round_trip',
  'image_request_tools_present',
  'image_artifact_materialized',
  'computer_executor_completed',
  'computer_output_submitted',
  'computer_follow_up_completed',
  'computer_session_affinity_preserved',
  'browser_use_verified',
  'voice_create_verified',
  'voice_location_received',
  'voice_location_rewritten',
  'voice_websocket_upgraded',
  'voice_server_event_seen',
  'voice_clean_close',
  'voice_owner_binding_verified',
  'plugins_verified',
  'auxiliary_request_body_hash_preserved',
  'auxiliary_owner_affinity_verified',
  'desktop_adoption_verified',
  'oauth_bytes_unchanged_before_restart',
  'oauth_semantic_identity_verified_after_restart',
  'built_in_openai_provider_retained',
  'fast_selector_visible',
  'fast_effective_verified',
  'text_response_verified',
  'code_mcp_search_verified',
  'files_transcribe_verified',
  'memory_thread_goal_routes_verified',
  'existing_thread_resumed',
  'new_thread_created',
  'disable_routing_verified',
  'rollback_byte_exact_verified',
  'app_restart_recovery_verified',
  'mac_reboot_recovery_verified',
  'remote_other_mac_runtime_verified',
  'auth_mode_independence_verified'
] as const)

const REQUIRED_NONEMPTY_STRING_FIELDS = Object.freeze([
  'picker_selected_model',
  'configured_service_tier',
  'request_service_tier',
  'response_actual_service_tier',
  'source_surface',
  'desktop_build',
  'codex_core_version',
  'protocol_fixture_schema_hash',
  'app_origin_observed'
] as const)

const REQUIRED_NONEMPTY_ARRAY_FIELDS = Object.freeze([
  'image_events',
  'computer_events',
  'auxiliary_routes_observed',
  'auxiliary_events',
  'auxiliary_output_events'
] as const)

const DEFAULT_RELEASE_PRODUCERS = Object.freeze([
  'sks.codex-lb-desktop-blackbox'
] as const)

export interface ValidateCodexLbDesktopRealEvidenceOptions {
  expectedMode: CodexLbDesktopMode
  expectedEndpoint: string
  trustAnchors: readonly CodexLbDeepEvidenceTrustAnchor[]
  now?: Date | number | string
  maxAgeMs?: number
  maxFutureSkewMs?: number
  allowedProducerIds?: readonly string[]
}

export interface CodexLbDesktopRealEvidenceCheck {
  schema: typeof CODEX_LB_DESKTOP_REAL_EVIDENCE_CHECK_SCHEMA
  ok: boolean
  status: 'passed' | 'real_required_missing'
  release_authorizing: boolean
  mode: CodexLbDesktopMode
  endpoint: string
  producer_id: string | null
  deep_evidence_validation: CodexLbDeepEvidenceValidation
  required_true_fields: readonly string[]
  required_string_fields: readonly string[]
  required_array_fields: readonly string[]
  verified_fields: string[]
  blockers: string[]
  warnings: string[]
}

export function validateCodexLbDesktopRealEvidence(
  raw: unknown,
  options: ValidateCodexLbDesktopRealEvidenceOptions
): CodexLbDesktopRealEvidenceCheck {
  const validation = validateCodexLbDesktopDeepEvidence(raw, {
    expectedMode: options.expectedMode,
    expectedEndpoint: options.expectedEndpoint,
    trustAnchors: options.trustAnchors,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.maxAgeMs !== undefined ? { maxAgeMs: options.maxAgeMs } : {}),
    ...(options.maxFutureSkewMs !== undefined ? { maxFutureSkewMs: options.maxFutureSkewMs } : {})
  })
  const blockers = [...validation.blockers]
  const verifiedFields: string[] = []
  const payload = validation.evidence
  const allowedProducerIds = new Set(options.allowedProducerIds || DEFAULT_RELEASE_PRODUCERS)

  if (validation.state !== 'verified' || !payload) {
    blockers.push('codex_lb_desktop_real_evidence_unverified')
  } else {
    if (!validation.producer_id || !allowedProducerIds.has(validation.producer_id)) {
      blockers.push('codex_lb_desktop_real_evidence_producer_not_allowed')
    }
    for (const field of CODEX_LB_DESKTOP_REAL_EVIDENCE_REQUIRED_TRUE_FIELDS) {
      if (payload[field] === true) verifiedFields.push(field)
      else blockers.push(`codex_lb_desktop_real_evidence_required_true:${field}`)
    }
    for (const field of REQUIRED_NONEMPTY_STRING_FIELDS) {
      if (typeof payload[field] === 'string' && payload[field].trim()) verifiedFields.push(field)
      else blockers.push(`codex_lb_desktop_real_evidence_required_string:${field}`)
    }
    for (const field of REQUIRED_NONEMPTY_ARRAY_FIELDS) {
      if (Array.isArray(payload[field]) && payload[field].length > 0) verifiedFields.push(field)
      else blockers.push(`codex_lb_desktop_real_evidence_required_array:${field}`)
    }
    if (payload.desktop_adoption_source !== 'codex_desktop_runtime') {
      blockers.push('codex_lb_desktop_real_evidence_adoption_source_invalid')
    }
    if (payload.source_surface !== 'codex_desktop_runtime') {
      blockers.push('codex_lb_desktop_real_evidence_source_surface_invalid')
    }
    if (!/^[a-f0-9]{64}$/i.test(String(payload.protocol_fixture_schema_hash || ''))) {
      blockers.push('codex_lb_desktop_real_evidence_protocol_fixture_hash_invalid')
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(String(payload.app_origin_observed || ''))) {
      blockers.push('codex_lb_desktop_real_evidence_app_origin_invalid')
    }
    const requestTier = normalizeFastTier(payload.request_service_tier)
    const responseTier = normalizeFastTier(payload.response_actual_service_tier)
    if (requestTier !== 'priority') blockers.push('codex_lb_desktop_real_evidence_fast_request_invalid')
    if (responseTier !== 'priority') blockers.push('codex_lb_desktop_real_evidence_fast_response_invalid')
    if (!['fast', 'priority'].includes(String(payload.configured_service_tier || '').toLowerCase())) {
      blockers.push('codex_lb_desktop_real_evidence_fast_configuration_invalid')
    }
    if (!['responses_tool', 'images_api'].includes(String(payload.image_route || ''))) {
      blockers.push('codex_lb_desktop_real_evidence_image_route_invalid')
    }
    if (!(Array.isArray(payload.image_events) && payload.image_events.some(isImageOutputEvent))) {
      blockers.push('codex_lb_desktop_real_evidence_image_output_event_missing')
    }
    if (!(Array.isArray(payload.computer_events) && payload.computer_events.some(isComputerCallEvent))) {
      blockers.push('codex_lb_desktop_real_evidence_computer_call_event_missing')
    }
    if (
      Array.isArray(payload.auxiliary_events)
      && Array.isArray(payload.auxiliary_output_events)
      && stableJson(payload.auxiliary_events) !== stableJson(payload.auxiliary_output_events)
    ) {
      blockers.push('codex_lb_desktop_real_evidence_auxiliary_events_changed')
    }
  }

  const uniqueBlockers = unique(blockers)
  const ok = uniqueBlockers.length === 0
  return {
    schema: CODEX_LB_DESKTOP_REAL_EVIDENCE_CHECK_SCHEMA,
    ok,
    status: ok ? 'passed' : 'real_required_missing',
    release_authorizing: ok,
    mode: options.expectedMode,
    endpoint: options.expectedEndpoint,
    producer_id: validation.producer_id,
    deep_evidence_validation: validation,
    required_true_fields: CODEX_LB_DESKTOP_REAL_EVIDENCE_REQUIRED_TRUE_FIELDS,
    required_string_fields: REQUIRED_NONEMPTY_STRING_FIELDS,
    required_array_fields: REQUIRED_NONEMPTY_ARRAY_FIELDS,
    verified_fields: unique(verifiedFields),
    blockers: uniqueBlockers,
    warnings: validation.warnings
  }
}

function normalizeFastTier(value: unknown): string | null {
  const tier = String(value || '').trim().toLowerCase()
  if (tier === 'fast') return 'priority'
  return tier || null
}

function stableJson(value: unknown): string {
  return JSON.stringify(value)
}
