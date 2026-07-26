// @ts-nocheck
import { assertGate, emitGate, importDist, readText } from './gate-lib.js';

const src = readText('src/core/build/build-once-runner.ts');
assertGate(src.includes('.sks-build-proof.json') && src.includes('build:incremental'), 'build-once runner must write dist proof and use incremental build', src.slice(0, 500));
const mod = await importDist('core/build/build-once-runner.js');
assertGate(mod.BUILD_ONCE_PROOF_SCHEMA === 'sks.build-once-proof.v1', 'build-once proof schema missing');
emitGate('build-once:runner');
