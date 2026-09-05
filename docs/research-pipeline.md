# SKS Research Pipeline

SKS Research is a read-only route for source-backed discovery and implementation handoff. It writes only mission-local artifacts under `.sneakoscope/missions/<id>/`; repository source, package metadata, docs, config, and generated harness files remain out of scope during a normal research run.

As of 2.0.15, every research mission is created with `research-quality-contract.json`. The default contract requires at least 12 total sources, 5 covered source layers, 2 counterevidence sources, 8 key claims, 6 triangulated claims, 8 implementation blueprint sections, 4 falsification cases, 5 experiment steps, and a 2200-word research report before the gate can pass.

The run writes `research-work-graph.json` and executes one dependency-aware cycle runner. External source layers use bounded Super Search acquisition and URL hydration, then `source_ledger_merge`, `claim_matrix_build`, `falsification`, `implementation_blueprint`, `experiment_plan`, `synthesis`, `final_review`, and `verification` run only after their dependencies finish. The old native-agent pre-run and legacy `final.md` loop are not part of the runtime. Research is not a code-change route: stages may write mission artifacts, but source/package/docs/config mutation is blocked.

`source-ledger.json` is merged from source shard partials, and `claim-evidence-matrix.json` is built from the merged source, novelty, and falsification ledgers. Each real verified row retains its Super Search proof/source-ledger paths and digests. Before a row can support a reviewer finding, SKS rechecks the proof schema and blocker state, source-ID membership, hydrated content path, SHA-256, and length; a self-declared `verified_content` field is insufficient. The synthesis stage writes `research-synthesis-output.json`, `research-report.md`, and the research paper artifact. In non-mock runs, synthesis must use the evidence-bound Codex/GPT writer; deterministic report rendering is mock/fallback only.

Template-like prose, repeated paragraphs, summary-only reports, low source density, low claim density, and thin implementation sections are rejected by static report quality checks and final review. The implementation blueprint is repository-aware and leaves `naruto-handoff-goal.md` for `$sks-naruto`; it is not an implementation patch.

Final review has two layers: deterministic validators, followed by three independent composite Astra Max reviewers running through the Codex official subagent facade and the project-scoped `research_reviewer` custom agent. Together they cover first-principles explanation and experiment design, formal systems and adversarial strategy, and counterevidence, methodology, and reproducibility. Each thread must return a structured outcome with source IDs, its strongest attempted falsification, objections, required revisions, and verdict. A bounded revision cycle may update only mission-local report/paper artifacts; then all three reviewers run again in fresh threads. Missing or malformed outcomes, lifecycle/evidence mismatches, any non-approval, or any unresolved critical, major, minor, or required revision keeps `research-adversarial-convergence.json` blocked. `research-final-review.codex.json` is a compatibility projection of that structured council, not a second single-review model call.

`research-honest-mode.json` explicitly refuses guarantees of genius-level intelligence, scientific novelty, breakthrough status, peer review, or publication acceptance. Persona names describe cognitive lenses only and never impersonate historical people.

Fast checks:

```sh
npm run research:quality-gates
npm run research:synthesis-writer
npm run research:repetition-detector
npm run research:template-report-rejection
npm run research:handoff-consumability
npm run research:stage-cycle-runtime-blackbox
npm run research:short-report-rejection
npm run codex-sdk:research-pipeline
sks research run latest --mock --json
```
