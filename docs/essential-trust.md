# Essential Trust — the SKS 10 verification architecture

## Why

SKS was built when models lied often enough that every completion had to be
policed: an "Honest Mode" section matched by regex before a turn could end, a
completion-proof artifact per route, a reflection gate, a root-cause analysis
triggered by the substring `missing`, evidence ledgers written after every tool
call, skill files whose one-byte drift denied every subsequent tool call until a
human ran `sks doctor --fix`. Two cold Node processes ran on every tool call
(~1 s of pure harness time per call; a 40-call turn paid 19–34 s), and `sks
doctor --full` could never report `ready: true` on a real machine because the
image route's proof was a hardcoded `false` — which kept SKS Center's health
badge permanently orange.

Models no longer need that policing, and the rituals became the product's
largest cost. SKS 10 replaces "prove you are not lying" with "protect the
user's machine and data, and get out of the way".

## The two profiles

| Profile | Default | Meaning |
| --- | --- | --- |
| `essential` | **yes** | Safety gates only. Finished turns finish. Diagnostics report what they measured. |
| `strict` | opt-in | The pre-10 behavior, unchanged, for anyone who still wants the proof rituals. |

Selection, highest precedence first:

1. `SKS_VERIFICATION_PROFILE=essential|strict` in the environment.
2. `<project>/.sneakoscope/verification-profile.json` — `{ "profile": "strict" }`.
3. `<global root>/verification-profile.json` (the global root is `~/.sneakoscope-global`, or `SKS_GLOBAL_ROOT`).
4. Inside the SKS test harness (`NODE_TEST_CONTEXT` / `SKS_TEST_ISOLATION=1`): `strict`, so the existing suite keeps proving the legacy behavior; essential-profile tests ask for `essential` explicitly, and the built-CLI gates run outside the harness.
5. Otherwise `essential`.

The resolver lives in `src/core/verification-profile.ts`; every enforcement
point asks it a specific question (`stopFinalizationRitualsEnforced`,
`managedSkillDigestBlocksEnforced`, `postToolEvidenceEnabled`,
`manualProofRoutesBlockReadiness`, `hookDaemonEnabled`) rather than reading
the profile name, so a future profile can answer each question independently.

## What stays in both profiles — safety

These protect the user's machine, data, and credentials. None of them depends
on trusting the model's prose.

- **DB safety gate** — read-only by default; destructive statements always
  refused; writes only through an active MAD-SKS SQL-plane capability; the
  catastrophic set (`drop database/schema/table`, `truncate`, `delete` without
  `where`, `reset`) cannot be unblocked.
- **Secret handling** — plaintext secrets never enter proofs, logs, or
  evidence; redaction in every writer; the Desktop Bridge never forwards the
  ChatGPT identity to a provider or a provider key to the client.
- **Harness-maintenance guard** — an agent cannot run `sks doctor --fix`,
  `sks setup/init`, or uninstall SKS to escape supervision.
- **Fan-out bounds** — recursion guard, `max_depth = 1`, thread caps.
- **No-question autonomy guards** — interactive commands (`sudo`, `ssh`,
  `read -p` …) refused while an autonomous loop runs.
- **Host-capability allowlists** for desktop-control tools.
- **Loop continuation** and other route mechanics that are about *finishing
  the work*, not about proving honesty.

## What the essential profile drops

| Ritual | Before | Now |
| --- | --- | --- |
| Stop hook Honest Mode / completion-summary wording gate | `decision: block` until the final message contained the right phrases | a finished turn is finished (`essential_profile_stop_accepted`) |
| Honest-gap loopback (two forced retries over a gap regex) | blocked | gone |
| Route completion proof, reflection gate, work-order ledger, root-cause analysis, engineering-sanity / DB-access / architecture-map review artifacts as Stop blockers | blocked | not evaluated at Stop; `sks proof …` commands still work when a user asks |
| PostToolUse evidence hook | one cold process per tool call writing Context7 / subagent / error-taxonomy ledgers | not installed; `sks update` and `sks doctor --fix` remove the stale entry from `.codex/hooks.json` and the managed TOML while keeping user-authored hooks |
| Managed-skill digest drift blocks prompts and tool calls | `content_digest_mismatch` denied everything until `sks doctor --fix` | repaired or advised; never a denial |
| Interrupted-tool-output quarantine | the next prompt was refused until the thread was replaced | the model receives the recovery advice; the user keeps steering |
| `route-image` manual real-output proof as a doctor blocker | `doctor --full` `ok: false` on every real machine; Center badge orange | a warning (`route:route-image:…`), `ready: true` when the machine is actually healthy |
| "then run Honest Mode" in the managed `AGENTS.md`; `$Honest-Mode` skill described as required | ritual text in every session | plain guidance: state the result, what was verified, what remains — once |

## Hooks: warm daemon by default

The hook decision cost was never the checks — it was loading the runtime
(~660 ms of module graph per cold process). `sks hook <event>` now goes through
the per-project `sksd` daemon (`src/core/daemon/`), which evaluates the exact
same `evaluateHookPayloadOnce` in a warm process: ~150 ms per hook instead of
~600 ms, identical decisions, spawn-on-miss, 30-minute idle exit,
`SKS_HOOK_DAEMON=0` to opt out. Because a daemon outlives `sks update`, every
request carries the caller's package version and a mismatch retires the daemon
(`sksd_version_mismatch`) so the next call spawns one on the new code — the
same stale-long-lived-process lesson the Desktop Bridge taught in 9.2.x.

Per tool call in the essential profile: one PreToolUse hook (~150 ms warm)
instead of PreToolUse + PostToolUse cold (~1 s).

## Doctor: measured health, not proof of everything

`ready` means: Codex CLI present and its config readable, managed hooks and
skills current, the Desktop Bridge serving with a reachable upstream (its own
log is read for `bridge_upstream_unavailable` evidence), Menu Bar installed
when a fix attempted it. Capabilities the user has never exercised (image
generation real output, Computer Use OS permissions, the Chrome extension) are
reported as information. The readiness matrix also now reads the bridge
inspection correctly (it previously read the wrapper object and the branch was
dead), so a genuinely blocked bridge fails `core_ready` as it always should
have.

## Release pipeline (maintainer) — unchanged in 10.0.0, simplified next

Publish correctness is still guarded by the load-bearing gates: version truth,
dist freshness, pack receipt, the release-check stamp bound to the commit, the
prepublish preflight (`main`, clean tree, `HEAD == origin/main`), and the
canonical release tests. The ceremony around them — push-guard/receipt rituals,
physical evidence receipts, prose-substring assertions on the release docs — is
slated for the next minor as a `publish` preset; it was left untouched here so
this release ships through a pipeline that has already proven itself.

## Migrating

Nothing to do. `sks update` converges the managed hooks and `AGENTS.md`
block. To keep the legacy behavior: `sks` reads
`~/.sneakoscope-global/verification-profile.json` — write
`{ "profile": "strict" }` there (or set `SKS_VERIFICATION_PROFILE=strict`).
