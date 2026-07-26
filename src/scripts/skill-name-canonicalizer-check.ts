#!/usr/bin/env node
import { assertGate, emitGate } from './skill-fixture-check-lib.js';
import { canonicalSkillName } from '../core/codex-native/skill-name-canonicalizer.js';

for (const value of ['$Loop', 'loop', 'Loop', 'LOOP', 'loop ', 'loop.md', 'loop/SKILL.md']) {
  assertGate(canonicalSkillName(value) === 'loop', 'canonical skill name example failed', { value, got: canonicalSkillName(value) });
}
assertGate(canonicalSkillName('@QA_LOOP.md') === 'qa-loop', 'canonical skill name punctuation failed');
emitGate('skill:name-canonicalizer');
