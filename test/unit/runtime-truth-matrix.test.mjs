import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('runtime truth matrix gate writes the v2 supporting-proof contract', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  const result = spawnSync(process.execPath, ['dist/scripts/release-runtime-truth-matrix-check.js'], { cwd: path.resolve('.'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(path.resolve(`.sneakoscope/reports/runtime-truth-matrix-${pkg.version}.json`), 'utf8'));
  assert.equal(report.ok, true);
  assert.equal(report.schema, 'sks.runtime-truth-matrix.v2');
  assert.equal(report.release_version, pkg.version);
  assert.equal(report.execution_authority.workflow, 'official_codex_subagent');
  assert.equal(report.rows.filter((row) => row.evidence_role === 'execution_authority').length, 1);
  for (const subsystem of ['official_codex_subagent', 'zellij_pane', 'cleanup', 'intelligent_work_graph', 'source_intelligence', 'goal_mode', 'route_blackbox', 'dynamic_scheduler', 'warp_mad_lanes', 'codex_0_134', 'mcp_0_134', 'parallel_write', 'patch_proof']) {
    const row = report.rows.find((item) => item.subsystem === subsystem);
    assert.ok(row, `missing subsystem ${subsystem}`);
    assert.equal(typeof row.proof_level, 'string');
    assert.equal(Array.isArray(row.evidence_artifacts), true);
    assert.equal(typeof row.next_action, 'string');
    assert.equal(typeof row.evidence_role, 'string');
  }
  for (const priority of ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']) assert.equal(report.priorities[priority].status, 'closed');
});

test('runtime truth matrix promotes only a complete official subagent evidence set', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-runtime-truth-v2-'));
  try {
    const mod = await import('../../dist/core/proof/runtime-truth-matrix.js');
    const matrix = await mod.buildRuntimeTruthMatrix({
      root,
      releaseVersion: 'test',
      reports: passingOfficialReports()
    });
    const authorityRows = matrix.rows.filter((row) => row.evidence_role === 'execution_authority');
    assert.equal(matrix.schema, 'sks.runtime-truth-matrix.v2');
    assert.equal(matrix.execution_authority.workflow, 'official_codex_subagent');
    assert.equal(authorityRows.length, 1);
    assert.equal(authorityRows[0].subsystem, 'official_codex_subagent');
    assert.equal(authorityRows[0].proof_level, 'proven');
    assert.equal(matrix.rows.find((row) => row.subsystem === 'appshots')?.proof_level, 'integration_optional');
    assert.equal(matrix.ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime truth matrix keeps optional supporting-proof blockers local to their rows', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-runtime-truth-optional-'));
  try {
    const mod = await import('../../dist/core/proof/runtime-truth-matrix.js');
    const reports = passingOfficialReports();
    reports['zellij-pane-proof.json'] = {
      schema: 'sks.zellij-pane-proof.v1',
      ok: true,
      status: 'passed'
    };
    const matrix = await mod.buildRuntimeTruthMatrix({
      root,
      releaseVersion: 'test',
      reports
    });
    const zellij = matrix.rows.find((row) => row.subsystem === 'zellij_pane');
    assert.deepEqual(zellij?.blockers, ['runtime_success_claim_without_receipt']);
    assert.equal(zellij?.required_mode, false);
    assert.deepEqual(matrix.blockers, []);
    assert.equal(matrix.ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function passingOfficialReports() {
  const runId = 'runtime-truth-v2-test';
  return {
    'subagent-plan.json': {
      schema: 'sks.subagent-plan.v1', workflow: 'official_codex_subagent', route: '$sks-naruto', workflow_run_id: runId,
      requested_subagents: 1, max_depth: 1, config_blockers: []
    },
    'subagent-evidence.json': {
      schema: 'sks.subagent-evidence.v1', workflow: 'official_codex_subagent', run_id: runId,
      requested_subagents: 1, started_threads: 1, completed_threads: 1, failed_threads: 0,
      open_thread_ids: [], event_sources: ['SubagentStart', 'SubagentStop'], parent_summary_present: true,
      parent_summary_trustworthy: true, parent_summary_status: 'completed', preparation_only: false,
      status: 'completed', ok: true, blockers: []
    },
    'naruto-summary.json': {
      schema: 'sks.naruto-subagent-workflow.v1', workflow: 'official_codex_subagent', route: '$sks-naruto', workflow_run_id: runId,
      requested_subagents: 1, status: 'completed', ok: true, completion_evidence: true, parent_summary_present: true, blockers: []
    },
    'naruto-gate.json': {
      schema: 'sks.naruto-gate.v1', workflow: 'official_codex_subagent', route: '$sks-naruto', workflow_run_id: runId,
      requested_subagents: 1, status: 'passed', passed: true, terminal: true, terminal_state: 'completed',
      official_subagent_evidence: true, subagent_evidence_ready: true, parent_summary_present: true,
      session_cleanup: true, native_process_proof_required: false, blockers: []
    },
    'appshots-evidence.json': {
      evidence: { status: 'not_required', proof_level: 'not_required', ok: false, blockers: [] }
    }
  };
}
