#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist } from './gate-lib.js';

const router = await importDist('core/router/ultra-router.js');
const cache = await importDist('core/router/route-cache.js');
cache.clearRouteCache();
const simpleWorker = router.routeCodexTask(baseTask({ tier: 'worker', slotId: 'slot-001', workItemId: 'slice-1' }));
const cachedWorker = router.routeCodexTask(baseTask({ tier: 'worker', slotId: 'slot-001', workItemId: 'slice-1' }));
const imageWorker = router.routeCodexTask(baseTask({ tier: 'worker', slotId: 'slot-002', workItemId: 'slice-2', inputImages: ['screen.png'] }));
const orchestrator = router.routeCodexTask(baseTask({ tier: 'orchestrator', prompt: 'conflict resolution final synthesis' }));
assertGate(simpleWorker.selected_profile === 'fast-worker', 'simple worker should choose cheapest good-enough profile', simpleWorker);
assertGate(cachedWorker.cache_hit === true, 'second identical routing decision must hit cache', cachedWorker);
assertGate(imageWorker.selected_profile === 'vision-worker', 'image worker must hard-filter non-vision candidates', imageWorker);
assertGate(orchestrator.tier === 'orchestrator' && orchestrator.selected_profile.includes('orchestrator'), 'orchestrator task must stay orchestrator tier', orchestrator);
assertGate(orchestrator.reason.includes('score>=threshold') || orchestrator.reason.includes('deterministic-default'), 'router must emit deterministic reason', orchestrator);
emitGate('ultra-router:auto-router', { worker: simpleWorker.selected_profile, image_worker: imageWorker.selected_profile, cache_hit: cachedWorker.cache_hit, orchestrator: orchestrator.selected_profile });

function baseTask(extra = {}) {
  return {
    route: '$Naruto',
    missionId: 'M-ultra-router-auto',
    cwd: process.cwd(),
    prompt: 'fixture',
    inputFiles: [],
    inputImages: [],
    outputSchemaId: 'sks.agent-worker-result.v1',
    outputSchema: {},
    sandboxPolicy: 'read-only',
    requestedScopeContract: { read_only: true },
    mutationLedgerRoot: process.cwd(),
    ...extra
  };
}
