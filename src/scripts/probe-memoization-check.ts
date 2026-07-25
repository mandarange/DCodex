// @ts-nocheck
import { assertGate, emitGate, makeTempRoot } from './skill-fixture-check-lib.js';
import { importDist } from './gate-lib.js';

const tmp = await makeTempRoot('probe-memo-');
const mod = await importDist('core/probes/probe-memoization.js');
let calls = 0;
const first = mod.memoizeProbe({ root: tmp, probeId: 'fixture', ttlMs: 60000, version: 'v1', run: () => ({ calls: ++calls }) });
const second = mod.memoizeProbe({ root: tmp, probeId: 'fixture', ttlMs: 60000, version: 'v1', run: () => ({ calls: ++calls }) });
assertGate(first.reused === false && second.reused === true && second.value.calls === 1, 'probe memoization must reuse TTL record', { first, second, calls });
emitGate('probes:memoization', { reused: second.reused });
