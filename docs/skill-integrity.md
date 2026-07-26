# Skill Integrity

SKS core skills are treated as product contracts, not editable setup output.

SKS keeps the built-in route skills content-addressed and immutable. The core skill template version is a content schema version (`sks-core-skill-template.v1`), not the package release version, so ordinary release bumps do not create false drift.

- `loop`
- `naruto`
- `qa-loop`
- `research`
- `dfix`
- `image-ux-review`
- `computer-use`
- `init-deep`

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
