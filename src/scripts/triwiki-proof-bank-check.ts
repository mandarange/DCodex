// @ts-nocheck
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const bank = await importDist('core/triwiki/triwiki-proof-bank.js');
const status = bank.summarizeTriWikiProofBank(root);
assertGate(status.schema === 'sks.triwiki-proof-bank.v1' && status.ok === true, 'proof bank status must pass', status);
emitGate('triwiki:proof-bank', status);
