import type { BridgeCatalogModel } from '../bridge-contracts.js';

export function safeErrorCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || '');
  return /^[a-z0-9_:-]{1,160}$/i.test(message) ? message : fallback;
}

// codex-lb (the user's authenticated gateway) sorts before openrouter so its
// models survive any downstream picker truncation; Codex Desktop renders
// catalog rows in file order when priorities tie.
export function compareModels(left: BridgeCatalogModel, right: BridgeCatalogModel): number {
  if (left.provider_id !== right.provider_id) {
    if (left.provider_id === 'codex-lb') return -1;
    if (right.provider_id === 'codex-lb') return 1;
    return left.provider_id.localeCompare(right.provider_id);
  }
  return left.public_id.localeCompare(right.public_id)
    || left.upstream_model.localeCompare(right.upstream_model);
}

export function unique(values: readonly unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}
