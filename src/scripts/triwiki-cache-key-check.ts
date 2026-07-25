// @ts-nocheck
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const mod = await importDist('core/triwiki/triwiki-cache-key.js');
const a = mod.computeTriWikiCacheKey({ root, id: 'triwiki:cache-key', inputs: ['package.json'], implementationFiles: ['src/core/triwiki/triwiki-cache-key.ts'], envAllowlist: ['CI'], fixtureVersion: 'sks-4.0.0' });
const b = mod.computeTriWikiCacheKey({ root, id: 'triwiki:cache-key', inputs: ['package.json'], implementationFiles: ['src/core/triwiki/triwiki-cache-key.ts'], envAllowlist: ['CI'], fixtureVersion: 'sks-4.0.0' });
assertGate(a.schema === 'sks.triwiki-cache-key.v1', 'cache key schema mismatch', a);
assertGate(a.key === b.key && a.file_count >= 1 && a.input_hash && a.implementation_hash && a.package_lock_hash, 'cache key must be deterministic and complete', { a, b });
emitGate('triwiki:cache-key', { key: a.key, files: a.file_count });
