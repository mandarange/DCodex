import { parse } from 'smol-toml';
import { isDeepStrictEqual } from 'node:util';

export function contextManagementValue(text: string): boolean | undefined {
  const value = (parse(text) as any).features?.context_management?.experimental_mode;
  if (value !== undefined && typeof value !== 'boolean') throw new Error('context_management_invalid_boolean');
  return value;
}

/** Validate each textual edit against the exact intended TOML value change. */
export function setContextManagement(text: string, enabled: boolean, onlyIfAbsent = false): string {
  const before = parse(text) as any;
  const current = contextManagementValue(text);
  if (current === enabled || (onlyIfAbsent && current !== undefined)) return text;
  const expected = structuredClone(before);
  expected.features ??= {};
  expected.features.context_management ??= {};
  expected.features.context_management.experimental_mode = enabled;
  const valid = (candidate: string) => {
    try { return isDeepStrictEqual(parse(candidate), expected); } catch { return false; }
  };
  if (current !== undefined) {
    for (const match of text.matchAll(/\b(?:true|false)\b/g)) {
      const candidate = text.slice(0, match.index) + String(enabled) + text.slice(match.index! + match[0].length);
      if (valid(candidate)) return candidate;
    }
  } else {
    const suffix = `\n[features.context_management]\nexperimental_mode = ${enabled}\n`;
    if (valid(text + suffix)) return text + suffix;
    const candidates = [
      `features.context_management.experimental_mode = ${enabled}\n${text}`,
      ...[...text.matchAll(/\{/g)].flatMap(match => {
        const offset = match.index! + 1;
        const separator = /^\s*\}/.test(text.slice(offset)) ? '' : ', ';
        return [`experimental_mode = ${enabled}`, `context_management = { experimental_mode = ${enabled} }`]
          .map(value => text.slice(0, offset) + value + separator + text.slice(offset));
      }),
      ...[...text.matchAll(/^\s*\[[^\n]+\][^\n]*(?:\n|$)/gm)].flatMap(match => {
        const offset = match.index! + match[0].length;
        return ['experimental_mode', 'context_management.experimental_mode'].map(key => text.slice(0, offset) + `\n${key} = ${enabled}\n` + text.slice(offset));
      }),
    ];
    for (const candidate of candidates) if (valid(candidate)) return candidate;
  }
  throw new Error('context_management_config_edit_unsupported');
}
