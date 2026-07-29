# Skill Integrity

SKS core skills are treated as product contracts, not editable setup output.

SKS keeps the built-in route skills content-addressed and immutable. The core skill template version is a content schema version (`sks-core-skill-template.v2`), not the package release version, so ordinary release bumps do not create false drift. Version 2 uses focused frontmatter descriptions plus progressive-disclosure sections for outcome, activation, workflow, runtime contract, safety, evidence, and failure recovery.

- `sks-loop`
- `sks-naruto`
- `sks-qa-loop`
- `sks-research`
- `sks-dfix`
- `sks-image-ux-review`
- `sks-computer-use`
- `sks-init-deep`
- `sks-search-visibility-core`
- `sks-seo-geo-optimizer`
- `sks-align`

Every generated skill may also include `agents/openai.yaml`. SKS emits a minimal profile from the current Codex schema:

- Frontmatter discovery descriptions are deterministically bounded to 64 characters; the release gate accounts for skill name, description, and relative `SKILL.md` path against the 8,000-character initial-list budget, leaving headroom for host formatting and absolute path prefixes.
- `interface.display_name` and `interface.short_description` are required.
- `interface.default_prompt` names the installed skill exactly as `Use $<skill-name>.`.
- `policy.allow_implicit_invocation` is `false` only for the explicit-only high-impact set and `true` for other generated SKS skills.
- Current optional interface icons, brand color, and `dependencies.tools` remain valid, but SKS emits them only when it has a real asset or tool dependency to declare.
- Unsupported historical top-level routing and reasoning keys are not emitted.

Setup, update, and doctor flows may install a missing managed copy or restore a corrupted managed copy from the manifest. They must not overwrite user-authored skill collisions.

Project skill names are canonicalized before duplicate detection. Variants such as a dollar-prefixed Loop skill, `Loop`, `loop.md`, and `loop/SKILL.md` all map to `loop`. SKS-managed duplicates can be quarantined under `.sneakoscope/quarantine/skills/<canonical>/<timestamp>/`; user-authored duplicates are reported unless the operator explicitly opts into user duplicate quarantine.

The registry ledger records `active_unique_by_canonical_name`, `active_entries`, and `duplicate_active_canonical_names` so doctor/setup/update can prove whether the Codex picker has more than one active skill for the same canonical name.

Relevant gates:

```bash
npm run core-skill:manifest
npm run core-skill:immutable-sync
npm run core-skill:no-drift
npm run skill:registry-ledger
npm run skill:sync-atomic
npm run skill:dedupe-blackbox
```
