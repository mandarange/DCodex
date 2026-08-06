# SKS 8.1.3 Release Readiness

## Current decision

**SOURCE COMPLETE / RELEASE BLOCKED.** The 8.1.3 implementation is integrated
and its local source corpus is green. Publication is still blocked because
trusted physical macOS/provider evidence, release-commit promotion to main and
the exact tag, npm maintainer authentication, and explicit stage/publish
authority are absent. Earlier SHA-bound artifacts never authorize this release.

Evidence labels in this document are intentionally narrow:

- **passed-hermetic** — current local source/build/test evidence only;
  exact-commit package receipts are regenerated at handoff.
- **not-run-real** — required real evidence is absent.
- **blocked-external** — operator authority or an external target is required.

The current execution surface is `$sks-naruto` / `sks naruto run`, with
`$sks-work` as the explicit plan-execution route. `sks doctor --fix`
remains an operator-run repair command; release automation must never silently
invoke it. Update and Control Center views share the
`sks.update-status.v3` snapshot.

## User override: legacy paths are deleted

The user supersedes the work order's former one-version alias proposal:

- `sks codex-lb` is removed and must return `unknown_command`; no alias,
  forwarding, or deprecation facade remains.
- Legacy Desktop/provider modes are not active runtime paths.
- Historical SKS-owned markers are allowed only as private migration input
  behind a receipt-backed path; they are not a runnable legacy mode.

Public bridge operations use `sks bridge`. This override is tested
hermetically by `router-codex-lb-removed` and is rechecked through the packed
installation smoke on the clean release candidate.

## Contract and gate classification

| Requirement or gate | Current classification | Bound evidence / condition |
| --- | --- | --- |
| one Desktop Bridge runtime, independent profiles, explicit route index, no fallback | passed-hermetic | current source/fixture coverage |
| migration, rollback, user-owned config protection, catalog/capability contracts | passed-hermetic | current integrated fixtures |
| removed public command and legacy runtime/alias removal | passed-hermetic | user override plus command-surface fixture |
| build, typecheck, bridge/CLI/native tests | passed-hermetic | current integrated source |
| full canonical corpus | passed-hermetic | 2,851 parallel plus 33 resource-sensitive serial tests, zero failures |
| Naruto capacity lifecycle | passed-hermetic | 102/102; only live/open children consume the 256-child capacity and terminal agents return slots |
| physical/stage/release focused corpus | passed-hermetic | 50/50; cryptographic dispatch nonce, exact workflow/run association, and producer trust checks included |
| package dry-run, pack receipt, package secret scan, installed smoke | passed-hermetic when generated from the clean handoff commit | exact SHA and tarball bytes must match; historical receipts are invalid |
| real Desktop Bridge evidence gate | not-run-real | current artifact is `real_required_missing` and `release_authorizing:false` |
| installed macOS launchd lifecycle | not-run-real | no redacted install/start/restart/repair/process receipt |
| Codex Desktop Providers UI | not-run-real | no target-bound restart/render/state evidence |
| real OAuth preservation | not-run-real | no before/after target-bound semantic and byte evidence |
| live Codex-LB/OpenRouter/coexistence | not-run-real | no credential/catalog/bounded-route receipts |
| real WebSocket and deep artifacts | not-run-real | no stage-aware frame/close or provider-bound artifacts |
| fresh final stamp and physical receipts | blocked-external | require release-commit promotion and authorized target collection |
| GitHub main/tag, npm maintainer authentication, staging approval | blocked-external | require operator authority and human 2FA |

The 8.1.2 release stamp is stale; it cannot be reused for 8.1.3. No
historical green gate can replace exact-commit evidence or promote missing
physical evidence to release status.

## Final hermetic checks

Run these from the final clean, integrated tree. Retain command output or the
written result artifact and bind it to that exact source/version:

```sh
npm run build
npm run typecheck
node --test dist/cli/__tests__/router-codex-lb-removed.test.js
node --test dist/cli/__tests__/bridge-command-registration.test.js
node --test dist/core/codex-lb/__tests__/desktop-bridge-single-runtime-contract.test.js
node --test dist/core/codex-lb/__tests__/credential-coexistence-contract.test.js
node --test dist/core/codex-lb/__tests__/combined-catalog-conflict.test.js
node --test dist/core/codex-lb/__tests__/desktop-bridge-unification-rollback.test.js
node --test dist/core/subagents/__tests__/official-subagent-config.test.js
npm run release:check:full
npm run release:version-truth
npm run release:pack-receipt
```

The canonical runner includes the affected v3 capability, transport, route,
mutation, native UI, capacity-lifecycle, and secret-redaction tests. Strict
real-process deadline tests run in its resource-sensitive serial phase; the
production timeout contract is unchanged. If a source change follows any
source-bound artifact, rebuild and rerun the affected gate rather than claiming
inherited freshness.

## Real-environment acceptance

The following remain **not-run-real** until each has a redacted, target-bound
receipt. A hermetic test, configured credential, process listing, or screenshot
from a different source version does not substitute for any row.

| Item | Required proof |
| --- | --- |
| macOS bridge lifecycle | install/start/restart/repair plus process read-back |
| Codex Desktop | restart and current Providers UI state |
| OAuth | before/after semantic and byte-preservation evidence |
| Codex-LB | live authenticated catalog and bounded text route |
| OpenRouter | live authenticated catalog and bounded text route |
| coexistence | both configured credentials remain intact through operations |
| WebSocket | live stage-aware upgrade/protocol/frame/close evidence |
| deep capabilities | per-feature, provider-bound artifact/evidence |

## Documentation and package closure

The following source/document requirements are satisfied locally; package and
release receipts are still exact-commit handoff requirements:

- Package, lockfile, runtime/Rust metadata, README, and changelog all name
  8.1.3.
- CHANGELOG contains exactly one 8.1.3 section.
- Public docs advertise only `sks bridge` for bridge operations and describe
  the removed `sks codex-lb` command truthfully.
- Public docs contain no direct provider-activation or direct routing-config
  writer instructions.
- The implementation report and traceability ledger classify R01–R50, S01–S22,
  and release gates as `passed-hermetic`, `not-run-real`, or
  `blocked-external`.
- Package proof and tarball receipt are regenerated from the clean handoff
  commit. Release stamp and physical evidence remain blocked until authorized
  target collection and release-commit promotion; stale artifacts are never
  reused.

## TriWiki source binding

For a generated code pack, `git_head_sha` is the generation parent commit. A
later metadata-only code-pack commit may carry that pack only while the bound
parent remains an ancestor and intervening changes are confined to metadata.
Any source-change history invalidates the pack. The release flow starts from a
clean worktree and refreshes the pack after source changes; stale, truncated,
or non-ancestor history is a blocker rather than inferred freshness.

## Official Remote and SKS fleet control

The official Remote transport remains host-owned. SKS does not implement,
proxy, or reverse engineer that transport and never presents an SKS worker ID
as an official Remote session ID. The separate SKS SSH stdio worker is
proof-aware fleet control over an allowlisted typed channel; it is not a
replacement for official high-fidelity Remote coding.

## Release staging boundary

Only after final source-bound gates and physical evidence are current may an
authorized operator create a registry staging record with `npm stage publish`.
A second explicit authorization uses `npm stage approve <stage-id>`. Neither
command is implied by this work order, and a dry run is not publication.

Maintainer-side stage review resolves the pinned npm CLI explicitly as
`npx --yes npm@11.15.0`. Before any separately authorized approval, run the
read-only verifier with the exact stage id and immutable local/staged inputs:

```sh
node ./dist/scripts/npm-stage-tarball-verifier.js \
  --stage-id <stage-id> \
  --dispatch-nonce <32-lowercase-hex> \
  --physical-evidence-run-id <physical-capture-workflow-run-id> \
  --workflow-run-id <stage-workflow-run-id> \
  --local-receipt /absolute/path/to/local-pack-receipt.json \
  --local-tarball /absolute/path/to/sneakoscope-8.1.3.tgz \
  --stage-receipt /absolute/path/to/npm-stage-receipt.json
```

The verifier is read-only: it compares the local receipt, local tarball bytes,
and immutable stage receipt. It does not approve, reject, publish, tag, or
modify a stage.

The final migration matrix includes a `7.6.0 to 8.1.3 upgrade smoke`,
including the removed-command surface, Desktop Bridge receipt migration,
credential preservation, and current update finalization. Fixture success
cannot replace the real macOS and provider evidence listed above.
