#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertGate, emitGate, makeTempRoot, writeText } from './skill-fixture-check-lib.js';
import { captureSecretPreservationSnapshot, withSecretPreservationGuard } from '../core/config/secret-preservation.js';

const root = await makeTempRoot('sks-supabase-blackbox-');
const envFile = path.join(root, '.env.local');
await writeText(envFile, 'NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=super-secret-anon\n');
const before = await captureSecretPreservationSnapshot({ root });
await withSecretPreservationGuard(root, 'blackbox-preserve', async () => {
  await fs.appendFile(envFile, 'SKS_MANAGED=true\n', 'utf8');
});
const after = await captureSecretPreservationSnapshot({ root });
assertGate(JSON.stringify(before.fingerprints.map((fp) => fp.value_sha256).sort()) === JSON.stringify(after.fingerprints.map((fp) => fp.value_sha256).sort()), 'Supabase secret fingerprints must remain stable across guarded update', { before, after });
assertGate(!JSON.stringify(after).includes('super-secret-anon'), 'reports must not include raw Supabase values', after);
let blocked = false;
try {
  await withSecretPreservationGuard(root, 'blackbox-change', async () => {
    await fs.writeFile(envFile, 'NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=mutated-secret\n', 'utf8');
  });
} catch {
  blocked = true;
}
const restored = await fs.readFile(envFile, 'utf8');
assertGate(blocked, 'Supabase value mutation must be blocked after rollback');
assertGate(restored.includes('super-secret-anon') && !restored.includes('mutated-secret'), 'Supabase value mutation must be rolled back');
emitGate('secret:supabase-preservation-blackbox');
