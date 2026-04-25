import path from 'node:path';
import { exists, readJson, writeJsonAtomic, nowIso, fileSize } from './fsx.mjs';

export async function evaluateDoneGate(root, missionId) {
  const dir = path.join(root, '.sneakoscope', 'missions', missionId);
  const gatePath = path.join(dir, 'done-gate.json');
  const contractPath = path.join(dir, 'decision-contract.json');
  const contractExists = await exists(contractPath);
  const gate = await readJson(gatePath, {});
  const reasons = [];
  if (!contractExists) reasons.push('decision_contract_missing');
  if (gate.unsupported_critical_claims && gate.unsupported_critical_claims > 0) reasons.push('unsupported_critical_claims_present');
  if (gate.database_safety_violation === true || gate.db_safety_violation === true) reasons.push('database_safety_violation_present');
  if (gate.database_destructive_operation_attempted === true) reasons.push('destructive_database_operation_attempted');
  if (gate.visual_drift === 'high') reasons.push('visual_drift_high');
  if (gate.wiki_drift === 'high') reasons.push('wiki_drift_high');
  if (gate.tests_required === true && !gate.test_evidence_present) reasons.push('test_evidence_missing');
  const dbSafetyLog = path.join(dir, 'db-safety.jsonl');
  if ((await exists(dbSafetyLog)) && (await fileSize(dbSafetyLog)) > 0 && gate.database_safety_reviewed !== true) reasons.push('database_safety_log_requires_review');
  const passed = gate.passed === true && reasons.length === 0;
  const result = { checked_at: nowIso(), passed, reasons, gate };
  await writeJsonAtomic(path.join(dir, 'done-gate.evaluated.json'), result);
  return result;
}

export function defaultDoneGate() {
  return {
    passed: false,
    unsupported_critical_claims: 0,
    database_safety_violation: false,
    database_destructive_operation_attempted: false,
    database_safety_reviewed: true,
    visual_drift: 'unknown',
    wiki_drift: 'unknown',
    tests_required: true,
    test_evidence_present: false,
    notes: []
  };
}
