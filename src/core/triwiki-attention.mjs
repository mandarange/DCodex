import { buildWikiCoordinateIndex, compactWikiCoordinateIndex, normalizeWikiCoord, wikiCoordSimilarity } from './wiki-coordinate.mjs';

const TAU = 2 * Math.PI;

export const DEFAULT_TRUST_POLICY = {
  schema_version: 1,
  score_range: [0, 1],
  bands: [
    { band: 'high', min: 0.8, action: 'use' },
    { band: 'medium', min: 0.55, action: 'verify' },
    { band: 'low', min: 0.3, action: 'limit' },
    { band: 'untrusted', min: 0, action: 'exclude' }
  ],
  weights: {
    support: 0.4,
    authority: 0.25,
    freshness: 0.18,
    evidence: 0.17,
    risk_penalty: 0.28
  }
};

export function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }
export function wave(theta, phi) { return 0.5 + 0.5 * Math.cos(theta - phi); }

export function trigScore(missionCoord = {}, claimCoord = {}) {
  const missionWikiCoord = normalizeWikiCoord(missionCoord, 'mission');
  const claimWikiCoord = normalizeWikiCoord(claimCoord, 'claim');
  const domainDelta = (missionWikiCoord.domainAngle || 0) - (claimWikiCoord.domainAngle || 0);
  const layerDelta = (missionWikiCoord.layerRadius || 0) - (claimWikiCoord.layerRadius || 0);
  const phaseDelta = (missionWikiCoord.phase || 0) - (claimWikiCoord.phase || 0);
  return (
    0.32 * wave(domainDelta, 0) +
    0.18 * wave(layerDelta * 0.7, 0) +
    0.22 * wave(phaseDelta, 0) +
    0.28 * wikiCoordSimilarity(missionWikiCoord, claimWikiCoord)
  );
}

export function claimScore(mission, claim) {
  const support = { supported: 1, weak: 0.55, unknown: 0.2, unsupported: -1, conflicted: -2, stale: 0.05 }[claim.status || 'unknown'] ?? 0;
  const authority = { code: 1, test: 0.95, contract: 0.9, vgraph: 0.8, beta: 0.7, wiki: 0.55, visual_parse: 0.45, model: -0.5 }[claim.authority || 'wiki'] ?? 0.5;
  const risk = { low: 0.1, medium: 0.35, high: 0.75, critical: 1 }[claim.risk || 'medium'] ?? 0.35;
  const freshness = { fresh: 1, unknown: 0.35, stale: -0.6 }[claim.freshness || 'unknown'] ?? 0.35;
  const tokenCost = Math.max(1, claim.tokenCost || String(claim.text || '').length / 4);
  const r = Number.isFinite(claim.concentration) ? claim.concentration : 0.75;
  const normCompensation = (1 - clamp01(r)) * Math.log1p(claim.evidence_count || 0) * 0.12;
  return trigScore(mission.coord, claim.coord) + support + authority + 0.3 * risk + 0.4 * freshness + normCompensation - 0.01 * tokenCost;
}

function round4(x) { return Number(clamp01(x).toFixed(4)); }

function trustEvidenceScore(claim = {}) {
  const explicitCount = Number(claim.evidence_count);
  const evidenceCount = Number.isFinite(explicitCount)
    ? explicitCount
    : (Array.isArray(claim.evidence) ? claim.evidence.length : 0);
  return clamp01(Math.log1p(Math.max(0, evidenceCount)) / Math.log1p(8));
}

export function trustScore(claim = {}, policy = DEFAULT_TRUST_POLICY) {
  const explicitTrust = Number(claim.trust_score);
  if (Number.isFinite(explicitTrust)) return round4(explicitTrust);
  const weights = { ...DEFAULT_TRUST_POLICY.weights, ...(policy?.weights || {}) };
  const support = { supported: 1, weak: 0.62, stale: 0.35, unknown: 0.32, unsupported: 0.06, conflicted: 0 }[claim.status || 'unknown'] ?? 0.32;
  const authority = { code: 1, test: 0.96, contract: 0.9, vgraph: 0.78, beta: 0.68, wiki: 0.55, visual_parse: 0.45, model: 0.18 }[claim.authority || 'wiki'] ?? 0.5;
  const freshness = { fresh: 1, unknown: 0.55, stale: 0.18 }[claim.freshness || 'unknown'] ?? 0.55;
  const riskPenalty = { low: 0.04, medium: 0.18, high: 0.58, critical: 1 }[claim.risk || 'medium'] ?? 0.18;
  const evidence = trustEvidenceScore(claim);
  return round4(
    weights.support * support +
    weights.authority * authority +
    weights.freshness * freshness +
    weights.evidence * evidence -
    weights.risk_penalty * riskPenalty
  );
}

export function trustBand(scoreOrClaim, policy = DEFAULT_TRUST_POLICY) {
  const value = typeof scoreOrClaim === 'object' && scoreOrClaim !== null
    ? trustScore(scoreOrClaim, policy)
    : clamp01(Number(scoreOrClaim));
  const bands = [...(policy?.bands || DEFAULT_TRUST_POLICY.bands)].sort((a, b) => Number(b.min) - Number(a.min));
  return (bands.find((band) => value >= Number(band.min || 0)) || bands[bands.length - 1] || DEFAULT_TRUST_POLICY.bands[3]).band;
}

export function trustAction(scoreOrBand, policy = DEFAULT_TRUST_POLICY) {
  if (typeof scoreOrBand === 'object' && scoreOrBand !== null) {
    if (typeof scoreOrBand.trust_action === 'string') return scoreOrBand.trust_action;
    if (typeof scoreOrBand.trust_band === 'string') return trustAction(scoreOrBand.trust_band, policy);
    return trustAction(trustScore(scoreOrBand, policy), policy);
  }
  const band = typeof scoreOrBand === 'string' ? scoreOrBand : trustBand(scoreOrBand, policy);
  const bands = policy?.bands || DEFAULT_TRUST_POLICY.bands;
  return (bands.find((entry) => entry.band === band) || DEFAULT_TRUST_POLICY.bands[3]).action;
}

function withTrust(claim, policy = DEFAULT_TRUST_POLICY) {
  const trust_score = trustScore(claim, policy);
  const trust_band = trustBand(trust_score, policy);
  return { ...claim, trust_score, trust_band };
}

export function trustSummary(claims = [], policy = DEFAULT_TRUST_POLICY) {
  const rows = (claims || []).map((claim) => withTrust(claim, policy));
  const action_counts = {};
  const band_counts = {};
  let total = 0;
  let min = rows.length ? 1 : 0;
  for (const row of rows) {
    total += row.trust_score;
    min = Math.min(min, row.trust_score);
    const action = trustAction(row.trust_band, policy);
    action_counts[action] = (action_counts[action] || 0) + 1;
    band_counts[row.trust_band] = (band_counts[row.trust_band] || 0) + 1;
  }
  return {
    claims: rows.length,
    avg: rows.length ? round4(total / rows.length) : 0,
    min: round4(min),
    bands: band_counts,
    actions: action_counts,
    needs_evidence: (action_counts.verify || 0) + (action_counts.limit || 0) + (action_counts.exclude || 0)
  };
}

function topKByScore(items, k) {
  if (k <= 0) return [];
  const top = [];
  for (const item of items) {
    if (top.length < k) {
      top.push(item);
      if (top.length === k) top.sort((a, b) => a.score - b.score);
      continue;
    }
    if (item.score > top[0].score) {
      top[0] = item;
      top.sort((a, b) => a.score - b.score);
    }
  }
  return top.sort((a, b) => b.score - a.score);
}

export function selectClaims(mission, claims, budget = {}) {
  const maxClaims = Math.max(0, budget.maxClaims ?? 12);
  const trustPolicy = budget.trustPolicy || DEFAULT_TRUST_POLICY;
  const scored = (claims || []).map((claim) => ({ claim, score: claimScore(mission, claim) }));
  const selected = [];
  const selectedIds = new Set();
  const required = scored
    .filter((x) => Number(x.claim.required_weight) > 0)
    .sort((a, b) => (Number(b.claim.required_weight) - Number(a.claim.required_weight)) || b.score - a.score);
  for (const item of required) {
    if (selected.length >= maxClaims) break;
    selected.push(item);
    selectedIds.add(item.claim.id);
  }
  const fill = topKByScore(scored.filter((x) => !selectedIds.has(x.claim.id)), maxClaims - selected.length);
  return [...selected, ...fill]
    .sort((a, b) => (Number(b.claim.required_weight || 0) - Number(a.claim.required_weight || 0)) || b.score - a.score)
    .map((x) => withTrust({ ...x.claim, triwiki_score: Number(x.score.toFixed(4)) }, trustPolicy));
}

export function geometricOffsets(max = 65536) {
  const out = [];
  for (let x = 1; x <= max; x *= 2) out.push(x);
  return out;
}

export function contextCapsule({ mission, role = 'worker', contractHash = null, claims = [], q4 = {}, q3 = [], budget = {} }) {
  const trustPolicy = budget.trustPolicy || DEFAULT_TRUST_POLICY;
  const claimsWithTrust = (claims || []).map((claim) => withTrust(claim, trustPolicy));
  const selected = selectClaims(mission, claims, { maxClaims: budget.maxClaims ?? (role.includes('verifier') ? 16 : 9), trustPolicy });
  const fullWiki = buildWikiCoordinateIndex({
    mission,
    claims: claimsWithTrust,
    q4,
    q3,
    maxAnchors: budget.maxWikiAnchors ?? (role.includes('verifier') ? 16 : 7)
  });
  const wiki = budget.verboseWiki ? fullWiki : compactWikiCoordinateIndex(fullWiki);
  const anchorRows = Array.isArray(wiki.a) ? wiki.a : [];
  const anchorsById = new Map((wiki.anchors || []).map((anchor) => [anchor.id, anchor]));
  for (const row of anchorRows) anchorsById.set(row[0], { id: row[0], rgba: row[1], c: row[2], h: row[7] });
  return {
    mission: mission.id,
    role,
    contract_hash: contractHash,
    token_policy: 'Q4_Q3_DEFAULT_WITH_RGBA_TRIG_WIKI_ANCHORS_Q2_Q1_HYDRATED_ON_DEMAND',
    ...(budget.includeTrustSummary ? { trust_summary: trustSummary(selected, trustPolicy) } : {}),
    q4,
    q3,
    wiki,
    claims: selected.map((c) => {
      const anchor = anchorsById.get(c.id);
      return {
        id: c.id,
        text: c.text,
        status: c.status,
        risk: c.risk,
        source: c.source,
        score: c.triwiki_score,
        rgba: anchor?.rgba,
        h: anchor?.h
      };
    })
  };
}
