import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../../fsx.js';
import type { BridgeCatalogModel } from '../bridge-contracts.js';

export const BRIDGE_MODEL_SELECTION_SCHEMA = 'sks.bridge-model-selection.v1' as const;
export const BRIDGE_MODEL_SELECTION_FILENAME = 'sks-bridge-model-selection.json' as const;
export const BRIDGE_AVAILABLE_MODELS_FILENAME = 'sks-bridge-available-models.json' as const;

/** Upper bound on curated OpenRouter picks; the Desktop picker is a menu, not a catalog browser. */
export const MAX_SELECTED_OPENROUTER_MODELS = 64;

export interface BridgeModelSelection {
  schema: typeof BRIDGE_MODEL_SELECTION_SCHEMA;
  updated_at: string;
  /** codex-lb is always fully exposed; only OpenRouter is curated. */
  openrouter: { mode: 'selected'; public_ids: string[] };
}

export interface AvailableBridgeModelRow {
  public_id: string;
  display_name: string;
  selected: boolean;
}

export function bridgeModelSelectionPath(home: string): string {
  return path.join(path.resolve(home), '.codex', 'sks', BRIDGE_MODEL_SELECTION_FILENAME);
}

export function bridgeAvailableModelsPath(home: string): string {
  return path.join(path.resolve(home), '.codex', 'sks', BRIDGE_AVAILABLE_MODELS_FILENAME);
}

export function emptyBridgeModelSelection(now: string): BridgeModelSelection {
  return { schema: BRIDGE_MODEL_SELECTION_SCHEMA, updated_at: now, openrouter: { mode: 'selected', public_ids: [] } };
}

export function normalizeBridgeModelSelection(value: unknown, now: string): BridgeModelSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyBridgeModelSelection(now);
  const row = value as Record<string, unknown>;
  if (row.schema !== BRIDGE_MODEL_SELECTION_SCHEMA) return emptyBridgeModelSelection(now);
  const openrouter = row.openrouter && typeof row.openrouter === 'object' && !Array.isArray(row.openrouter)
    ? row.openrouter as Record<string, unknown>
    : {};
  const ids = Array.isArray(openrouter.public_ids)
    ? openrouter.public_ids.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  return {
    schema: BRIDGE_MODEL_SELECTION_SCHEMA,
    updated_at: typeof row.updated_at === 'string' && row.updated_at ? row.updated_at : now,
    openrouter: { mode: 'selected', public_ids: [...new Set(ids)].sort().slice(0, MAX_SELECTED_OPENROUTER_MODELS) }
  };
}

export async function readBridgeModelSelection(home: string, now = new Date().toISOString()): Promise<BridgeModelSelection> {
  return (await readBridgeModelSelectionState(home, now)).selection;
}

/**
 * `stored` distinguishes "operator has never curated" from "operator chose an
 * empty selection", so a first run can seed the model already in use instead of
 * silently removing it from the picker.
 */
export async function readBridgeModelSelectionState(
  home: string,
  now = new Date().toISOString()
): Promise<{ selection: BridgeModelSelection; stored: boolean }> {
  try {
    const raw = await fsp.readFile(bridgeModelSelectionPath(home), 'utf8');
    return { selection: normalizeBridgeModelSelection(JSON.parse(raw), now), stored: true };
  } catch {
    return { selection: emptyBridgeModelSelection(now), stored: false };
  }
}

export async function writeBridgeModelSelection(home: string, selection: BridgeModelSelection): Promise<void> {
  await writeJsonAtomic(bridgeModelSelectionPath(home), selection, { mode: 0o600 });
}

/**
 * codex-lb models are always exposed: they are the user's authenticated
 * gateway. OpenRouter is a 400-model directory, so only explicit picks reach
 * the Codex Desktop picker — an unfiltered catalog buries every usable model.
 */
export function applyBridgeModelSelection(
  models: readonly BridgeCatalogModel[],
  selection: BridgeModelSelection
): BridgeCatalogModel[] {
  const selected = new Set(selection.openrouter.public_ids);
  return models.filter((model) => model.provider_id !== 'openrouter' || selected.has(model.public_id));
}

export function availableModelRows(
  models: readonly BridgeCatalogModel[],
  selection: BridgeModelSelection
): AvailableBridgeModelRow[] {
  const selected = new Set(selection.openrouter.public_ids);
  return models
    .filter((model) => model.provider_id === 'openrouter')
    .map((model) => ({
      public_id: model.public_id,
      display_name: model.display_name,
      selected: selected.has(model.public_id)
    }))
    .sort((left, right) => left.display_name.localeCompare(right.display_name));
}

/**
 * Selections referencing models the provider no longer serves are dropped so a
 * stale pick can never keep an unroutable row in the active catalog.
 */
export function pruneSelection(selection: BridgeModelSelection, available: readonly AvailableBridgeModelRow[]): BridgeModelSelection {
  const known = new Set(available.map((row) => row.public_id));
  const kept = selection.openrouter.public_ids.filter((id) => known.has(id));
  if (kept.length === selection.openrouter.public_ids.length) return selection;
  return { ...selection, openrouter: { mode: 'selected', public_ids: kept } };
}
