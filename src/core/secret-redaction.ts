const SECRET_ENV_NAMES = [
  'CODEX_ACCESS_TOKEN',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'SKS_OPENROUTER_API_KEY',
  'CODEX_LB_API_KEY',
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'GITHUB_PAT'
];

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  /\bsk-proj-[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-or-v1-[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-or-[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-clb-[A-Za-z0-9_-]{8,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\b(?:glpat|pypi|hf)_[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
  /\bAuthorization\s*:\s*[^\r\n,}]+/gi,
  /\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n,}]+/gi,
  /\b[A-Za-z0-9-]+-Auth\s*:\s*[^\r\n,}]+/gi,
  /\b(?:access[_-]?token|api[_-]?key|secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}["']?/gi
];

export const REDACTION_MARKER = '[redacted]';

export function redactSecrets(value: any, env: any = process.env): any {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value, env);
  if (Array.isArray(value)) return value.map((item: any) => redactSecrets(item, env));
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [key, candidate] of Object.entries(value)) {
      out[key] = secretKeyName(key) ? REDACTION_MARKER : redactSecrets(candidate, env);
    }
    return out;
  }
  return value;
}

export function redactString(input: any = '', env: any = process.env) {
  let out = String(input);
  for (const name of SECRET_ENV_NAMES) {
    const raw = env?.[name];
    if (raw && raw.length >= 4) out = out.split(raw).join(REDACTION_MARKER);
    out = out.replace(new RegExp(`(${name}\\s*[:=]\\s*)[^\\s"',}]+`, 'gi'), `$1${REDACTION_MARKER}`);
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, (match: any) => redactKeyValue(match));
  return out;
}

export function containsPlaintextSecret(value: any, env: any = process.env) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || {});
  for (const name of SECRET_ENV_NAMES) {
    const raw = env?.[name];
    if (raw && raw.length >= 4 && text.includes(raw)) return true;
  }
  return SECRET_PATTERNS.some((pattern: any) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function secretKeyName(key: any = '') {
  return /(?:access[_-]?token|api[_-]?key|secret|password|token)$/i.test(String(key || ''))
    || /(?:^|[_-])(?:auth|authorization|headers?|cookies?|bearer|credentials?|env)$/i.test(String(key || ''))
    || SECRET_ENV_NAMES.includes(String(key || '').toUpperCase());
}

function redactKeyValue(match: any) {
  const keyValue = String(match).match(/^([^:=]+[:=]\s*)/);
  if (keyValue) return `${keyValue[1]}${REDACTION_MARKER}`;
  if (/^Bearer\s+/i.test(match)) return `Bearer ${REDACTION_MARKER}`;
  return REDACTION_MARKER;
}
