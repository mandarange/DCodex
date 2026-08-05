/**
 * C6 / NC-10: Light completion-relaxation set.
 * Light paths may close with low-cost verification or documentation-only closeout.
 * They never substitute for full-route or release completion.
 */
export const LIGHT_COMPLETION_ROUTES = [
  'answer',
  'dfix',
  'help',
  'status',
  'dollar-commands',
  'aliases',
  'commands',
  'quickstart'
] as const;

export type LightCompletionRoute = (typeof LIGHT_COMPLETION_ROUTES)[number];

export function normalizeRouteKey(route: unknown): string {
  return String(route || '')
    .replace(/^\$/, '')
    .replace(/^sks-/i, '')
    .replace(/_/g, '-')
    .trim()
    .toLowerCase();
}

export function isLightCompletionRoute(route: unknown): boolean {
  const key = normalizeRouteKey(route);
  if (!key) return false;
  if ((LIGHT_COMPLETION_ROUTES as readonly string[]).includes(key)) return true;
  // Help/status-class read-only surfaces (not doctor --fix)
  if (key === 'sks' || key === 'usage' || key === 'version') return true;
  return false;
}
