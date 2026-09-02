# Completion Proof

> **10.0 (Essential Trust):** in the default `essential` verification profile, Completion Proof is available on request (`sks proof …`) and is **not** a Stop-time requirement — a finished turn finishes. Everything below describes the `strict` profile (`SKS_VERIFICATION_PROFILE=strict`), which keeps the pre-10 behavior. See [essential-trust.md](essential-trust.md).

SKS makes Completion Proof a route-bound completion requirement for serious routes. Serious route finalization writes a valid proof through the central finalizer, and Stop/Honest/HProof-style gates block missing, failed, blocked, invalid, or secret-bearing proof artifacts.

Route finalization also writes a Trust Kernel envelope:

- `.sneakoscope/missions/<id>/route-completion-contract.json`
- `.sneakoscope/missions/<id>/evidence-index.json`
- `.sneakoscope/missions/<id>/evidence.jsonl`
- `.sneakoscope/missions/<id>/trust-report.json`

Completion Proof includes links to the evidence router and trust report so proof claims can be checked against path-bound evidence.

## Files

- `.sneakoscope/proof/latest.json`
- `.sneakoscope/proof/latest.md`
- `.sneakoscope/proof/commands.jsonl`
- `.sneakoscope/proof/file-changes.json`
- `.sneakoscope/proof/unverified.md`
- `.sneakoscope/missions/<id>/completion-proof.json`
- `.sneakoscope/missions/<id>/completion-proof.md`

The current `$sks-naruto` workflow binds official Codex subagent evidence through the route gate:

```json
{
  "schema": "sks.completion-proof.v1",
  "route": "$sks-naruto",
  "evidence": {
    "route_gate": {
      "workflow": "official_codex_subagent",
      "official_subagent_evidence": true,
      "parent_summary_present": true
    }
  }
}
```

The supporting mission artifacts are `subagent-plan.json`, `subagent-events.jsonl`, `subagent-parent-summary.json`, `subagent-evidence.json`, `naruto-summary.json`, and `naruto-gate.json`. Process counts, pane counts, or synthetic worker output do not satisfy the current collaboration proof contract.

`sks naruto proof <mission> --json` is the stable external projection of that
six-artifact bundle. It returns `completed`, `blocked`, or `incomplete`, carries
the validated parent-owned summary, repository-relative changed files, bounded
verification rows, and exposes a deterministic `proof_fingerprint`. It does not
rewrite the terminal artifacts or include prompts, environment values, tokens,
or raw stdout/stderr.

## Status Values

Proof status must be one of:

- `verified`
- `verified_partial`
- `mock_only`
- `blocked`
- `not_verified`
- `failed`

Mock fixture evidence can support selftest coverage, but it must not be promoted to `verified` real-run evidence.

For UX-Review missions, Completion Proof includes `evidence.image_ux_review` with source screenshot count, generated gpt-image-2 callout image count, callout extraction schema status, open/fixed P0/P1 counts, recapture/re-review status, Image Voxel relation count, and official capture evidence mode. Text-only UX reviews and mock generated callouts cannot produce a real `verified` claim.

## Commands

```bash
sks proof show
sks proof show --json
sks proof latest --json
sks proof validate
sks proof validate --json
sks proof route latest --json
sks proof route <mission-id> --json
sks proof finalize latest --json
sks proof finalize <mission-id> --json
sks proof finalize latest --route '$sks-naruto' --json
sks proof finalize latest --strict --json
sks proof export --md
sks proof repair latest --json
sks trust report latest --json
sks trust validate latest --json
```

Route finalization lives under `src/core/proof/route-finalizer.ts`, route policy in `route-finalizer-policy.ts` and `route-proof-policy.ts`, route writing in `route-adapter.ts`, and Stop validation in `route-proof-gate.ts`.

Proof writing and validation redact secret-shaped values, including Codex access tokens, OpenAI API keys, and codex-lb API keys, with the common marker `[redacted]`. Mock and fixture evidence must stay `verified_partial`, `not_verified`, `mock`, or `fixture`; it must not be claimed as a real verified run.
