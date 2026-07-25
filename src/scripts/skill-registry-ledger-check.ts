#!/usr/bin/env node
import path from 'node:path';
import { assertGate, emitGate, makeTempRoot, writeManagedCoreSkill, writeUserSkill } from './skill-fixture-check-lib.js';
import { buildSkillRegistryLedger } from '../core/codex-native/skill-registry-ledger.js';

const root = await makeTempRoot('sks-skill-ledger-');
process.env.CODEX_HOME = path.join(root, 'codex-home');
await writeManagedCoreSkill(root, '.agents/skills', 'loop');
await writeUserSkill(root, '.agents/skills', 'custom-skill', 'Custom Skill');
const ledger = await buildSkillRegistryLedger({ root });
assertGate(ledger.entries.some((entry) => entry.canonical_name === 'loop' && entry.managed_by_sks), 'ledger must detect managed core skill', ledger);
assertGate(ledger.entries.some((entry) => entry.canonical_name === 'custom-skill' && !entry.managed_by_sks), 'ledger must detect user skill', ledger);
assertGate(Array.isArray(ledger.active_entries) && typeof ledger.active_unique_by_canonical_name === 'boolean' && Array.isArray(ledger.duplicate_active_canonical_names), 'ledger must expose active uniqueness proof fields', ledger);
emitGate('skill:registry-ledger', { entries: ledger.entries.length });
