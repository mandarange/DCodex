# No Runtime MJS Shadows

SKS removes parallel `src/**/*.mjs` runtime shadows.

`scripts/**/*.mjs` and test fixtures may remain when they are tooling or fixture code, but runtime source under `src/` must be TypeScript. The release gate fails if any `src/**/*.mjs` file exists, if `dist/**/*.mjs` appears, or if compiled dist metadata is stale against the TypeScript source digest.

Manual TS/MJS synchronization is no longer a supported workflow.
