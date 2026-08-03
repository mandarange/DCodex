# Current Runtime Truth

SKS runtime claims are derived from current mission artifacts and machine
checks. Static flags, preparation output, terminal panes, and prose summaries
cannot promote a subsystem to proven.

## Required Evidence Domains

- official subagent plan and bounded role selection
- official lifecycle event correlation
- trustworthy parent outcome for every requested thread
- parent-owned integration and scoped verification
- route-specific safety and completion gates
- TriWiki source hydration where the decision depends on recalled context
- update, doctor, managed-residue, and installed-package verification
- package, tarball, macOS, Linux, and registry evidence for a release

Canonical Naruto evidence is:

- `subagent-plan.json`
- `subagent-events.jsonl`
- `subagent-parent-summary.json`
- `subagent-evidence.json`
- `naruto-summary.json`
- `naruto-gate.json`
- `work-order-ledger.json`

Run the current inspection surfaces with:

```bash
sks naruto proof latest --json
sks validate-artifacts latest --json
sks pipeline status --json
npm run release:check:affected
```

Missing or ambiguous evidence remains blocked or unverified. SKS never infers
successful official-thread completion from process counts or UI telemetry.
