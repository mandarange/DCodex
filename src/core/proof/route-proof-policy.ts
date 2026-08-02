import { unprefixedSksSkillName } from '../routes/dollar-prefix.js';

export const SERIOUS_ROUTE_ALIASES = Object.freeze([
  '$Naruto',
  '$DFix',
  '$QA-LOOP',
  '$Research',
  '$AutoResearch',
  '$Release-Review',
  '$PPT',
  '$Image-UX-Review',
  '$UX-Review',
  '$Visual-Review',
  '$UI-UX-Review',
  '$From-Chat-IMG',
  '$Computer-Use',
  '$CU',
  '$DB',
  '$Wiki',
  '$SEO-GEO-OPTIMIZER',
  '$GX',
  '$Align',
  '$Goal',
  '$MAD-SKS',
  'hproof',
  'proof-field',
  'recallpulse'
]);

export const VISUAL_ROUTE_ALIASES = Object.freeze([
  '$Image-UX-Review',
  '$UX-Review',
  '$Visual-Review',
  '$UI-UX-Review',
  '$From-Chat-IMG',
  '$PPT',
  '$QA-LOOP',
  '$Computer-Use',
  '$CU',
  '$GX'
]);

const ROUTE_NORMALIZATION = Object.freeze({
  naruto: '$Naruto',
  work: '$Naruto',
  dfix: '$DFix',
  qaloop: '$QA-LOOP',
  'qa-loop': '$QA-LOOP',
  research: '$Research',
  autoresearch: '$AutoResearch',
  releasereview: '$Release-Review',
  'release-review': '$Release-Review',
  ppt: '$PPT',
  imageuxreview: '$Image-UX-Review',
  'image-ux-review': '$Image-UX-Review',
  uxreview: '$Image-UX-Review',
  'ux-review': '$Image-UX-Review',
  visualreview: '$Image-UX-Review',
  'visual-review': '$Image-UX-Review',
  uiuxreview: '$Image-UX-Review',
  'ui-ux-review': '$Image-UX-Review',
  fromchatimg: '$From-Chat-IMG',
  'from-chat-img': '$From-Chat-IMG',
  computeruse: '$Computer-Use',
  'computer-use': '$Computer-Use',
  cu: '$CU',
  db: '$DB',
  wiki: '$Wiki',
  seogeooptimizer: '$SEO-GEO-OPTIMIZER',
  'seo-geo-optimizer': '$SEO-GEO-OPTIMIZER',
  gx: '$GX',
  align: '$Align',
  goal: '$Goal',
  madsks: '$MAD-SKS',
  'mad-sks': '$MAD-SKS',
  hproof: 'hproof',
  prooffield: 'proof-field',
  'proof-field': 'proof-field',
  recallpulse: 'recallpulse'
});

export function normalizeProofRoute(route: any) {
  const raw = String(route || '').trim();
  if (!raw) return null;
  const stripped = unprefixedSksSkillName(raw).replace(/[^A-Za-z0-9-]+/g, '').toLowerCase();
  if (/^(?:agent|team|mad-?db|swarm|shadow-?clone|kage-?bunshin|tmux|xai)$/.test(stripped)) return null;
  return (ROUTE_NORMALIZATION as Record<string, string>)[stripped] || raw;
}

export function routeRequiresCompletionProof(route: any) {
  const normalized = normalizeProofRoute(route);
  return Boolean(normalized && SERIOUS_ROUTE_ALIASES.includes(normalized));
}

export function routeRequiresImageVoxelAnchors(route: any, opts: any = {}) {
  if (opts.visualClaim === true) return true;
  const normalized = normalizeProofRoute(route);
  if (opts.visualClaim === false) return false;
  return Boolean(normalized && VISUAL_ROUTE_ALIASES.includes(normalized));
}

export function routeFromState(state: any = {}) {
  return normalizeProofRoute(state.route_command || state.route || state.mode || state.route_id || state.id);
}

export function proofStatusBlocks(status: any) {
  return status === 'failed' || status === 'blocked' || status === 'not_verified' || status === 'mock_only';
}
