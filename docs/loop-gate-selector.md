# Loop Gate Selector

The loop gate selector replaces monolithic gate execution with affected local gates where safe. `L0-report` loops only validate state and budget. Docs-only loops run docs and changelog checks. Release, research, QA loop, Codex control, MAD-SKS, scheduler, and worker runtime scopes receive their matching affected gates.

Gate choice is recorded on each Loop Graph node so the final proof can distinguish loop-local gates from integration gates.

Package script or `release-gates.v2.json` changes escalate to the integration loop and require `release:dag-full-coverage`. High risk adds an integration gate. Critical risk requires human handoff unless an explicit break-glass contract exists.

Domain loops do not run full `release:check`; the integration loop owns final release gates and GPT final arbiter policy.
