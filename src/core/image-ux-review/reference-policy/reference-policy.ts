import type { ImageReferenceEvidence } from '../../image/reference-evidence/reference-registry.js';

export interface ImageReferencePolicyDecision {
  readonly schema: 'sks.image-reference-policy-decision.v1';
  readonly allowed: boolean;
  readonly action: 'use-local-reference' | 'request-revalidation' | 'request-transfer-consent';
  readonly cache_status: 'MISS' | 'EXPIRED' | 'BYPASS';
  readonly blockers: readonly string[];
}

export function decideImageReferenceUse(input: {
  reference: ImageReferenceEvidence;
  operation: 'local-review' | 'external-transfer';
  hasOneShotPermit?: boolean;
}): ImageReferencePolicyDecision {
  if (input.reference.status !== 'valid') {
    return { schema: 'sks.image-reference-policy-decision.v1', allowed: false, action: 'request-revalidation', cache_status: 'EXPIRED', blockers: ['expired_reference'] };
  }
  if (input.operation === 'external-transfer' && (!input.hasOneShotPermit || input.reference.consent !== 'external-transfer-approved')) {
    return { schema: 'sks.image-reference-policy-decision.v1', allowed: false, action: 'request-transfer-consent', cache_status: 'BYPASS', blockers: ['image_external_transfer_permit_required'] };
  }
  return { schema: 'sks.image-reference-policy-decision.v1', allowed: true, action: 'use-local-reference', cache_status: 'MISS', blockers: [] };
}
