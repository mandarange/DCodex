import path from 'node:path';
import { formatUpdateBlockerWithRemedy } from '../config-adopt/config-adopt.js';

const MAX_STAGE_BLOCKERS = 16;
const MAX_BLOCKER_LENGTH = 500;

export interface UpdateStageDiagnosticInput {
  id: string;
  ok: boolean;
  status: string;
  detail?: Record<string, unknown>;
}

export function updateStageFailureDiagnostics(
  stage: UpdateStageDiagnosticInput,
  projectRoot: string
): string[] {
  if (stage.ok) return [];
  const detail = stage.detail || {};
  const explicitBlockers = [
    ...normalizeBlockers(detail.required_blockers),
    ...normalizeBlockers(detail.blockers),
    ...normalizeBlockers(detail.blocker)
  ];
  const blockers = explicitBlockers.length
    ? explicitBlockers
    : [
        ...normalizeSafeFallback(detail.reason),
        ...normalizeSafeFallback(detail.error)
      ];
  if (!blockers.length) return [];
  const configPath = typeof detail.config_path === 'string' && detail.config_path.trim()
    ? detail.config_path
    : path.join(
        typeof detail.root === 'string' && detail.root.trim() ? detail.root : projectRoot,
        '.codex',
        'config.toml'
      );
  return [...new Set(blockers)]
    .slice(0, MAX_STAGE_BLOCKERS)
    .map((blocker) => formatUpdateBlockerWithRemedy(blocker, configPath))
    .filter(Boolean);
}

function normalizeBlockers(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return values
    .map((entry) => String(entry || '').replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_BLOCKER_LENGTH))
    .filter(Boolean);
}

function normalizeSafeFallback(value: unknown): string[] {
  return normalizeBlockers(value).filter((entry) => /^[A-Za-z0-9_.:-]{1,200}$/.test(entry));
}
