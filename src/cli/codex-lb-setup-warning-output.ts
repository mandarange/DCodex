const CODEX_LB_SETUP_WARNING_MESSAGES: Record<string, string> = {
  legacy_keychain_removed_rotate_provider_key_if_not_already_rotated:
    'The retired macOS Keychain item was removed. Rotate the provider API key if it has not already been rotated.',
  legacy_keychain_cleanup_indeterminate_rotate_provider_key:
    'Legacy macOS Keychain cleanup could not be proved. Rotate the provider API key before continuing to use it.'
};

export function formatCodexLbSetupWarnings(result: any): string[] {
  const warningCodes = [
    ...(Array.isArray(result?.warnings) ? result.warnings : []),
    result?.persistence?.warning
  ]
    .map((value: unknown) => String(value || '').trim())
    .filter(Boolean);
  return [...new Set(warningCodes)].map(
    (warning) => `warning: ${CODEX_LB_SETUP_WARNING_MESSAGES[warning] || warning}`
  );
}

export function printCodexLbSetupWarnings(
  result: any,
  write: (message: string) => void = console.error
): void {
  for (const warning of formatCodexLbSetupWarnings(result)) write(warning);
}
