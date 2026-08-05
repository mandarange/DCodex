import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { sha256 } from '../../fsx.js'
import type {
  ProviderCapabilityProbeContextV3
} from '../capability-types.js'
import type { CapabilityProbeResultV3 } from '../bridge-contracts.js'
import { capabilityProbeResultV3 } from './probe-evidence.js'

export interface ImageGenerationProbeInputV3 extends ProviderCapabilityProbeContextV3 {
  attempted?: boolean
  fixture?: boolean
  outputEventSeen?: boolean
  artifactPath?: string | null
  artifactSha256?: string | null
  advertised?: boolean
}

export function runImageGenerationProbeV3(input: ImageGenerationProbeInputV3): CapabilityProbeResultV3 {
  if (input.requestedLevel !== 'deep' || input.attempted !== true || input.fixture === true) {
    return capabilityProbeResultV3({
      ...input,
      capability: 'image_generation',
      scope: `provider:${input.providerId}`,
      stage: 'preflight',
      state: 'not_attempted',
      source: input.advertised ? 'manifest' : 'config',
      warnings: input.fixture ? ['image_fixture_not_live_evidence'] : [],
      recoveryAction: 'run_deep_verification',
      evidence: {
        advertised: input.advertised === true,
        fixture: input.fixture === true,
        reason: input.fixture ? 'fixture_not_live_evidence' : 'deep_verification_not_run'
      }
    })
  }
  if (input.outputEventSeen !== true) {
    return imageFailure(input, 'feature_response', 'image_output_event_filtered')
  }
  const artifact = validateImageArtifact(input.artifactPath, input.artifactSha256)
  if (!artifact.ok) return imageFailure(input, 'artifact_validation', artifact.blocker, artifact.evidence)
  return capabilityProbeResultV3({
    ...input,
    capability: 'image_generation',
    scope: `provider:${input.providerId}`,
    stage: 'complete',
    state: 'verified',
    source: 'artifact',
    evidence: { output_event_seen: true, ...artifact.evidence }
  })
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

function imageFailure(
  input: ImageGenerationProbeInputV3,
  stage: 'feature_response' | 'artifact_validation',
  blocker: string,
  evidence: Record<string, unknown> = {}
): CapabilityProbeResultV3 {
  return capabilityProbeResultV3({
    ...input,
    capability: 'image_generation',
    scope: `provider:${input.providerId}`,
    stage,
    state: 'blocked',
    terminal: true,
    rootCause: blocker,
    blockers: [blocker],
    retryable: true,
    recoveryAction: 'run_deep_verification',
    source: stage === 'artifact_validation' ? 'artifact' : 'deep_probe',
    evidence: { output_event_seen: input.outputEventSeen === true, ...evidence }
  })
}

function validateImageArtifact(
  artifactPath: string | null | undefined,
  expectedSha256: string | null | undefined
): { ok: true; evidence: Record<string, unknown> } | { ok: false; blocker: string; evidence: Record<string, unknown> } {
  if (!artifactPath || !isAbsolute(artifactPath)) {
    return { ok: false, blocker: 'image_artifact_path_invalid', evidence: { artifact_path: artifactPath || null } }
  }
  if (!expectedSha256 || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    return { ok: false, blocker: 'image_artifact_digest_invalid', evidence: { artifact_path: artifactPath } }
  }
  try {
    const stat = statSync(artifactPath)
    if (!stat.isFile() || stat.size <= 0) {
      return { ok: false, blocker: 'image_artifact_not_materialized', evidence: { artifact_path: artifactPath } }
    }
    const bytes = readFileSync(artifactPath)
    const format = imageArtifactFormat(bytes)
    if (!format) {
      return { ok: false, blocker: 'image_artifact_format_invalid', evidence: { artifact_path: artifactPath } }
    }
    const actualSha256 = sha256(bytes)
    if (actualSha256 !== expectedSha256.toLowerCase()) {
      return {
        ok: false,
        blocker: 'image_artifact_digest_mismatch',
        evidence: { artifact_path: artifactPath, artifact_sha256: actualSha256, artifact_bytes: stat.size, artifact_format: format }
      }
    }
    return {
      ok: true,
      evidence: { artifact_path: artifactPath, artifact_sha256: actualSha256, artifact_bytes: stat.size, artifact_format: format }
    }
  } catch {
    return { ok: false, blocker: 'image_artifact_not_materialized', evidence: { artifact_path: artifactPath } }
  }
}

function imageArtifactFormat(bytes: Buffer): 'png' | 'jpeg' | 'gif' | 'webp' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  return null
}
