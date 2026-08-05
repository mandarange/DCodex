import type { BridgeCatalogModel } from '../bridge-contracts.js';

export function safeErrorCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || '');
  return /^[a-z0-9_:-]{1,160}$/i.test(message) ? message : fallback;
}

export function compareModels(left: BridgeCatalogModel, right: BridgeCatalogModel): number {
  return left.public_id.localeCompare(right.public_id)
    || left.provider_id.localeCompare(right.provider_id)
    || left.upstream_model.localeCompare(right.upstream_model);
}

export function unique(values: readonly unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}
