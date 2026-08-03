# Side-Effect Zero Policy

SKS treats every run as **side-effect zero by default**: the only thing a route may
mutate is the project the user pointed it at, and only for the work the user actually
requested. Everything global, destructive, or outside the project tree is denied
unless the user explicitly opts in. This policy is enforced by two compiled modules:

- `dist/core/safety/requested-scope-contract.js` — the deny-by-default scope contract.
- `dist/core/safety/mutation-ledger.js` — the append-only record of every mutation.

The gate `dist/scripts/side-effect-zero-gate-check.js` (id `safety:side-effect-zero`)
proves the invariants below and writes `.sneakoscope/reports/side-effect-zero.json`.

`dist/scripts/mutation-callsite-coverage-check.js` performs one static
scan across every production `src/**/*.ts` file, excluding test sources. Raw
mutation tokens must either be an observed `guarded*` call or match an external
`safety-mutation-allowlist.json` entry with exact `file`, `symbol`, `token`, and
`reason`. Unused, duplicate, or blanket allowlist entries fail.

## 1. The requested-scope contract (deny-by-default)

`createRequestedScopeContract({ route, userRequest, projectRoot?, overrides? })`
builds a contract (schema `sks.requested-scope-contract.v1`) where:

- `project_files` is the **only** mutation kind allowed by default.
- Every global/destructive kind is `false` by default:
  `global_codex_config`, `codex_app_process`, `codex_lb_auth`, `package_install`,
  `network`, `skill_snapshot_promotion`.
- `allowed_paths` is scoped to the project root (`<projectRoot>/**`).
- `forbidden_paths` always includes the global Codex config (`~/.codex/config.toml`)
  and installed applications (`/Applications/**`).

`isMutationAllowed(contract, kind, { confirmed? })` returns `{ allowed, reason }`:

| Situation | Result |
| --- | --- |
| `project_files` | `allowed: true`, reason `in_scope` |
| kind not in scope (default) | `allowed: false`, reason `mutation_not_in_scope:<kind>` |
| kind enabled via `overrides` but not confirmed | `allowed: false`, reason `requires_explicit_confirmation:<kind>` |
| kind enabled via `overrides` **and** `{ confirmed: true }` | `allowed: true` |

Enabling a global/destructive kind takes **two** independent steps: an explicit
scope override **and** an explicit confirmation (`--yes` / env opt-in). An override
alone is never sufficient.

`isPathAllowed(contract, target)` returns `{ allowed, reason }`. A forbidden path
(`forbidden_path:<pattern>`) always loses, even if it would otherwise match an
allowed glob. A path outside the project tree returns `path_not_in_scope`.

### Explicit confirmation (`CONFIRMATION_REQUIRED`)

The kinds that always require explicit confirmation are exported as
`CONFIRMATION_REQUIRED`:

- `global_codex_config`
- `package_install`
- `codex_app_process`
- `codex_lb_auth`
- `skill_snapshot_promotion`

Confirmation is delivered out-of-band by the operator via `--yes` or an environment
opt-in. SKS never self-confirms.

## 2. Forbidden mutations (the §2 directive list)

The following mutations are **forbidden** unless the operator explicitly opts in
(scope override **and** confirmation). They are exactly the destructive ledger kinds
and forbidden paths the contract guards:

1. Writing the **global Codex config** (`~/.codex/config.toml`) — `global_config_write`.
2. Changing **Codex App feature flags** — `codex_app_flag_change`.
3. Changing **codex-lb auth** (login/token/provider) — `codex_lb_auth_change`.
4. **Killing the Codex App process** — `process_kill` (`codex_app_process` scope).
5. **Installing packages** (npm/global) — `package_install`.
6. Touching anything under **`/Applications/**`** (installed apps).
7. **Promoting a skill snapshot** — `skill_snapshot_promotion`.
8. Any **network** mutation — `network`.

A `project_files` mutation inside the project tree is the only category that is
allowed without confirmation.

## 3. The mutation ledger (no mutation without a record)

`dist/core/safety/mutation-ledger.js` records every mutation SKS performs to the
append-only ledger at `.sneakoscope/reports/mutation-ledger.jsonl` (schema
`sks.mutation-ledger.v1`). `MUTATION_KINDS` enumerates every recordable kind,
including `file_write`, `global_config_write`, `package_install`, `process_kill`,
`codex_app_flag_change`, `codex_lb_auth_change`, and
`skill_snapshot_promotion`.

`evaluateMutation(contract, kind, { target, confirmed?, backupPath?, noOpReason?, applied })`
returns the ledger entry plus a `violation` flag. Each entry records
`requested_scope_allowed` and the `backup_path` / `no_op_reason`. A mutation is a
**violation** when either:

- it was **applied out of scope** (`applied: true` while the contract denied it), or
- it is a config/auth/skill mutation (`global_config_write`, `codex_app_flag_change`,
  `codex_lb_auth_change`, `skill_snapshot_promotion`) that was **applied without a
  backup path or a no-op reason**.

So even a fully-confirmed, in-scope global config write is a violation if it lands
without a recoverable backup. The rule is: **every applied mutation is recorded with
`requested_scope_allowed` plus a backup or a no-op reason; an applied-out-of-scope
mutation is always a violation.**

`recordMutation(root, entry)` appends the entry and returns the ledger path
(`mutationLedgerPath(root)`). There is no code path that mutates without first
producing a ledger entry.

`side-effect:runtime-report` reads the project and mission mutation ledgers and
writes `.sneakoscope/reports/side-effect-runtime-report.json`. Release readiness
requires:

- `unexpected_applied_mutations = 0`
- `global_mutations_without_confirmation = 0`
- `config_mutations_without_backup_or_noop = 0`

## 4. The skill optimizer cannot bypass the contract

Skill cards are read-only external state (`side_effect_scope.read_only === true`,
no `allowed_mutations`). The optimizer can only ever **propose** a candidate card;
promoting it to a deployed snapshot is the `skill_snapshot_promotion` mutation kind,
which is in `CONFIRMATION_REQUIRED` and is denied by default. The optimizer therefore
cannot self-promote, cannot widen its own scope, and cannot perform any of the §2
forbidden mutations — every such action routes through `isMutationAllowed` and the
ledger, exactly like any other mutation. The contract is the single chokepoint.
