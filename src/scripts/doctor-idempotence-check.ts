#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist, root } from './gate-lib.js'

const { runDoctorIdempotence } = await importDist('core/doctor/doctor-idempotence.js')
const report = await runDoctorIdempotence(root)
assertGate(report.ok, 'doctor_idempotence_failed', report)
emitGate('doctor:idempotence', { rollback_manifest_exists: report.rollback_manifest_exists })
