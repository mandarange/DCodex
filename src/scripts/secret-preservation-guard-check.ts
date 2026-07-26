#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertGate, emitGate, makeTempRoot, writeText } from './skill-fixture-check-lib.js';
import { withSecretPreservationGuard } from '../core/config/config-migration-journal.js';

const root = await makeTempRoot('sks-secret-guard-');
const envFile = path.join(root, '.env.local');
await writeText(envFile, 'NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=guard-secret\n');
await withSecretPreservationGuard(root, 'fixture-preserve', async () => {
  await fs.appendFile(envFile, 'SKS_MANAGED=1\n', 'utf8');
});
let deleteBlocked = false;
try {
  await withSecretPreservationGuard(root, 'fixture-delete', async () => {
    await fs.writeFile(envFile, 'SKS_MANAGED=1\n', 'utf8');
  });
} catch {
  deleteBlocked = true;
}
const restoredAfterDelete = await fs.readFile(envFile, 'utf8');
assertGate(deleteBlocked, 'secret preservation guard must block missing protected keys after mutation');
assertGate(restoredAfterDelete.includes('guard-secret'), 'secret preservation guard must roll back deleted protected keys');

let changeBlocked = false;
try {
  await withSecretPreservationGuard(root, 'fixture-change', async () => {
    await fs.writeFile(envFile, 'NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=changed-secret\n', 'utf8');
  });
} catch {
  changeBlocked = true;
}
const restoredAfterChange = await fs.readFile(envFile, 'utf8');
assertGate(changeBlocked, 'secret preservation guard must block changed protected key values');
assertGate(restoredAfterChange.includes('guard-secret') && !restoredAfterChange.includes('changed-secret'), 'secret preservation guard must roll back changed protected values');
emitGate('secret:preservation-guard');
