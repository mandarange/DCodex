#!/usr/bin/env node
import path from 'node:path';
import { assertGate, emitGate, makeTempRoot, writeText } from './skill-fixture-check-lib.js';
import { captureSecretPreservationSnapshot } from '../core/config/secret-preservation.js';

const root = await makeTempRoot('sks-secret-snapshot-');
await writeText(path.join(root, '.env.local'), 'NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=secret-value-123\n');
const snapshot = await captureSecretPreservationSnapshot({ root });
assertGate(snapshot.fingerprints.length >= 2, 'secret snapshot must capture protected Supabase keys', snapshot);
assertGate(!JSON.stringify(snapshot).includes('secret-value-123'), 'secret snapshot must not store raw values', snapshot);
emitGate('secret:preservation', { fingerprints: snapshot.fingerprints.length });
