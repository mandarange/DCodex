// @ts-nocheck
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertGate, emitGate, makeTempRoot } from './skill-fixture-check-lib.js';
import { importDist } from './gate-lib.js';

const tmp = await makeTempRoot('sks-triwiki-proof-bank-');
await fs.writeFile(path.join(tmp, 'package.json'), JSON.stringify({ version: '4.0.0' }));
await fs.writeFile(path.join(tmp, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
const cardMod = await importDist('core/triwiki/triwiki-proof-card.js');
const bank = await importDist('core/triwiki/triwiki-proof-bank.js');
const card = cardMod.createTriWikiProofCard({
  subject_type: 'gate',
  subject_id: 'fixture:gate',
  cache_key: 'fixture-cache',
  input_hash: 'input',
  implementation_hash: 'impl',
  tool_version: '4.0.0',
  fixture_version: 'sks-4.0.0',
  result: 'passed',
  reusable: true,
  evidence: { blackbox: true }
});
bank.writeTriWikiProofCard(tmp, card);
const hit = bank.readReusableTriWikiProofCard({ root: tmp, subjectId: 'fixture:gate', cacheKey: 'fixture-cache' });
assertGate(hit.hit === true && hit.card?.proof_id === card.proof_id, 'proof bank must reuse matching passed card', hit);
bank.markTriWikiProofInvalidated(tmp, 'fixture:gate', card.proof_id, 'fixture_invalidated');
const miss = bank.readReusableTriWikiProofCard({ root: tmp, subjectId: 'fixture:gate', cacheKey: 'fixture-cache' });
assertGate(miss.hit === false, 'invalidated proof card must not be reused', miss);
emitGate('triwiki:proof-bank-blackbox', { hit: true, invalidation_blocked_reuse: true });
