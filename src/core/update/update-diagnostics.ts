import os from 'node:os';

export function deepestUpdateErrorCause(error: unknown): unknown {
  let current = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 16; depth += 1) {
    if (!current || typeof current !== 'object') break;
    if (seen.has(current)) break;
    seen.add(current);
    let cause: unknown;
    try {
      cause = (current as { cause?: unknown }).cause;
    } catch {
      break;
    }
    if (cause === undefined || cause === null || cause === current) break;
    current = cause;
  }
  return current;
}

export function publicUpdateError(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
  maxLength = 400
): string {
  const deepest = deepestUpdateErrorCause(error);
  let value = updateErrorText(deepest)
    || updateErrorText(error)
    || 'update status refresh failed';
  value = value.replace(/[\r\n]+/g, ' ');
  const home = env.HOME || os.homedir();
  if (home) value = value.replaceAll(home, '~');
  return value
    .replace(/sk-(?:proj|or-v1|clb)?-?[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/(api[_-]?key|secret|token|authorization)\s*[:=]\s*[^\s"',}]+/gi, '$1=[redacted]')
    .slice(0, Math.max(1, maxLength));
}

function updateErrorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  if (value && typeof value === 'object') {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return '';
}
