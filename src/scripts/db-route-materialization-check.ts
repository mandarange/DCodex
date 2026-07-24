#!/usr/bin/env node
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { prepareRoute } from '../core/pipeline-internals/runtime-core.js'

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-db-route-materialization-'))
const previousProjectRef = process.env.SKS_MAD_SKS_SQL_PLANE_PROJECT_REF
try {
  await fsp.writeFile(path.join(root, 'package.json'), `${JSON.stringify({ name: 'sks-db-route-fixture', private: true }, null, 2)}\n`)
  const prepared: any = await prepareRoute(root, '$DB inspect the local migration safely', {})
  const missionId = String(prepared?.mission_id || '')
  if (!missionId || prepared?.route?.id !== 'DB') throw new Error('DB route did not materialize a mission')

  const dir = path.join(root, '.sneakoscope', 'missions', missionId)
  const scan = JSON.parse(await fsp.readFile(path.join(dir, 'db-safety-scan.json'), 'utf8'))
  const review = JSON.parse(await fsp.readFile(path.join(dir, 'db-review.json'), 'utf8'))
  const accessCandidates = JSON.parse(await fsp.readFile(path.join(dir, 'db-access-candidates.json'), 'utf8'))
  const accessReview = JSON.parse(await fsp.readFile(path.join(dir, 'db-access-review.json'), 'utf8'))
  const codeStructure = JSON.parse(await fsp.readFile(path.join(dir, 'code-structure-report.json'), 'utf8'))
  const sanityReview = JSON.parse(await fsp.readFile(path.join(dir, 'engineering-sanity-review.json'), 'utf8'))
  if (typeof scan?.ok !== 'boolean') throw new Error('db-safety-scan.json is missing an ok decision')
  if (typeof review?.scan_ok !== 'boolean' || review?.destructive_operation_zero !== true) {
    throw new Error('db-review.json is missing the fail-closed safety baseline')
  }
  if (accessCandidates?.schema !== 'sks.db-access-candidates.v1' || typeof accessCandidates?.candidate_count !== 'number') {
    throw new Error('db-access-candidates.json is missing the candidate-scan contract')
  }
  if (accessReview?.schema !== 'sks.db-access-review.v1' || accessReview?.source_snapshot_sha256 !== accessCandidates?.source_snapshot_sha256) {
    throw new Error('db-access-review.json is not bound to the DB candidate scan')
  }
  if (codeStructure?.schema_version !== 1 || !Array.isArray(codeStructure?.changed_scope?.source_files)) {
    throw new Error('code-structure-report.json is missing the changed-source scope')
  }
  if (sanityReview?.schema !== 'sks.engineering-sanity-review.v1' || sanityReview?.code_structure_report !== 'code-structure-report.json') {
    throw new Error('engineering-sanity-review.json is missing its source report binding')
  }

  process.env.SKS_MAD_SKS_SQL_PLANE_PROJECT_REF = 'sks-db-route-fixture'
  const madPrepared: any = await prepareRoute(root, '$DB apply the migration $MAD-SKS', {}, { sessionKey: 'db-route-materialization-mad-sks' })
  const madMissionId = String(madPrepared?.mission_id || '')
  if (!madMissionId || madPrepared?.route?.id !== 'MadSKS') throw new Error('$DB + $MAD-SKS did not route to the MAD-SKS SQL-plane')
  const madDir = path.join(root, '.sneakoscope', 'missions', madMissionId)
  const capability = JSON.parse(await fsp.readFile(path.join(madDir, 'mad-sks', 'sql-plane', 'capability.json'), 'utf8'))
  const madGate = JSON.parse(await fsp.readFile(path.join(madDir, 'mad-sks-gate.json'), 'utf8'))
  if (capability?.schema !== 'sks.mad-sks-sql-plane-capability.v2' || capability?.mission_id !== madMissionId) {
    throw new Error('$DB + $MAD-SKS did not bind a capability-v2 SQL-plane')
  }
  if (madGate?.sql_plane?.requested !== true || madGate?.control_plane_denied !== true) {
    throw new Error('$DB + $MAD-SKS is missing SQL-plane/control-plane boundary evidence')
  }
  await fsp.access(path.join(madDir, 'manual-migration.sql')).then(
    () => { throw new Error('$DB + $MAD-SKS must not generate manual-migration.sql') },
    () => undefined
  )

  console.log(JSON.stringify({
    schema: 'sks.db-route-materialization-check.v1',
    ok: true,
    route: '$DB',
    mission_id: missionId,
    artifacts: [
      'db-safety-scan.json',
      'db-access-candidates.json',
      'db-access-review.json',
      'db-review.json',
      'code-structure-report.json',
      'engineering-sanity-review.json'
    ],
    mad_sks_sql_plane: {
      mission_id: madMissionId,
      capability_schema: capability.schema,
      manual_migration_absent: true
    },
    legacy_cli_registered: false
  }, null, 2))
} finally {
  if (previousProjectRef === undefined) delete process.env.SKS_MAD_SKS_SQL_PLANE_PROJECT_REF
  else process.env.SKS_MAD_SKS_SQL_PLANE_PROJECT_REF = previousProjectRef
  await fsp.rm(root, { recursive: true, force: true })
}
