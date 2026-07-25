#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist, root } from './gate-lib.js'
import { writeJsonAtomic } from '../core/fsx.js'

const { runSuperSearch } = await importDist('core/super-search/index.js')
const missionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-super-search-offline-'))
const result = await runSuperSearch({
  missionDir,
  query: 'offline npm release notes contract',
  offline: true,
  env: {}
})

const gatePath = path.join(result.artifact_dir, 'super-search-gate.json')
const gate = JSON.parse(await fs.readFile(gatePath, 'utf8'))
const supportedClaims = result.claims.filter((claim) => claim.status === 'supported' || claim.status === 'verified')
const sourceIds = new Set(result.sources.map((source) => source.source_id))
const sourceLessSupportedClaims = supportedClaims.filter((claim) => !claim.source_ids?.length || claim.source_ids.some((id) => !sourceIds.has(id)))

assertGate(result.mode === 'offline_cache', 'offline contract must use offline_cache mode', { mode: result.mode })
assertGate(result.provider_plan.selected_providers.includes('offline_cache'), 'offline contract must select offline cache provider', result.provider_plan)
assertGate(result.ok === false, 'offline contract without cache must fail closed', { ok: result.ok, blockers: result.blockers })
assertGate(result.blockers.includes('source_acquisition_unavailable'), 'offline contract must report source acquisition blocker without cache', result.blockers)
assertGate(sourceLessSupportedClaims.length === 0, 'offline contract must not produce source-less supported claims', { sourceLessSupportedClaims, claims: result.claims })
assertGate(typeof gate.human_summary === 'string' && gate.human_summary.length > 0, 'blocked gate must include human_summary', gate)
assertGate(Array.isArray(gate.next_actions) && gate.next_actions.length > 0, 'blocked gate must include next_actions', gate)
assertGate(Array.isArray(gate.evidence_paths) && gate.evidence_paths.length > 0, 'blocked gate must include evidence_paths', gate)

await writeJsonAtomic(path.join(root, '.sneakoscope', 'reports', 'super-search-offline-contract.json'), {
  schema: 'sks.super-search-offline-contract.v1',
  ok: true,
  generated_at: new Date().toISOString(),
  mode: result.mode,
  blockers: [],
  expected_blockers: result.blockers,
  source_less_supported_claims: sourceLessSupportedClaims,
  evidence_paths: [gatePath]
})

emitGate('super-search:offline-contract', {
  mode: result.mode,
  runtime_ok: result.ok,
  blockers: result.blockers,
  gate: gatePath
})
