import { sha256 } from '../../../fsx.js';
import {
  sortStrings,
  type ArchitectureFinding,
  type ArchitectureFindingCode,
  type ArchitectureFindingSeverity
} from './contracts.js';

const FINDING_SCHEMA = 'sks.architecture-finding.v1';

export function findingId(input: {
  code: ArchitectureFindingCode;
  subjectIds: readonly string[];
  evidenceIds: readonly string[];
  ruleId: string;
}): string {
  const payload = [
    FINDING_SCHEMA,
    input.code,
    ...sortStrings(input.subjectIds),
    ...sortStrings(input.evidenceIds),
    input.ruleId
  ].join('\n');
  return `af_${sha256(payload).slice(0, 24)}`;
}

export function makeFinding(input: {
  code: ArchitectureFindingCode;
  severity: ArchitectureFindingSeverity;
  subjectIds: readonly string[];
  evidenceIds?: readonly string[];
  ruleId?: string;
  message: string;
}): ArchitectureFinding {
  const subjectIds = Object.freeze(sortStrings(input.subjectIds));
  const evidenceIds = Object.freeze(sortStrings(input.evidenceIds ?? []));
  const ruleId = input.ruleId ?? '';
  return Object.freeze({
    id: findingId({ code: input.code, subjectIds, evidenceIds, ruleId }),
    code: input.code,
    severity: input.severity,
    subjectIds,
    evidenceIds,
    ruleId,
    message: input.message,
    disposition: 'open' as const
  });
}
