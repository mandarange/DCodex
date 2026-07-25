/**
 * One place to answer "does this generated image count as real evidence?".
 *
 * The taxonomy was previously restated in every gate (route gate, stop gate,
 * PPT slide review, generated-image ledger), so widening it meant finding all of
 * them. It is stated once here and the gates ask.
 *
 * The classes:
 *
 * - `codex_app_imagegen` — produced by the Codex App `$imagegen` surface and
 *   picked up from `~/.codex/generated_images` or attached by hand.
 * - `codex_lb_provider_imagegen` — produced by the codex-lb provider the user
 *   has *selected* in `config.toml`, through that provider's Responses endpoint
 *   with the same Codex `image_generation` tool. Not the Codex App surface, but
 *   not a detour either: it is the provider Codex itself is configured to use,
 *   and under codex-lb it is the only surface that answers.
 * - `non_codex_api_fallback` — an explicitly requested call to a different
 *   vendor's API (`OPENAI_API_KEY` against api.openai.com, or codex-lb enabled
 *   as a fallback while another provider is selected). Real bytes, wrong
 *   provenance for a Codex route.
 * - `mock_fixture` — the hermetic fake adapter. Never evidence.
 */

export const CODEX_APP_IMAGEGEN_EVIDENCE_CLASS = 'codex_app_imagegen';
export const CODEX_LB_PROVIDER_IMAGEGEN_EVIDENCE_CLASS = 'codex_lb_provider_imagegen';
export const NON_CODEX_API_FALLBACK_EVIDENCE_CLASS = 'non_codex_api_fallback';
export const MOCK_FIXTURE_EVIDENCE_CLASS = 'mock_fixture';

/** Classes that count as a real image from the user's configured Codex provider. */
export const FULL_IMAGEGEN_EVIDENCE_CLASSES: readonly string[] = Object.freeze([
  CODEX_APP_IMAGEGEN_EVIDENCE_CLASS,
  CODEX_LB_PROVIDER_IMAGEGEN_EVIDENCE_CLASS
]);

export const CODEX_LB_PROVIDER_OUTPUT_SOURCE = 'codex_lb_provider_responses';

/** How a full-evidence image may have reached the mission. */
export const FULL_IMAGEGEN_OUTPUT_SOURCES: readonly string[] = Object.freeze([
  'manual_attach',
  'auto_discovered_generated_images',
  CODEX_LB_PROVIDER_OUTPUT_SOURCE
]);

export function isFullImagegenEvidenceClass(value: unknown): boolean {
  return FULL_IMAGEGEN_EVIDENCE_CLASSES.includes(String(value || ''));
}

export function isFullImagegenOutputSource(value: unknown): boolean {
  return FULL_IMAGEGEN_OUTPUT_SOURCES.includes(String(value || ''));
}

/**
 * The blockers a gate should raise for an evidence class, most specific first.
 * `prefix` names the gate's blocker namespace (`imagegen_response`,
 * `generated_review_image`, `ppt_slide_imagegen`, ...).
 */
export function imagegenEvidenceClassBlockers(prefix: string, value: unknown): string[] {
  const evidenceClass = String(value || '');
  if (!evidenceClass) return [`${prefix}_evidence_class_missing`];
  if (isFullImagegenEvidenceClass(evidenceClass)) return [];
  return [
    ...(evidenceClass === MOCK_FIXTURE_EVIDENCE_CLASS ? [`${prefix}_mock_fixture_not_full_evidence`] : []),
    ...(evidenceClass === NON_CODEX_API_FALLBACK_EVIDENCE_CLASS ? [`${prefix}_non_codex_api_fallback_not_full_evidence`] : []),
    `${prefix}_evidence_class_not_codex_app:${evidenceClass}`
  ];
}
