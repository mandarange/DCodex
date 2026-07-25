#!/usr/bin/env node
// @ts-nocheck
// GATE: core-skill:patch
// Proves a SkillPatch edits ONLY the single skill document within the textual
// learning-rate budget, and rejects budget overruns, external/code targets, and
// cross-skill (multi-doc) edits.
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root, readJson } from './gate-lib.js';

const cardMod = await importDist('core/skills/core-skill-card.js');
const patchMod = await importDist('core/skills/core-skill-patch.js');
const applyMod = await importDist('core/skills/core-skill-patch-apply.js');
const typesMod = await importDist('core/skills/core-skill-types.js');

const BODY = '## Goal\nDo the task.\n\n## Verification\nCheck output.\n\n## Rollback\nRevert on failure.\n';

// Base card at version N (createCandidateCard from baseVersion 2 -> version 3).
const baseCard = cardMod.createCandidateCard({ skillId: 'demo-skill', route: 'DFix', baseVersion: 2, body: BODY });
const N = baseCard.version;

// 1) Valid patch within budget: one small add to the verification section.
const validPatch = {
  schema: typesMod.CORE_SKILL_PATCH_SCHEMA,
  skill_id: 'demo-skill',
  base_version: N,
  operations: [{ op: 'add', target: 'section:verification', text: '- Confirm exit code is zero.' }],
  textual_learning_rate: { max_added_chars: 800, max_deleted_chars: 400, max_replaced_chars: 600 }
};
const validRes = patchMod.validatePatch(validPatch, baseCard);
assertGate(validRes.ok === true, 'valid in-budget patch must pass validatePatch', validRes);
const applied = applyMod.applyPatch(baseCard, validPatch);
assertGate(applied.ok === true, 'valid patch must apply', applied);
assertGate(applied.candidate && applied.candidate.body !== baseCard.body, 'applied patch must change the candidate body', { changed: applied.candidate?.body !== baseCard.body });
assertGate(applied.before_hash !== applied.after_hash, 'applied patch must change the body hash', { before: applied.before_hash, after: applied.after_hash });

// 2) Budget overrun: add text longer than max_added_chars.
const overPatch = {
  schema: typesMod.CORE_SKILL_PATCH_SCHEMA,
  skill_id: 'demo-skill',
  base_version: N,
  operations: [{ op: 'add', target: 'section:verification', text: 'x'.repeat(50) }],
  textual_learning_rate: { max_added_chars: 10, max_deleted_chars: 400, max_replaced_chars: 600 }
};
const overRes = patchMod.validatePatch(overPatch, baseCard);
assertGate(overRes.ok === false && overRes.blockers.includes('budget_added_chars_exceeded'), 'over-budget add must be blocked by budget_added_chars_exceeded', overRes);

// 3) Code/external target reject.
const externalPatch = {
  schema: typesMod.CORE_SKILL_PATCH_SCHEMA,
  skill_id: 'demo-skill',
  base_version: N,
  operations: [{ op: 'add', target: 'section:../../src/evil.ts', text: 'pwned' }],
  textual_learning_rate: { max_added_chars: 800, max_deleted_chars: 400, max_replaced_chars: 600 }
};
const externalRes = patchMod.validatePatch(externalPatch, baseCard);
const externalBlocked = externalRes.ok === false && externalRes.blockers.some((b) => b.startsWith('patch_target_is_external') || b.startsWith('patch_target_invalid'));
assertGate(externalBlocked, 'external/code target must be rejected', externalRes);

const filePatch = {
  schema: typesMod.CORE_SKILL_PATCH_SCHEMA,
  skill_id: 'demo-skill',
  base_version: N,
  operations: [{ op: 'add', target: 'file:src/x.ts', text: 'pwned' }],
  textual_learning_rate: { max_added_chars: 800, max_deleted_chars: 400, max_replaced_chars: 600 }
};
const fileRes = patchMod.validatePatch(filePatch, baseCard);
const fileBlocked = fileRes.ok === false && fileRes.blockers.some((b) => b.startsWith('patch_target_is_external') || b.startsWith('patch_target_invalid'));
assertGate(fileBlocked, 'file:-targeted patch must be rejected', fileRes);

// 4) Multi-doc / other-skill reject (same base_version so the only difference is skill_id).
const otherSkillPatch = {
  schema: typesMod.CORE_SKILL_PATCH_SCHEMA,
  skill_id: 'a-different-skill',
  base_version: N,
  operations: [{ op: 'add', target: 'section:verification', text: '- hi' }],
  textual_learning_rate: { max_added_chars: 800, max_deleted_chars: 400, max_replaced_chars: 600 }
};
const otherRes = patchMod.validatePatch(otherSkillPatch, baseCard);
assertGate(otherRes.ok === false && otherRes.blockers.includes('patch_targets_other_skill'), 'patch for another skill must be blocked by patch_targets_other_skill', otherRes);

// 5) Checked-in patch schema parses and const matches the runtime contract.
const patchSchema = readJson('schemas/skills/core-skill-patch.schema.json');
assertGate(patchSchema.properties?.schema?.const === typesMod.CORE_SKILL_PATCH_SCHEMA, 'patch schema const must match CORE_SKILL_PATCH_SCHEMA', { const: patchSchema.properties?.schema?.const, expected: typesMod.CORE_SKILL_PATCH_SCHEMA });

fs.mkdirSync(path.join(root, '.sneakoscope', 'reports'), { recursive: true });
fs.writeFileSync(
  path.join(root, '.sneakoscope', 'reports', 'core-skill-patch-check.json'),
  `${JSON.stringify({ gate: 'core-skill:patch', valid_added_chars: validRes.added_chars, schema_const: patchSchema.properties?.schema?.const }, null, 2)}\n`
);

emitGate('core-skill:patch', { valid_patch_applies: applied.ok, budget_enforced: true, external_target_rejected: externalBlocked && fileBlocked, other_skill_rejected: true });
