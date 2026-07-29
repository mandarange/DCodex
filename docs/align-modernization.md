# SKS Align Modernization Contract

`$sks-align` is a one-shot, evidence-gated modernization route. It does not authorize publication, installation into a user's global Codex directory, or unrelated product refactors.

## Active official baselines

The route records retrieval receipts for all active sources in `align-ledger.json`:

- [GPT-5.6 migration and prompting](https://developers.openai.com/api/docs/guides/latest-model)
- [Programmatic tool calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling)
- [Agents](https://developers.openai.com/api/docs/guides/agents)
- [Codex Skills](https://developers.openai.com/codex/skills)
- [Codex Plugins](https://developers.openai.com/codex/plugins)
- [OpenAI Plugins repository](https://github.com/openai/plugins)

The deprecated [openai/skills repository](https://github.com/openai/skills) is migration evidence only. It is not an active schema or content baseline.

## Prompt contract

Generated prompts are outcome-first and keep only instructions that change behavior. Lean wording must preserve:

- measurable success and stop conditions;
- permission, safety, and business invariants;
- tool-routing and approval boundaries;
- required evidence, output, and validation contracts;
- state, cache, lifecycle, and parent/child ownership rules.

Prompt cleanup is evaluated incrementally. A byte reduction is useful evidence but never substitutes for focused behavior tests.

## Programmatic tool calling decision

The current SKS orchestration loop does **not** adopt programmatic tool calling as its default. Most route execution is adaptive, may require approval or writes, and depends on native artifacts or evidence that should remain direct tool calls. PTC remains an eligible future optimization only for bounded, predictable read/reduction batches with an enabled `programmatic_tool_calling` feature, an explicit allowed-caller contract, structured outputs, exact `call_id` replay, and preservation of every response item.

## Agents decision

The current Codex App-owned loop does **not** migrate wholesale to the Agents SDK. SKS already binds official Codex subagent lifecycle, role selection, parent integration, evidence, and recovery to the host. The Agents SDK becomes appropriate only when recurring orchestration, handoffs, guardrails, sessions, or tracing should become SDK-owned. Any future migration must preserve Sol/Terra/Luna roles, reasoning effort, state/cache behavior, tool contracts, and proof semantics.

## Skill and plugin contract

Generated `SKILL.md` files use progressive disclosure and deterministic discovery descriptions of at most 64 characters. The release gate budgets skill names, descriptions, and relative paths together against Codex's 8,000-character initial list, leaving headroom for host formatting and absolute path prefixes. Generated `agents/openai.yaml` files use the current minimal `interface` plus `policy.allow_implicit_invocation` profile; current optional icon/dependency fields remain valid, while unsupported historical routing keys are rejected. High-impact actions that require direct user intent disable implicit invocation.

Plugins are the installable distribution unit and require `.codex-plugin/plugin.json`. SKS does not invent plugin packaging for skills that remain project- or user-local generated assets.

## Gate requirements

`align-gate.json` passes only when the mission has:

- a `work-order-ledger.json` created from the literal request and closed only
  after both the canonical Completion Proof and trust report are verified, or
  honestly blocked with the route's real blockers;
- valid ISO artifact metadata plus the exact six-workstream and full policy
  contracts from the sealed plan;
- evidence for every sealed workstream;
- receipts for every active official source and a deprecated-source migration record;
- complete command and generated-skill coverage with no missing surfaces;
- explicit PTC and Agents adoption decisions;
- at least 12 passing prompt-evaluation cases, immutable-core integrity, and verification receipts;
- an evidenced change review with either unique changed paths or an explicit
  `none_required` result, a deleted-setting inventory, and a deduplication
  review whose changed surfaces are included in its reviewed set;
- no blockers and mission-consistent artifacts.

Verification receipts must cover exactly these five sealed kinds once each:
`typecheck`, `build`, `focused_tests`, `skill_surface_audit`, and
`release_affected`. Every receipt records the exact command, passing status, zero
exit code, and a non-empty evidence file below the mission's `evidence/`
directory. Absolute paths, traversal, duplicate references, empty files, and
symbolic-link escapes fail closed. A receipt also fails if its command does not
match its declared verification kind.

The skill-surface audit runs directly as
`node ./dist/scripts/skill-surface-modernization-check.js`; it intentionally does
not consume a package-script slot.

Listing workstream names as complete is insufficient.

`status latest` and `proof latest` resolve only missions whose sealed mission,
plan, and route-context identity is Align. An explicit foreign, malformed, or
legacy mission id is rejected before any gate or proof file is written.

## Deliberate exclusions

Vendored upstream prompts and host-owned runtime snapshots are not rewritten during Align. Release-version pins and compatibility manifests change only through their own current-source and release-proof workflow. Global skill installation, commits, pushes, deployment, and publication remain separate user-authorized actions.
