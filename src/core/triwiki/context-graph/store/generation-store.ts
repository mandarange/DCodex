/**
 * Content-addressed generation store for the compact context index — public
 * entry point.
 *
 * The store owns the transition from "some bytes a compiler produced" to "the
 * index every query reads". Four rules govern that transition, and each one
 * lives with the code that enforces it:
 *
 * | Rule | Owner |
 * | --- | --- |
 * | Pointer is replaced last, after every lint and checksum | `generation-commit.ts` |
 * | Meta is written twice (immutable sidecar + reader mirror) | `generation-commit.ts`, restored by `generation-recovery.ts` |
 * | Pointer/meta divergence is raised, never resolved by preference | `generation-pointer.ts` |
 * | The previous generation is not a rollback target | `generation-resolve.ts`, `generation-retention.ts` |
 *
 * Supporting modules: `generation-layout.ts` (on-disk layout and retention
 * count), `generation-errors.ts` (closed failure vocabulary, integers only),
 * `generation-io.ts` (durability primitives), `generation-verify.ts` (structure,
 * checksums, content-address identity).
 *
 * Importers should keep using this module: the split is internal, and the
 * surface re-exported here is the contract.
 */
export * from './generation-errors.js';
export * from './generation-layout.js';
export * from './generation-io.js';
export * from './generation-verify.js';
export * from './generation-pointer.js';
export * from './generation-commit.js';
export * from './generation-retention.js';
export * from './generation-resolve.js';
export * from './generation-recovery.js';
