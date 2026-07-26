/**
 * Candidate admission.
 *
 * Every candidate passes through here before a single benchmark case runs, and
 * the order of the checks is the point:
 *
 *   1. A file that belongs to the benchmark — corpus, fixtures, metrics, floors,
 *      scorer — is a `benchmark_integrity_violation`, not a rejection. It is
 *      reported at the highest severity and the candidate never executes.
 *   2. Any other non-allowlisted file is a plain rejection.
 *   3. Only then are pointers, kinds and bounds checked.
 *
 * A candidate may address a file either by target name (`ranking-config`) or by
 * its workspace-relative path; both go through the same classification, so there
 * is no spelling of "the corpus" that reaches the loop as an ordinary rejection.
 */
import { classifyContextGraphPatchTarget, contextGraphTuningTargetForFile } from './allowlist.js';
import { resolveContextGraphTunableParameter } from './parameter-space.js';
import { resolveContextGraphTuning } from './resolve.js';
import {
  isContextGraphTuningTarget,
  type ContextGraphCandidateRejection,
  type ContextGraphCandidateVerdict,
  type ContextGraphExperimentCandidate,
  type ContextGraphParameterOverride,
  type ContextGraphTuningTarget
} from './types.js';

export const CONTEXT_GRAPH_MAX_OVERRIDES_PER_CANDIDATE = 4;
const CANDIDATE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface ValidateContextGraphCandidateOptions {
  readonly maxOverrides?: number;
}

function reject(
  code: ContextGraphCandidateRejection['code'],
  detail: string,
  target: string | null = null,
  pointer: string | null = null
): ContextGraphCandidateRejection {
  return { code, target, pointer, detail };
}

/**
 * Map whatever the candidate wrote in `target` onto a tuning target. Returns the
 * rejection instead when the value names the benchmark or anything else.
 */
function classifyTarget(raw: unknown): { target: ContextGraphTuningTarget } | { rejection: ContextGraphCandidateRejection } {
  const label = typeof raw === 'string' ? raw : String(raw);
  const asPath = classifyContextGraphPatchTarget(raw);
  if (asPath === 'measurement') {
    return {
      rejection: reject(
        'benchmark_integrity_violation',
        'a candidate may not touch the benchmark corpus, its fixtures, or its scoring code',
        label
      )
    };
  }
  if (asPath === 'tunable') {
    const target = contextGraphTuningTargetForFile(raw);
    if (target) return { target };
  }
  if (isContextGraphTuningTarget(raw)) return { target: raw };
  return {
    rejection: reject('file_not_allowlisted', 'only the ranking configuration and the query profiles may be tuned', label)
  };
}

function validateOverride(
  raw: ContextGraphParameterOverride,
  seen: Set<string>
): { override: ContextGraphParameterOverride; changed: boolean } | { rejection: ContextGraphCandidateRejection } {
  const classified = classifyTarget(raw?.target);
  if ('rejection' in classified) return { rejection: classified.rejection };
  const target = classified.target;
  const pointer = typeof raw?.pointer === 'string' ? raw.pointer.trim() : '';
  const parameter = pointer ? resolveContextGraphTunableParameter(target, pointer) : null;
  if (!parameter) {
    return { rejection: reject('unknown_parameter', 'pointer does not address a tunable value', target, pointer || null) };
  }
  const key = `${target}:${pointer}`;
  if (seen.has(key)) {
    return { rejection: reject('duplicate_parameter', 'the same parameter is overridden twice', target, pointer) };
  }
  const value = raw.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { rejection: reject('value_not_finite', 'override value must be a finite number', target, pointer) };
  }
  if (parameter.kind === 'integer' && !Number.isInteger(value)) {
    return { rejection: reject('value_not_integer', `${pointer} is a count and must be an integer`, target, pointer) };
  }
  if (value < parameter.min || value > parameter.max) {
    return {
      rejection: reject(
        'value_out_of_bounds',
        `${value} is outside the allowed range [${parameter.min}, ${parameter.max}] for rule ${parameter.rule}`,
        target,
        pointer
      )
    };
  }
  seen.add(key);
  return { override: { target, pointer, value }, changed: value !== parameter.baseline };
}

/**
 * Admit or refuse a candidate. An accepted verdict carries the fully resolved
 * in-memory tuning; a refused one carries only codes, pointers and numbers.
 */
export function validateContextGraphCandidate(
  candidate: ContextGraphExperimentCandidate,
  options: ValidateContextGraphCandidateOptions = {}
): ContextGraphCandidateVerdict {
  const maxOverrides = Math.max(1, Math.trunc(options.maxOverrides ?? CONTEXT_GRAPH_MAX_OVERRIDES_PER_CANDIDATE));
  const candidateId = typeof candidate?.id === 'string' ? candidate.id.trim() : '';
  const rejections: ContextGraphCandidateRejection[] = [];
  const overrides: ContextGraphParameterOverride[] = [];
  const seen = new Set<string>();
  let changed = 0;

  if (!CANDIDATE_ID.test(candidateId)) {
    rejections.push(reject('invalid_candidate_id', 'candidate id must be a short lowercase slug'));
  }
  const rawOverrides = Array.isArray(candidate?.overrides) ? candidate.overrides : [];
  if (!rawOverrides.length) {
    rejections.push(reject('empty_candidate', 'a candidate must override at least one parameter'));
  }
  if (rawOverrides.length > maxOverrides) {
    rejections.push(
      reject('too_many_overrides', `a candidate may override at most ${maxOverrides} parameters at once`)
    );
  }

  for (const raw of rawOverrides) {
    const result = validateOverride(raw, seen);
    if ('rejection' in result) {
      rejections.push(result.rejection);
      continue;
    }
    overrides.push(result.override);
    if (result.changed) changed += 1;
  }

  if (!rejections.length && changed === 0) {
    rejections.push(reject('no_op_candidate', 'every override restates the checked-in value'));
  }

  const integrity = rejections.some((item) => item.code === 'benchmark_integrity_violation');
  if (integrity) return { candidateId, kind: 'integrity_violation', rejections, tuning: null };
  if (rejections.length) return { candidateId, kind: 'rejected', rejections, tuning: null };

  const resolved = resolveContextGraphTuning(overrides);
  if (resolved.unresolved.length) {
    return {
      candidateId,
      kind: 'rejected',
      rejections: resolved.unresolved.map((key) =>
        reject('unknown_parameter', 'pointer could not be applied to the tuning objects', null, key)
      ),
      tuning: null
    };
  }
  return { candidateId, kind: 'accepted', rejections: [], tuning: resolved.tuning };
}
