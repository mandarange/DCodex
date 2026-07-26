#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertGate, emitGate, makeTempRoot, writeText } from './skill-fixture-check-lib.js';
import { withSecretPreservationGuard } from '../core/config/config-migration-journal.js';

const root = await makeTempRoot('sks-update-supabase-');
const envFile = path.join(root, '.env.local');
await writeText(envFile, 'NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=update-secret\n');
await withSecretPreservationGuard(root, 'update-fixture', async () => {
  await fs.appendFile(envFile, 'SKS_UPDATE_MARKER=1\n', 'utf8');
});
const text = await fs.readFile(envFile, 'utf8');
assertGate(text.includes('update-secret'), 'update fixture must preserve Supabase key value in source file');
let blocked = false;
try {
  await withSecretPreservationGuard(root, 'update-fixture-mutates-secret', async () => {
    await fs.writeFile(envFile, 'NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=mutated-update-secret\n', 'utf8');
  });
} catch {
  blocked = true;
}
const restored = await fs.readFile(envFile, 'utf8');
assertGate(blocked, 'update guard must block Supabase key value mutation');
assertGate(restored.includes('update-secret') && !restored.includes('mutated-update-secret'), 'update guard must restore Supabase key value after mutation');
emitGate('update:preserves-supabase-keys');
