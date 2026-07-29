# Mission Scoping Design

Mission identity is explicit and route-local. A command that creates or
selects a mission must pass the resulting mission ID through every later read,
write, status, proof, and cleanup step.

## Identity Rules

1. A newly created mission ID is authoritative for the command that created it.
2. A supplied `--mission` or positional mission ID is authoritative for status,
   proof, and continuation commands.
3. `latest` is a convenience selector only. It must be resolved within the
   requested route or artifact contract, never as an unrestricted substitute
   after a command has already created a mission.
4. Session-scoped state lives under `.sneakoscope/state/sessions/`; the shared
   current snapshot is a projection, not the sole identity source.
5. Background work, menu actions, and remote workers carry
   the mission ID explicitly across process boundaries.

## Route-Local Artifacts

Every mission writes under:

```text
.sneakoscope/missions/<mission-id>/
```

Naruto keeps its official evidence in the mission root:

- `subagent-plan.json`
- `subagent-events.jsonl`
- `subagent-parent-summary.json`
- `subagent-evidence.json`
- `work-order-ledger.json`
- `naruto-summary.json`
- `naruto-gate.json`

Route-specific gates may add files, but they must not read another route's
newest mission merely because it has a newer modification time.

## Creation And Continuation

Creation returns `{ id, dir, mission }`. Callers use that return value directly
instead of immediately rediscovering the mission. Continuation first resolves
an explicit ID or a session-bound ID, validates that the mission and expected
route artifacts exist, and only then proceeds.

Status commands may accept `latest`, but the resolver must filter by the
requested route mode or gate. A result from an unrelated route is a miss, not a
fallback candidate.

## Concurrent Sessions

Multiple Codex sessions may operate in one repository. State and artifact
updates therefore follow these rules:

- mission creation and current-state writes use the state lock;
- each session has a stable session key;
- a new mission records preemption without overwriting another mission's
  durable evidence;
- route close operations verify the requested mission ID before changing
  session state;
- background refreshes write only to the mission and generation they were
  given;
- retention skips active or recently updated missions.

## Verification Checklist

- No create-then-global-latest lookup remains in the changed path.
- Status/proof `latest` resolution is route-scoped.
- Mission IDs survive subprocess, remote, menu bar, and callback boundaries.
- Writes stay under the selected mission directory.
- Parent and child evidence names the same mission ID and workflow run ID.
- Concurrent-session tests prove that one session cannot adopt another
  session's mission.
- Cleanup removes only SKS-owned retired residue and preserves user-authored
  collisions in quarantine.

Mission scoping failures are correctness failures. They must block rather than
silently adopting a nearby mission.
