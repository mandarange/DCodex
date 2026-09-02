# Stop Gate Contract

> **10.0 (Essential Trust):** this contract applies to the `strict` verification profile. In the default `essential` profile the Stop hook accepts a finished turn (`essential_profile_stop_accepted`) after loop-continuation and no-question checks; `stop-gate.json` is still written by the Naruto CLI as an artifact but is not consulted at Stop. See [essential-trust.md](essential-trust.md).

Sneakoscope treats `sks.stop-gate.v1` as the canonical stop source of truth for Naruto-family routes.

For `Naruto`, `$sks-naruto`, `NARUTO`, and `GLM_NARUTO`, a stop check may return `allow_stop` only when all of these are true:

- `passed === true`
- `terminal === true`
- `status === "passed"`
- `blockers.length === 0`
- `missing_fields.length === 0`

After `checkStopGate(...).action === "allow_stop"` for a Naruto-family route, runtime stop evaluation returns continue immediately and does not fall through to hidden completion-proof or reflection gates. If proof or reflection is required, that evidence must be encoded into the canonical stop-gate evidence before `status: "passed"` is written.

Route-native gates such as `naruto-gate.json` and GLM Naruto `termination.json` remain compatibility artifacts. `writeFinalStopGate()` writes canonical `stop-gate.json` separately and preserves existing native fields by default.
