# Latest-Stable Version Guidance Policy

User-facing guidance goes stale the moment it names a number. A README that says
"use CLI x.y.z" is wrong the week after the next release, and an error message
that names a minimum version keeps being wrong long after the requirement moved.

The rule for every surface a user reads is:

> Recommend the **official latest stable** release, and let a **capability probe**
> decide what actually works.

## What good guidance looks like

```text
Use the official latest stable SKS and Codex CLI releases.
Run `sks update-check` and read the capability report for the current state.
Feature support is decided by capability probes, not by a pinned version number.
```

What it must not look like:

```text
Use SKS x.y.z.
Codex CLI x.y.z or newer is required.
The current preferred channel is x.y.z.
```

## Where the numbers are still allowed to live

A machine still has to compare versions. That comparison belongs in code and in
machine-readable configuration, and the number must not be copied out into prose:

- `PACKAGE_VERSION` / package metadata for the package's own identity
- machine-readable compatibility configuration (for example
  `src/core/codex-compat/codex-runtime-contract.ts`)
- machine reason codes and status fields consumed by other programs
- lockfiles, schema revisions, migration fixtures, vendored protocol snapshots
- `CHANGELOG.md` and historical release ledgers, which record the past
- fixtures and assertions that reproduce a specific historical bug

So `remoteControlGuidance()` still gates on the compatibility constant, but the
sentence the operator reads says "install the official latest stable release"
instead of repeating the constant.

## The gate

`latest-version:guidance` runs `dist/scripts/latest-version-guidance-check.js`.
It scans:

| Surface | Scope |
| --- | --- |
| `README.md` | whole file |
| `docs/*.md` | general user documentation (compatibility, migration, and historical ledgers exempt) |
| `src/**/*.ts` | **string literals only** — what the program prints as usage, help, error guidance, or an agent directive |
| `native/**/*.swift` | string literals only — menu bar user text |

A finding is raised when a three-part version appears within the same sentence
neighbourhood as guidance wording (`current release`, `preferred`, `minimum`,
`at least`, `requires`, `update to`, `recommended`, `or later`, `이상`, `권장`,
`최소`, …). Historical wording in the same neighbourhood (`fixed in`,
`released in`, `changelog`, `compatibility matrix`, `previously`, …) suppresses
it, because those are statements about the past rather than advice.

Deliberate design choices:

- It is **not** a bare semver regex. `node >= 20.11`, `sks.context-graph.v1`,
  ISO dates, and a version mentioned as a historical fact do not trip it.
- Source files are scanned as string literals only, so a comment explaining why
  a compatibility constant exists is not treated as user guidance.
- Exempt paths are listed explicitly in the check and reported in the gate
  output, so the exemption set is auditable rather than implicit.

Run it directly:

```bash
node ./dist/scripts/latest-version-guidance-check.js
```

The report is written to `.sneakoscope/reports/latest-version-guidance.json`.
