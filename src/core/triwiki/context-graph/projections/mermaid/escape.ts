/**
 * Label escaper for htmlLabels: false (atlas mermaid-syntax rules).
 */
import { MERMAID_LABEL_DISPLAY_LIMIT } from './contracts.js';

const MERMAID_EMPTY_LABEL = '(unlabeled)';
const ELLIPSIS = '...';
const INVISIBLE_FORMAT = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const CONTROL_RANGE = /[\u0000-\u001f\u007f-\u009f]/g;
const WHITESPACE_RUN = /\s+/g;
const HOME_PATH = /(?:^|[\s"'])(?:\/Users|\/home)\/[^\s"']+/g;
const SECRETISH = /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;

const MERMAID_ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/#/g, '#35;'],
  [/"/g, '#34;'],
  [/</g, '#60;'],
  [/>/g, '#62;'],
  [/\|/g, '#124;'],
  [/`/g, "'"]
];

function boundCodePoints(text: string, limit: number): string {
  const points = Array.from(text);
  if (points.length <= limit) return text;
  return `${points.slice(0, Math.max(1, limit - ELLIPSIS.length)).join('')}${ELLIPSIS}`;
}

export function mermaidLabel(text: string, displayLimit: number = MERMAID_LABEL_DISPLAY_LIMIT): string {
  if (!Number.isInteger(displayLimit) || displayLimit < 8) {
    throw new Error('mermaid_display_limit_out_of_range');
  }
  const normalized = String(text ?? '')
    .normalize('NFC')
    .replace(INVISIBLE_FORMAT, '')
    .replace(CONTROL_RANGE, ' ')
    .replace(HOME_PATH, '[redacted-path]')
    .replace(SECRETISH, '[redacted-secret]')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
  const bounded = boundCodePoints(normalized, displayLimit);
  if (!bounded) return MERMAID_EMPTY_LABEL;
  let escaped = bounded;
  for (const [pattern, replacement] of MERMAID_ESCAPES) escaped = escaped.replace(pattern, replacement);
  return escaped;
}

export function asRelationLabel(text: string): string {
  return mermaidLabel(text, 48);
}
