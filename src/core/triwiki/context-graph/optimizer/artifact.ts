/**
 * What a winning experiment is allowed to produce.
 *
 * Not an edit. Not a staged change. A single JSON file under the workspace report
 * directory describing the proposed values, the numbers that justified them, and
 * the receipt needed to reproduce the comparison. Applying it is a human action,
 * and the artifact says so in the file itself rather than only in the docs.
 *
 * Both writers refuse to persist anything that trips the benchmark's own leak
 * rules, so an artifact can never become a second copy of a leak.
 */
import fs from 'node:fs';
import path from 'node:path';
import { appendJsonlBounded } from '../../../fsx.js';
import { contextGraphExperimentLogPath } from '../paths.js';
import { scanForLeaks } from '../benchmark/floors.js';
import { contextGraphTuningTargetFile } from './allowlist.js';
import { resolveContextGraphTunableParameter } from './parameter-space.js';
import {
  CONTEXT_GRAPH_PATCH_ARTIFACT_SCHEMA,
  type ContextGraphExperimentBudget,
  type ContextGraphExperimentRecord,
  type ContextGraphParameterOverride,
  type ContextGraphPatchOverrideDetail,
  type ContextGraphTuningPatchArtifact
} from './types.js';

export const CONTEXT_GRAPH_OPTIMIZER_REPORT_SEGMENTS = ['.sneakoscope', 'reports', 'context-graph-optimizer'] as const;
export const CONTEXT_GRAPH_EXPERIMENT_LOG_MAX_BYTES = 2 * 1024 * 1024;
export const CONTEXT_GRAPH_OPTIMIZER_ENTRY_POINT = 'runContextGraphOptimizerLoop' as const;

export function contextGraphOptimizerReportDir(root: string): string {
  return path.join(root, ...CONTEXT_GRAPH_OPTIMIZER_REPORT_SEGMENTS);
}

export function contextGraphPatchArtifactPath(root: string, candidateId: string): string {
  return path.join(contextGraphOptimizerReportDir(root), `${candidateId}.patch.json`);
}

/** Workspace-relative POSIX form of an absolute artifact path. */
export function workspaceRelativePosix(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function overrideDetail(override: ContextGraphParameterOverride): ContextGraphPatchOverrideDetail {
  const parameter = resolveContextGraphTunableParameter(override.target, override.pointer);
  return {
    target: override.target,
    file: contextGraphTuningTargetFile(override.target),
    pointer: override.pointer,
    from: parameter?.baseline ?? 0,
    to: override.value,
    min: parameter?.min ?? 0,
    max: parameter?.max ?? 0,
    rule: parameter?.rule ?? 'unknown'
  };
}

export interface BuildContextGraphPatchArtifactInput {
  readonly runId: string;
  readonly experimentId: string;
  readonly candidateId: string;
  readonly label: string;
  readonly rationale: string;
  readonly overrides: readonly ContextGraphParameterOverride[];
  readonly baselineComposite: number;
  readonly candidateComposite: number;
  readonly improvement: number;
  readonly corpusRevision: string;
  readonly corpusHash: string;
  readonly scoringCodeHash: string | null;
  readonly budget: ContextGraphExperimentBudget;
  readonly generatedAt: string;
  readonly surfaceDigest: string;
}

export function buildContextGraphPatchArtifact(
  input: BuildContextGraphPatchArtifactInput
): ContextGraphTuningPatchArtifact {
  const details = input.overrides.map(overrideDetail);
  const files = [...new Set(details.map((item) => item.file))].sort();
  return {
    schema: CONTEXT_GRAPH_PATCH_ARTIFACT_SCHEMA,
    runId: input.runId,
    experimentId: input.experimentId,
    candidateId: input.candidateId,
    label: input.label,
    rationale: input.rationale,
    overrides: details,
    baselineComposite: input.baselineComposite,
    candidateComposite: input.candidateComposite,
    compositeDelta: Math.round((input.candidateComposite - input.baselineComposite) * 1e6) / 1e6,
    improvement: input.improvement,
    floorsOk: true,
    receipt: {
      corpusRevision: input.corpusRevision,
      corpusHash: input.corpusHash,
      scoringCodeHash: input.scoringCodeHash,
      budget: input.budget,
      generatedAt: input.generatedAt,
      surfaceDigest: input.surfaceDigest,
      rerunEntryPoint: CONTEXT_GRAPH_OPTIMIZER_ENTRY_POINT
    },
    reviewRequired: true,
    applyInstructions: [
      'This file is a proposal. Nothing in the repository was changed by the experiment that produced it.',
      `Human review is required before any of these values is adopted: ${files.join(', ')}.`,
      'Re-run the loop with the receipt budget above and confirm the composite delta reproduces on your machine.',
      'Apply by hand, one pointer at a time, then re-run the benchmark and the full test suite.',
      'Reject the proposal if the delta does not reproduce, or if a hard floor is anything other than green.'
    ]
  };
}

export interface WriteContextGraphArtifactResult {
  readonly written: boolean;
  readonly relativePath: string;
  readonly leakRules: readonly string[];
}

/** Serializes and writes the proposal; refuses when the serialized form trips a leak rule. */
export function writeContextGraphPatchArtifact(
  root: string,
  artifact: ContextGraphTuningPatchArtifact
): WriteContextGraphArtifactResult {
  const absolute = contextGraphPatchArtifactPath(root, artifact.candidateId);
  const relativePath = workspaceRelativePosix(root, absolute);
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const scan = scanForLeaks(serialized);
  const leakRules = [...scan.secretRules, ...scan.pathRules].sort();
  if (leakRules.length) return { written: false, relativePath, leakRules };
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, serialized, 'utf8');
  return { written: true, relativePath, leakRules: [] };
}

/**
 * Appends one experiment row to the bounded JSONL log. A row that trips a leak
 * rule is dropped rather than written, and the caller is told which rules fired.
 */
export async function appendContextGraphExperimentRecord(
  root: string,
  record: ContextGraphExperimentRecord,
  maxBytes: number = CONTEXT_GRAPH_EXPERIMENT_LOG_MAX_BYTES
): Promise<WriteContextGraphArtifactResult> {
  const absolute = contextGraphExperimentLogPath(root);
  const relativePath = workspaceRelativePosix(root, absolute);
  const scan = scanForLeaks(JSON.stringify(record));
  const leakRules = [...scan.secretRules, ...scan.pathRules].sort();
  if (leakRules.length) return { written: false, relativePath, leakRules };
  await appendJsonlBounded(absolute, record, maxBytes);
  return { written: true, relativePath, leakRules: [] };
}
