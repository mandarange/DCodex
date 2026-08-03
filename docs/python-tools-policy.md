# Python Tools Policy

Python tools are optional accelerators and diagnostics for SKS.

Allowed uses:

- log analysis
- large JSONL summarization
- performance report aggregation
- optional platform diagnostics

Forbidden uses:

- mandatory core runtime dependency
- postinstall package installation
- publish-time network calls
- Codex config, auth, or global state writes

Core SKS must work without Python. When Python is present, tools under `pytools/` may be used for side-effect-zero analysis.
