import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from '../../fsx.js';
import type { DesktopBridgeMigrationMetadataUpdate } from './types.js';

export function validateMetadataUpdates(
  updates: DesktopBridgeMigrationMetadataUpdate[],
  protectedPaths: { home: string; configPath: string; authPath: string }
): void {
  const seen = new Set<string>();
  for (const update of updates) {
    const filePath = path.resolve(String(update.path || ''));
    if (!update.path || !path.isAbsolute(update.path)) {
      throw new Error('desktop_bridge_metadata_path_invalid');
    }
    if (filePath === path.resolve(protectedPaths.configPath)) {
      throw new Error('desktop_bridge_metadata_config_path_forbidden');
    }
    if (filePath === path.resolve(protectedPaths.authPath) || metadataPathLooksSecret(filePath)) {
      throw new Error('desktop_bridge_metadata_secret_path_forbidden');
    }
    const expectedPath = canonicalMetadataPath(protectedPaths.home, update.kind);
    if (filePath !== expectedPath) {
      throw new Error(`desktop_bridge_metadata_path_not_canonical:${update.kind}`);
    }
    if (seen.has(filePath)) throw new Error('desktop_bridge_metadata_path_duplicate');
    seen.add(filePath);
    if (!['bridge_settings', 'provider_registry', 'catalog_binding', 'route_policy', 'launchd_state'].includes(update.kind)) {
      throw new Error('desktop_bridge_metadata_kind_invalid');
    }
    if (typeof update.text !== 'string') throw new Error('desktop_bridge_metadata_text_invalid');
  }
}

export function normalizedMetadataUpdates(
  updates: DesktopBridgeMigrationMetadataUpdate[]
): DesktopBridgeMigrationMetadataUpdate[] {
  return updates.map((update) => ({ ...update, path: path.resolve(update.path) }));
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function writeBufferAtomic(filePath: string, bytes: Buffer): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await fsp.writeFile(tempPath, bytes, { mode: 0o600, flag: 'wx' });
    await fsp.rename(tempPath, filePath);
    await fsp.chmod(filePath, 0o600);
  } catch (error: unknown) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function canonicalMetadataPath(home: string, kind: DesktopBridgeMigrationMetadataUpdate['kind']): string {
  const resolvedHome = path.resolve(home);
  if (kind === 'bridge_settings') {
    return path.join(resolvedHome, '.codex', 'sks', 'desktop-bridge-settings.json');
  }
  if (kind === 'provider_registry') {
    return path.join(resolvedHome, '.codex', 'sks', 'sks-bridge-provider-registry.json');
  }
  if (kind === 'catalog_binding') {
    return path.join(resolvedHome, '.codex', 'sks', 'sks-bridge-active-generation.json');
  }
  if (kind === 'route_policy') {
    return path.join(resolvedHome, '.codex', 'sks', 'sks-bridge-route-policy.json');
  }
  return path.join(
    resolvedHome,
    'Library',
    'LaunchAgents',
    'com.sneakoscope.desktop-bridge.plist'
  );
}

function metadataPathLooksSecret(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  const segments = filePath.toLowerCase().split(path.sep);
  return segments.includes('secrets')
    || ['auth.json', 'sks-codex-lb.env', 'openrouter-api-key', 'openrouter-api-key.json'].includes(basename)
    || /(?:credential|api-key|secret)/i.test(basename);
}
