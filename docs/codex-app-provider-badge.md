# Codex App Provider Badge

SKS exposes provider context through supported surfaces without patching Codex App private storage or DOM.

Badge text examples:

- `Provider: OpenAI · Fast`
- `Provider: codex-lb · Fast`
- `Provider: Codex App OAuth · Fast`
- `Provider: Unknown · Check doctor`

If an official Codex App badge surface is unavailable, SKS reports `Codex App native badge unsupported` and uses fallback surfaces:

- `sks status`
- `doctor --json`
- command hints

Provider context is redacted and records only which auth path is present, not credential values.
