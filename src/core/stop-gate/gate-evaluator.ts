import path from 'node:path';
import { exists, readJson } from '../fsx.js';
import { imageDimensions, sha256File } from '../wiki-image/image-hash.js';
import { imagegenEvidenceClassBlockers, isFullImagegenOutputSource } from '../imagegen/imagegen-evidence.js';

export type GateVerdictKind = 'pass' | 'fail' | 'mock_only' | 'missing' | 'invalid';

export interface GateVerdict {
  pass: boolean;
  verdict: GateVerdictKind;
  reasons: string[];
  gate_path?: string;
  gate?: Record<string, unknown> | null;
}

export async function evaluateGate(root: string, missionId: string, gateFile: string): Promise<GateVerdict> {
  const gatePath = path.isAbsolute(gateFile)
    ? gateFile
    : path.join(root, '.sneakoscope', 'missions', missionId, gateFile);

  if (!(await exists(gatePath))) {
    return { pass: false, verdict: 'missing', reasons: ['gate_file_missing'], gate_path: gatePath, gate: null };
  }

  const gate = await readJson(gatePath, null) as Record<string, unknown> | null;
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
    return { pass: false, verdict: 'invalid', reasons: ['gate_json_invalid'], gate_path: gatePath, gate: null };
  }

  const blockers = Array.isArray(gate.blockers) ? gate.blockers : null;
  const reasons: string[] = [];
  if (gate.execution_class === 'mock_fixture') {
    if (gate.passed !== true) reasons.push('gate_not_passed');
    if (gate.ok === false) reasons.push('gate_ok_false');
    if (!blockers) reasons.push('gate_blockers_not_array');
    else if (blockers.length > 0) reasons.push('gate_blockers_present');
    return { pass: false, verdict: 'mock_only', reasons: reasons.length ? reasons : ['gate_execution_class_mock_fixture'], gate_path: gatePath, gate };
  }
  if (gate.passed !== true) reasons.push('gate_not_passed');
  if (gate.ok === false) reasons.push('gate_ok_false');
  if (!blockers) reasons.push('gate_blockers_not_array');
  else if (blockers.length > 0) reasons.push('gate_blockers_present');
  if (gateFile === 'mad-sks-gate.json' || /mad-sks-gate\.json$/.test(gatePath)) {
    const sqlPlane = (gate as any).sql_plane;
    if (sqlPlane?.requested === true) {
      if (sqlPlane.read_back_passed !== true) reasons.push('mad_sks_sql_plane_read_back_not_passed');
      if (sqlPlane.profile_closed !== true) reasons.push('mad_sks_sql_plane_profile_not_closed');
    }
  }
  if (gateFile === 'image-ux-review-gate.json' || /image-ux-review-gate\.json$/.test(gatePath)) {
    const needsFullImagegenEvidence = (gate as any).full_review_passed === true
      || (gate as any).gpt_image_2_callout_generated === true
      || ((gate as any).passed === true && (gate as any).reference_only !== true);
    if (needsFullImagegenEvidence) {
      reasons.push(...await imagegenResponseGateReasons(root, path.dirname(gatePath)));
    }
  }
  if (gateFile === 'ppt-gate.json' || /ppt-gate\.json$/.test(gatePath)) {
    const imagegenEvidence = (gate as any).imagegen_evidence;
    if (imagegenEvidence?.required === true && imagegenEvidence.passed !== true) {
      reasons.push('ppt_imagegen_evidence_not_passed');
    }
  }

  if (reasons.length > 0) {
    return { pass: false, verdict: 'fail', reasons, gate_path: gatePath, gate };
  }
  return { pass: true, verdict: 'pass', reasons: [], gate_path: gatePath, gate };
}

async function imagegenResponseGateReasons(root: string, missionDir: string) {
  const reasons: string[] = [];
  const response = await readJson(path.join(missionDir, 'image-ux-gpt-image-2-response.json'), null) as any;
  if (!response || typeof response !== 'object') return ['imagegen_response_artifact_missing'];
  if (response.schema !== 'sks.image-ux-gpt-image-2-response.v1') reasons.push('imagegen_response_schema_invalid');
  if (response.ok !== true || response.status !== 'generated') reasons.push(response.blocker || 'imagegen_response_not_generated');
  const evidenceClass = String(response.evidence_class || '');
  reasons.push(...imagegenEvidenceClassBlockers('imagegen_response', evidenceClass));
  const outputSource = String(response.output_source || '');
  if (!isFullImagegenOutputSource(outputSource)) reasons.push('imagegen_response_output_source_invalid');
  const outputPath = String(response.output_image_path || '');
  const expectedSha = String(response.output_sha256 || response.output_image_sha256 || '');
  if (!outputPath) reasons.push('imagegen_response_output_path_missing');
  if (!expectedSha) reasons.push('imagegen_response_output_sha256_missing');
  if (outputPath) {
    const absolute = path.isAbsolute(outputPath) ? outputPath : path.resolve(root, outputPath);
    try {
      const actualSha = await sha256File(absolute);
      if (expectedSha && actualSha !== expectedSha) reasons.push('imagegen_response_output_sha256_mismatch');
      const dims = await imageDimensions(absolute);
      if (!Number.isFinite(Number(dims.width)) || !Number.isFinite(Number(dims.height)) || Number(dims.width) <= 0 || Number(dims.height) <= 0) {
        reasons.push('imagegen_response_output_dimensions_invalid');
      }
    } catch {
      reasons.push('imagegen_response_output_file_unreadable');
    }
  }
  return [...new Set(reasons)];
}
