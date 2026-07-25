# Stop Gate Contract

Sneakoscope treats `sks.stop-gate.v1` as the canonical stop source of truth for Naruto-family routes.

For `Naruto`, `$sks-naruto`, `NARUTO`, and `GLM_NARUTO`, a stop check may return `allow_stop` only when all of these are true:

- `passed === true`
- `terminal === true`
- `status === "passed"`
- `blockers.length === 0`
- `missing_fields.length === 0`

After `checkStopGate(...).action === "allow_stop"` for a Naruto-family route, runtime stop evaluation returns continue immediately and does not fall through to hidden completion-proof or reflection gates. If proof or reflection is required, that evidence must be encoded into the canonical stop-gate evidence before `status: "passed"` is written.

Route-native gates such as `naruto-gate.json` and GLM Naruto `termination.json` remain compatibility artifacts. `writeFinalStopGate()` writes canonical `stop-gate.json` separately and preserves existing native fields by default.
