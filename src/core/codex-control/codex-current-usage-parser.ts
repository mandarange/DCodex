export interface CodexCurrentFeatureUsageParseResult {
  schema: 'sks.codex-current-feature-usage-parse.v1';
  ok: boolean;
  source_format: 'json' | 'text' | 'unknown';
  views: {
    daily?: number;
    weekly?: number;
    cumulative?: number;
    limit?: number;
    tokens?: number;
  };
  evidence: string[];
  blockers: string[];
}

export function parseCodexCurrentFeatureUsageOutput(text: string): CodexCurrentFeatureUsageParseResult {
  const trimmed = String(text || '').trim();
  if (!trimmed) return result('unknown', {}, [], ['usage_output_empty']);
  const json = parseJsonObject(trimmed);
  if (json) {
    const views = extractUsageNumbers(json);
    const ok = Object.keys(views).length > 0;
    return result('json', views, ok ? [`json_usage_keys:${Object.keys(views).sort().join(',')}`] : [], ok ? [] : ['usage_json_missing_known_fields']);
  }
  const views = extractUsageText(trimmed);
  const ok = Object.keys(views).length > 0;
  return result('text', views, ok ? [`text_usage_keys:${Object.keys(views).sort().join(',')}`] : [], ok ? [] : ['usage_text_missing_known_fields']);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function extractUsageNumbers(value: unknown, prefix = ''): CodexCurrentFeatureUsageParseResult['views'] {
  const out: CodexCurrentFeatureUsageParseResult['views'] = {};
  if (!value || typeof value !== 'object') return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const label = `${prefix}.${key}`.toLowerCase();
    if (typeof child === 'number' && Number.isFinite(child)) assignKnownUsageNumber(out, label, child);
    else if (typeof child === 'string') {
      const parsed = numeric(child);
      if (parsed !== null) assignKnownUsageNumber(out, label, parsed);
    } else if (child && typeof child === 'object') {
      Object.assign(out, extractUsageNumbers(child, label));
    }
  }
  return out;
}

function extractUsageText(text: string): CodexCurrentFeatureUsageParseResult['views'] {
  const out: CodexCurrentFeatureUsageParseResult['views'] = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/\b(daily|weekly|cumulative|limit|quota|tokens?)\b[^0-9]*([0-9][0-9,._]*)/i);
    if (!match) continue;
    const parsed = numeric(String(match[2] || ''));
    if (parsed !== null) assignKnownUsageNumber(out, String(match[1] || '').toLowerCase(), parsed);
  }
  return out;
}

function assignKnownUsageNumber(out: CodexCurrentFeatureUsageParseResult['views'], label: string, value: number): void {
  if (/limit|quota/.test(label)) out.limit = value;
  else if (/daily/.test(label)) out.daily = value;
  else if (/weekly/.test(label)) out.weekly = value;
  else if (/cumulative|total/.test(label)) out.cumulative = value;
  else if (/token/.test(label)) out.tokens = value;
}

function numeric(value: string): number | null {
  const parsed = Number(String(value || '').replace(/[,_]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function result(
  sourceFormat: CodexCurrentFeatureUsageParseResult['source_format'],
  views: CodexCurrentFeatureUsageParseResult['views'],
  evidence: string[],
  blockers: string[]
): CodexCurrentFeatureUsageParseResult {
  return {
    schema: 'sks.codex-current-feature-usage-parse.v1',
    ok: blockers.length === 0,
    source_format: sourceFormat,
    views,
    evidence,
    blockers
  };
}
