# Menu Bar / Center ↔ CLI SSOT (NC-29 / T4)

CLI is the functional SSOT. Menu Bar and SKS Center are UX surfaces that expose
a safe subset of status, update, provider, MCP, and doctor-induce actions.

## Contract

1. Native UI must call the `sks` CLI (via `ProcessClient` / action scripts) for
   functional operations rather than inventing parallel mission/evidence writers.
2. Menu Bar / Center are not the truth source for mission or evidence state.
3. Codex host upgrades are induce/check/fail only; SKS does not auto-upgrade the
   host as a product path (NC-46).
4. Reasonable accessibility is a product requirement (NC-43): headings and
   primary controls use accessibility labels/identifiers (see
   `NativeView.title` / related helpers in `native/sks-menubar`).

## Related

- Product contract: [PRODUCT-CONTRACT.md](PRODUCT-CONTRACT.md)
- Ambiguity ledger: [AMBIGUITY-RESOLUTIONS.md](AMBIGUITY-RESOLUTIONS.md)
