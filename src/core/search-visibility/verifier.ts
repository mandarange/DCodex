import path from 'node:path';
import { createHash } from 'node:crypto';
import { exists } from '../fsx.js';
import { SEARCH_VISIBILITY_DIR, routeForMode } from './mission.js';
import type { HttpVerificationEvidence, ProjectContext, SearchVisibilityStatus, SiteInventory, VerificationResult } from './types.js';

const COMMON_REQUIRED = [
  'intake.json',
  'adapter-detection.json',
  'site-inventory.json',
  'route-graph.json',
  'robots-policy.json',
  'structured-data-ledger.json',
];

export async function verifySearchVisibility(
  ctx: ProjectContext,
  inventory: SiteInventory,
  mission: { id: string; dir: string; artifactDir: string } | null,
  dependencies: {
    fetch?: typeof globalThis.fetch;
    now?: () => Date;
    timeoutMs?: number;
  } = {}
): Promise<VerificationResult> {
  const route = routeForMode(ctx.mode);
  const required = [
    ...COMMON_REQUIRED,
    ctx.mode === 'seo' ? 'seo-findings.json' : 'geo-findings.json',
  ];
  const checked = mission
    ? await Promise.all(required.map(async (artifact) => {
        const file = path.join(mission.artifactDir, artifact);
        const present = await exists(file);
        return { path: path.relative(mission.dir, file).split(path.sep).join('/'), ok: present, message: present ? 'present' : 'missing' };
      }))
    : [];
  const blockers = checked.filter((item) => !item.ok).map((item) => `missing_artifact:${item.path}`);
  const httpEvidence = await verifyProductionHttp(ctx, dependencies);
  const productionVerified = httpEvidence.verified === true
    && httpEvidence.status_code !== null
    && httpEvidence.status_code >= 200
    && httpEvidence.status_code < 300
    && Boolean(httpEvidence.content_type)
    && Boolean(httpEvidence.content_sha256)
    && Boolean(httpEvidence.observed_at);
  const unverified = [
    ...(productionVerified ? [] : ['production_http_not_verified']),
    ...(httpEvidence.error ? [`production_http_verification_failed:${httpEvidence.error}`] : []),
    ...(ctx.framework === 'unsupported' ? ['framework_specific_mutation_not_verified'] : []),
    ...(ctx.mode === 'geo' ? ['external_ai_answer_observation_not_verified', 'measured_outcome_pending'] : ['search_ranking_or_traffic_outcome_not_measured']),
    ...(!ctx.strict ? ['strict_mode_not_requested'] : []),
  ];
  const status: SearchVisibilityStatus = blockers.length
    ? 'blocked'
    : productionVerified
      ? 'production_verified'
      : 'verified_partial';
  return {
    schema: 'sks.search-visibility.verification-report.v1',
    generated_at: new Date().toISOString(),
    mission_id: mission?.id || 'ad-hoc',
    route,
    status,
    source_verified: inventory.detected_adapter.capabilities.sourceAudit,
    build_verified: false,
    http_verified: productionVerified,
    browser_verified: false,
    production_verified: productionVerified,
    http_evidence: httpEvidence,
    measured_outcome: 'pending',
    checked_artifacts: checked,
    blockers,
    unverified,
  };
}

async function verifyProductionHttp(
  ctx: ProjectContext,
  dependencies: { fetch?: typeof globalThis.fetch; now?: () => Date; timeoutMs?: number }
): Promise<HttpVerificationEvidence> {
  const requestedUrl = normalizeHttpUrl(ctx.origin);
  if (ctx.offline || !requestedUrl) {
    return emptyHttpEvidence(ctx.origin, ctx.offline ? null : 'invalid_or_missing_http_origin');
  }

  const fetchImpl = dependencies.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return emptyHttpEvidence(requestedUrl, 'fetch_unavailable', true);
  const observedAt = (dependencies.now || (() => new Date()))().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 10_000);
  try {
    const response = await fetchImpl(requestedUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml;q=0.9',
        'user-agent': 'Sneakoscope-Search-Visibility-Verifier/8',
      },
    });
    const body = await response.text();
    const contentType = normalizedContentType(response.headers.get('content-type'));
    const bytes = Buffer.byteLength(body, 'utf8');
    const contentSha256 = bytes > 0 ? createHash('sha256').update(body).digest('hex') : null;
    const error = httpVerificationError(response.status, contentType, body);
    return {
      attempted: true,
      verified: error === null,
      requested_url: requestedUrl,
      final_url: response.url || requestedUrl,
      status_code: response.status,
      content_type: contentType,
      content_bytes: bytes,
      content_sha256: contentSha256,
      observed_at: observedAt,
      error,
    };
  } catch (error) {
    return {
      ...emptyHttpEvidence(requestedUrl, error instanceof Error && error.name === 'AbortError' ? 'request_timeout' : 'request_failed', true),
      observed_at: observedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeHttpUrl(origin: string | null): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function normalizedContentType(value: string | null): string | null {
  const normalized = String(value || '').split(';', 1)[0]?.trim().toLowerCase() || '';
  return normalized || null;
}

function httpVerificationError(status: number, contentType: string | null, body: string): string | null {
  if (status < 200 || status >= 300) return `http_status_${status}`;
  if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') return 'non_html_content_type';
  if (!body.trim()) return 'empty_response_body';
  if (!/(?:<!doctype\s+html|<html\b)/i.test(body)) return 'html_document_marker_missing';
  const visible = body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (visible.length < 20) return 'insufficient_html_content';
  return null;
}

function emptyHttpEvidence(requestedUrl: string | null, error: string | null, attempted = false): HttpVerificationEvidence {
  return {
    attempted,
    verified: false,
    requested_url: requestedUrl,
    final_url: null,
    status_code: null,
    content_type: null,
    content_bytes: null,
    content_sha256: null,
    observed_at: null,
    error,
  };
}

export function expectedArtifactPath(missionId: string, artifact: string): string {
  if (artifact.endsWith('-gate.json') || artifact === 'completion-proof.json') return `.sneakoscope/missions/${missionId}/${artifact}`;
  return `.sneakoscope/missions/${missionId}/${SEARCH_VISIBILITY_DIR}/${artifact}`;
}
