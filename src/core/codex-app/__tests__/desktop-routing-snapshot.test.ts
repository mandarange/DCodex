import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  captureDesktopRoutingSnapshot,
  remapThreadCatalogProvider,
  restoreDesktopRoutingSnapshot,
  writeDesktopRoutingSnapshot
} from '../desktop-routing-snapshot.js'

test('remapThreadCatalogProvider retags sidebar rows and restore flips them back with routing snapshot', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-desktop-routing-'))
  const codexHome = path.join(home, '.codex')
  const sqliteDir = path.join(codexHome, 'sqlite')
  await fs.mkdir(sqliteDir, { recursive: true })
  const dbPath = path.join(sqliteDir, 'codex-dev.db')
  execFileSync('sqlite3', [
    dbPath,
    `CREATE TABLE local_thread_catalog (
      host_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      display_title TEXT NOT NULL,
      source_created_at REAL NOT NULL,
      source_updated_at REAL NOT NULL,
      cwd TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_detail TEXT,
      model_provider TEXT NOT NULL,
      git_branch TEXT,
      observation_sequence INTEGER NOT NULL,
      missing_candidate INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (host_id, thread_id)
    );
    INSERT INTO local_thread_catalog (
      host_id, thread_id, display_title, source_created_at, source_updated_at,
      cwd, source_kind, model_provider, observation_sequence, missing_candidate
    ) VALUES ('local', 'thread-1', 'hello', 1, 1, '/tmp', 'app', 'codex-lb', 1, 0);`
  ])

  const remapped = remapThreadCatalogProvider({
    home,
    fromProvider: 'codex-lb',
    toProvider: 'openrouter'
  })
  assert.equal(remapped.ok, true)
  assert.equal(remapped.remapped, 1)
  assert.deepEqual(remapped.thread_ids, ['thread-1'])

  const provider = execFileSync('sqlite3', ['-batch', '-noheader', dbPath, "SELECT model_provider FROM local_thread_catalog WHERE thread_id = 'thread-1';"], { encoding: 'utf8' }).trim()
  assert.equal(provider, 'openrouter')

  const configPath = path.join(codexHome, 'config.toml')
  await fs.writeFile(configPath, [
    'model_provider = "openrouter"',
    'model = "moonshotai/kimi-k3"',
    'model_catalog_json = "/tmp/or.json"',
    ''
  ].join('\n'))
  const snapshot = captureDesktopRoutingSnapshot(
    [
      'model_provider = "codex-lb"',
      'model = "gpt-5.6-sol"',
      `model_catalog_json = "${path.join(codexHome, 'sks-codex-lb-tool-catalog.json')}"`,
      ''
    ].join('\n'),
    {
      reason: 'test',
      threadSidebar: {
        remapped: true,
        from_provider: 'codex-lb',
        to_provider: 'openrouter',
        thread_ids: ['thread-1'],
        catalog_db: dbPath
      }
    }
  )
  const written = await writeDesktopRoutingSnapshot(snapshot, { home })
  assert.equal(written.ok, true)

  const restored = await restoreDesktopRoutingSnapshot({
    home,
    configPath,
    restartApp: false,
    restartImpl: async () => ({ ok: true, blockers: [] })
  })
  assert.equal(restored.ok, true)
  const config = await fs.readFile(configPath, 'utf8')
  assert.match(config, /model_provider = "codex-lb"/)
  assert.match(config, /model = "gpt-5\.6-sol"/)

  const restoredProvider = execFileSync('sqlite3', ['-batch', '-noheader', dbPath, "SELECT model_provider FROM local_thread_catalog WHERE thread_id = 'thread-1';"], { encoding: 'utf8' }).trim()
  assert.equal(restoredProvider, 'codex-lb')
})
