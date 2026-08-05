/** Legacy 8.1.2 desktop modes. Migration/facade use only. */
export const LEGACY_CODEX_LB_DESKTOP_MODES = [
  'desktop-native-bridge',
  'desktop-dual-auth-compat',
  'cli-provider',
  'disabled'
] as const;

export type LegacyCodexLbDesktopMode = (typeof LEGACY_CODEX_LB_DESKTOP_MODES)[number];

export function parseLegacyCodexLbDesktopMode(value: unknown): LegacyCodexLbDesktopMode | null {
  const normalized = String(value ?? '').trim();
  return (LEGACY_CODEX_LB_DESKTOP_MODES as readonly string[]).includes(normalized)
    ? normalized as LegacyCodexLbDesktopMode
    : null;
}
