import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyArchitectureMigration, inspectArchitectureMigration, rollbackArchitectureMigration } from '../migration.js';

const legacy = `model_provider = "openrouter"\n[model_providers.openrouter]\nbase_url = "https://openrouter.ai/api/v1"\nenv_key = "OPENROUTER_API_KEY"\n`;

test('current config is a no-op while ambiguous legacy state requires migration input', () => {
  assert.equal(inspectArchitectureMigration({ configText: '# sks-managed-provider-mode:chatgpt-oauth\nmodel_provider = "openai"\n', sessionMetadataPresent: true }).status, 'no_op');
  assert.equal(inspectArchitectureMigration({ configText: `${legacy}\n[model_providers.other]\nbase_url="https://example.invalid"\n`, sessionMetadataPresent: false }).status, 'migration_required');
});

test('apply requires reference proof, preserves a secret-safe receipt, is conflict-safe, and rolls back', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-architecture-migration-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.toml');
  await fsp.writeFile(configPath, legacy, { mode: 0o600 });
  const plan = inspectArchitectureMigration({ configText: legacy, sessionMetadataPresent: true, command: 'sks ux-review' });
  await assert.rejects(() => applyArchitectureMigration({ configPath, plan, targetMode: 'openrouter', loopbackBaseUrl: 'http://127.0.0.1:55123/api/v1', confirmedRemovablePaths: [], explicitApply: true }), /reference_proof_required/);
  const before = new Set(await fsp.readdir(root));
  const receipt = await applyArchitectureMigration({ configPath, plan, targetMode: 'openrouter', loopbackBaseUrl: 'http://127.0.0.1:55123/api/v1', confirmedRemovablePaths: plan.removable_paths, explicitApply: true });
  assert.doesNotMatch(JSON.stringify(receipt), /OPENROUTER_API_KEY|openrouter\.ai/);
  assert.match(await fsp.readFile(configPath, 'utf8'), /model_provider = "openai"/);
  const backup = (await fsp.readdir(root)).find((entry) => !before.has(entry) && entry.includes('.sks-architecture-backup-'));
  assert.ok(backup);
  await rollbackArchitectureMigration({ configPath, backupPath: path.join(root, backup), receipt, explicitRollback: true });
  assert.equal(await fsp.readFile(configPath, 'utf8'), legacy);
});

test('apply detects user edits and leaves the config untouched', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-architecture-migration-conflict-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.toml');
  await fsp.writeFile(configPath, legacy, { mode: 0o600 });
  const plan = inspectArchitectureMigration({ configText: legacy, sessionMetadataPresent: true });
  await fsp.appendFile(configPath, '# user edit\n');
  await assert.rejects(() => applyArchitectureMigration({ configPath, plan, targetMode: 'openrouter', loopbackBaseUrl: 'http://127.0.0.1:55123/api/v1', confirmedRemovablePaths: plan.removable_paths, explicitApply: true }), /user_edit_conflict/);
});
