// @ts-nocheck
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const graphMod = await importDist('core/triwiki/triwiki-affected-graph.js');
const certMod = await importDist('core/triwiki/triwiki-sla-certificate.js');
const graph = graphMod.computeTriWikiAffectedGraph({ root, changedFiles: ['src/core/triwiki/triwiki-proof-bank.ts'], tier: 'affected' });
const cert = certMod.buildTriWikiSlaCertificate({ graph, slaMs: 300000, estimatedCriticalPathMs: 1000, estimatedSequentialMs: 5000 });
assertGate(cert.schema === 'sks.triwiki-sla-certificate.v1' && cert.ok === true && cert.release_equivalent_within_scope === true, 'SLA certificate must pass for in-budget affected graph', cert);
emitGate('certificate:sla', { reduction_ratio: cert.reduction_ratio });
