/**
 * Packed tarball ceiling; slight headroom above the measured Context Graph surface.
 *
 * The compiled Context Graph engine — extractors, compiler, store, lint, query,
 * projections — is required at runtime: `sks search context`,
 * `sks wiki refresh --code`, TriWiki attention and the Naruto advisory all read
 * it from an installed package. Its benchmark corpus, fixtures and tuning
 * optimizer are development instruments and are excluded from the packlist
 * instead of being paid for here.
 *
 * 8.0.3 re-measure: the Telegram remote transport (dist/core/telegram),
 * `sks config adopt` (dist/core/config-adopt) and the shared credential
 * hardening/routing-truth surface (dist/core/security) are installed runtime
 * code, measured at 2,850,669 packed / 12,841,661 unpacked.
 */
export const DEFAULT_MAX_PACK_BYTES = 2800 * 1024
/** ~12.35 MiB; narrow headroom above the measured Desktop bridge, capability and Telegram runtime surface. */
export const DEFAULT_MAX_UNPACKED_BYTES = 12_950_000
