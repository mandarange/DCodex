# vX.Y.Z

Copy the matching `CHANGELOG.md` version section here only after it is
bound to the final release commit.

## Release decision

- Decision: **READY** / **BLOCKED**
- Final commit:
- Version:
- Worktree clean:
- Do not use an unqualified source-completion label. State the actual evidence
  and remaining blockers instead.

## Evidence classification

Use only the following labels and attach an artifact path or command result to
each row:

| Requirement or gate | Status | Artifact / exact blocker |
| --- | --- | --- |
| final build, typecheck, test corpus, release DAG | passed-hermetic / blocked-external | |
| package/tarball/receipt/stamp | passed-hermetic / blocked-external | |
| macOS launchd lifecycle | not-run-real / passed-hermetic | |
| Codex Desktop Providers UI | not-run-real / passed-hermetic | |
| OAuth preservation | not-run-real / passed-hermetic | |
| Codex-LB/OpenRouter/coexistence | not-run-real / passed-hermetic | |
| WebSocket protocol/frame/close | not-run-real / passed-hermetic | |
| deep capability artifacts | not-run-real / passed-hermetic | |
| GitHub main/tag/npm owner/human approval | blocked-external / passed-hermetic | |

`passed-hermetic` never proves a live environment. Do not turn a fixture,
configured credential, process status, or successful diagnostic command into a
live claim.

## Product-surface confirmation

- [ ] `sks bridge` is the only public managed Desktop Bridge surface.
- [ ] The user override is respected: `sks codex-lb` returns
  `unknown_command` and has no public alias or forwarding path.
- [ ] Historical routing markers are migration-only and are not a live
  runtime/alias.
- [ ] Missing or ambiguous model routes do not silently fall back.

## Added

- 

## Changed

- 

## Fixed

- 

## Verification

- `npm run release:check:full`
- `node ./dist/scripts/release-check-stamp.js verify`
- `npm publish --dry-run --json --registry https://registry.npmjs.org/ --tag latest --access public`

For a separately authorized staged release, verify before any human approval:

```sh
node ./dist/scripts/npm-stage-tarball-verifier.js \
  --stage-id <stage-id> \
  --dispatch-nonce <32-lowercase-hex> \
  --physical-evidence-run-id <physical-capture-workflow-run-id> \
  --workflow-run-id <stage-workflow-run-id> \
  --local-receipt /absolute/path/to/local-pack-receipt.json \
  --local-tarball /absolute/path/to/sneakoscope-X.Y.Z.tgz \
  --stage-receipt /absolute/path/to/npm-stage-receipt.json
```

This verifier is read-only. It does not stage, approve, reject, publish, tag,
or push. `npm stage approve <stage-id>` requires separate maintainer
authority and human 2FA.
