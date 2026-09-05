import path from 'node:path';
import { exists, readJson, readText, sha256, writeJsonAtomic, type JsonData } from '../fsx.js';
import { detectProject, discoverSiteInventory } from './discovery.js';
import { createSearchVisibilityMission, resolveSearchVisibilityMission, routeForMode, type SearchVisibilityMission } from './mission.js';
import { runSuperSearch } from '../super-search/index.js';
import { evaluateMarketingTruthfulness } from './marketing-truthfulness.js';
import type {
  MarketingClaim,
  MarketingResearch,
  MarketingSource,
  MarketingStrategy,
  ProjectContext,
  SearchVisibilityCliOptions,
  SearchVisibilityMode,
  SiteInventory,
} from './types.js';

const INTERNAL_SOURCE_CANDIDATES = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'src/core/routes.ts',
  'src/core/routes/dollar-manifest-lite.ts',
  'src/core/agents/agent-orchestrator.ts',
  'src/cli/command-manifest-lite.ts',
  'config/perf-budgets.v1.json',
  '.sneakoscope/reports/perf-budget.json',
  '.sneakoscope/reports/super-search-local-http-smoke.json',
  '.sneakoscope/reports/installed-package-smoke.json',
];

const EXTERNAL_SOURCE_URLS = [
  'https://github.com/mandarange/Sneakoscope-Codex',
  'https://www.npmjs.com/package/sneakoscope',
];

const COMPETITOR_SOURCE_URLS = [
  'https://github.com/Yeachan-Heo/oh-my-codex',
  'https://github.com/code-yeongyu/lazycodex',
  'https://www.npmjs.com/package/oh-my-codex',
  'https://www.npmjs.com/package/lazycodex-ai',
];

export async function runMarketingResearch(
  mode: SearchVisibilityMode,
  missionRef: string | null,
  options: SearchVisibilityCliOptions
): Promise<JsonData> {
  const mission = await resolveOrCreateMarketingMission(mode, missionRef, options, 'marketing research');
  const ctx = context(mode, mission.root, options);
  const detected = await detectProject(ctx);
  const inventory = await discoverSiteInventory(ctx, detected);
  await writeJsonAtomic(path.join(mission.artifactDir, 'site-inventory.json'), inventory);

  const internalSources = await collectInternalSources(mission.root);
  const externalSources = options.offline
    ? []
    : await collectSuperSearchSources(mission, EXTERNAL_SOURCE_URLS, 'external', options.maxMarketingSources);
  const competitorSources = !options.offline && options.includeCompetitors
    ? await collectSuperSearchSources(mission, COMPETITOR_SOURCE_URLS, 'competitor', options.maxMarketingSources)
    : [];
  const claims = buildMarketingClaims(inventory, internalSources, externalSources);
  const truth = evaluateMarketingTruthfulness({ claims });
  const blockedClaims = claims.filter((claim) => !claim.publishable || claim.blockers.length || truth.unsupported_claims.includes(claim.id));
  const blockers = [...truth.blockers];
  if (!internalSources.length) blockers.push('marketing_internal_sources_missing');
  if (!options.offline && !externalSources.some((source) => source.verified)) blockers.push('marketing_external_sources_unverified');

  const research: MarketingResearch = {
    schema: 'sks.search-visibility.marketing-research.v1',
    ok: blockers.length === 0,
    mission_id: mission.id,
    internal_sources: internalSources,
    external_sources: externalSources,
    competitor_sources: competitorSources,
    claims,
    blocked_claims: blockedClaims,
    blockers,
  };
  await writeJsonAtomic(path.join(mission.artifactDir, 'marketing-research.json'), research);
  await writeJsonAtomic(path.join(mission.artifactDir, 'marketing-source-ledger.json'), {
    schema: 'sks.search-visibility.marketing-source-ledger.v1',
    mission_id: mission.id,
    sources: [...internalSources, ...externalSources, ...competitorSources],
  });
  await writeJsonAtomic(path.join(mission.artifactDir, 'marketing-claim-ledger.json'), {
    schema: 'sks.search-visibility.marketing-claim-ledger.v1',
    mission_id: mission.id,
    claims,
    blocked_claims: blockedClaims,
  });
  await writeJsonAtomic(path.join(mission.dir, 'marketing-research-gate.json'), {
    schema: 'sks.search-visibility.marketing-research-gate.v1',
    ok: research.ok,
    passed: research.ok,
    mission_id: mission.id,
    route: routeForMode(mode),
    truthfulness_gate: truth,
    blockers,
  });
  return {
    schema: 'sks.search-visibility.marketing-research-command.v1',
    ok: research.ok,
    mission_id: mission.id,
    route: routeForMode(mode),
    status: research.ok ? 'verified_partial' : 'blocked',
    artifacts_dir: `.sneakoscope/missions/${mission.id}/search-visibility`,
    internal_sources: internalSources.length,
    external_sources: externalSources.length,
    competitor_sources: competitorSources.length,
    claims: claims.length,
    blocked_claims: blockedClaims.length,
    blockers,
  };
}

export async function runMarketingStrategy(
  mode: SearchVisibilityMode,
  missionRef: string | null,
  options: SearchVisibilityCliOptions
): Promise<JsonData> {
  const mission = await resolveSearchVisibilityMission(options.root, missionRef || options.strategyRef || 'latest', mode);
  if (!mission) return blockedStrategy(null, ['marketing_research_mission_missing']);
  const research = await readJson<MarketingResearch | null>(path.join(mission.artifactDir, 'marketing-research.json'), null);
  if (!research) return blockedStrategy(mission, ['marketing_research_required_for_strategy']);
  if (!research.ok) return blockedStrategy(mission, ['marketing_research_gate_not_passed', ...research.blockers]);
  const inventory = await readJson<SiteInventory | null>(path.join(mission.artifactDir, 'site-inventory.json'), null);
  if (!inventory) return blockedStrategy(mission, ['site_inventory_required_for_strategy']);
  const strategy = buildMarketingStrategy(mission.id, inventory, research);
  const truth = evaluateMarketingTruthfulness({ strategy });
  const strategy_quality = scoreMarketingStrategy(strategy, truth);
  const blockers = [...strategy.blockers, ...truth.blockers, ...strategy_quality.blockers];
  const finalStrategy: MarketingStrategy = { ...strategy, strategy_quality, ok: blockers.length === 0, blockers };
  await writeJsonAtomic(path.join(mission.artifactDir, 'marketing-strategy.json'), finalStrategy);
  await writeJsonAtomic(path.join(mission.artifactDir, 'marketing-truthfulness-gate.json'), {
    ...truth,
    ok: blockers.length === 0,
    blockers,
  });
  await writeJsonAtomic(path.join(mission.dir, 'seo-marketing-strategy-gate.json'), {
    schema: 'sks.search-visibility.marketing-strategy-gate.v1',
    ok: finalStrategy.ok,
    passed: finalStrategy.ok,
    mission_id: mission.id,
    route: routeForMode(mode),
    truthfulness_gate: truth,
    blockers,
  });
  return {
    schema: 'sks.search-visibility.marketing-strategy-command.v1',
    ok: finalStrategy.ok,
    mission_id: mission.id,
    route: routeForMode(mode),
    status: finalStrategy.ok ? 'verified_partial' : 'blocked',
    strategy: 'search-visibility/marketing-strategy.json',
    blockers,
  };
}

export async function readMarketingStrategyForPlan(artifactDir: string): Promise<MarketingStrategy | null> {
  return readJson<MarketingStrategy | null>(path.join(artifactDir, 'marketing-strategy.json'), null);
}

function buildMarketingStrategy(missionId: string, inventory: SiteInventory, research: MarketingResearch): MarketingStrategy {
  const sources = [...research.internal_sources, ...research.external_sources];
  const sourceIds = sources.filter((source) => source.verified).map((source) => source.id);
  const packageSource = sourceIds.find((id) => id.includes('package-json')) || sourceIds[0] || '';
  const readmeSource = sourceIds.find((id) => id.includes('readme')) || packageSource;
  const perfSource = sourceIds.find((id) => id.includes('perf-budget') || id.includes('perf'));
  const parallelSource = sourceIds.find((id) => id.includes('agent-orchestrator') || id.includes('naruto'));
  const superSearchSource = sourceIds.find((id) => id.includes('super-search'));
  const oneLiner = `${inventory.package.name || 'Sneakoscope'} is a proof-first Codex trust layer for bounded agent workflows, search visibility, and evidence-backed release gates.`;
  const strategySources = unique([packageSource, readmeSource, superSearchSource, parallelSource, perfSource].filter(Boolean) as string[]);
  const competitorContrast = buildCompetitorContrast(research, strategySources);
  const keywords = unique([
    'sneakoscope',
    'codex',
    'sks',
    'codex-cli',
    'codex-app',
    'agent-orchestration',
    'proof-gates',
    ...(superSearchSource ? ['super-search'] : []),
    'seo',
    'generative-engine-optimization',
    'bounded-memory',
    'rollback',
    'release-integrity',
  ]).slice(0, 20);
  const messagePillars = [
    { title: 'Proof-first route gates', claim: 'SKS records route artifacts, blockers, and release gates so Codex workflows can separate verified work from unverified claims.', source_ids: [readmeSource || packageSource].filter(Boolean) },
    ...(superSearchSource ? [{ title: 'Source-backed search visibility', claim: 'Super-Search and SEO/GEO artifacts keep source ledgers and claim ledgers attached to search visibility work.', source_ids: [superSearchSource] }] : []),
    ...(parallelSource ? [{ title: 'Bounded parallel implementation', claim: 'The Naruto agent orchestrator runs bounded multi-agent coding workflows.', source_ids: [parallelSource] }] : []),
    ...(perfSource ? [{ title: 'Measured fast paths', claim: 'Performance budget reports define p95 budgets for selected SKS fast-path commands.', source_ids: [perfSource] }] : []),
  ];
  const strategy: MarketingStrategy = {
    schema: 'sks.search-visibility.marketing-strategy.v1',
    ok: true,
    mission_id: missionId,
    positioning: {
      one_liner: oneLiner,
      source_ids: [packageSource || readmeSource].filter(Boolean),
    },
    message_pillars: messagePillars,
    keyword_clusters: [
      { name: 'codex trust layer', keywords: keywords.slice(0, 7), source_ids: [packageSource || readmeSource].filter(Boolean) },
      { name: 'agent release integrity', keywords: keywords.slice(7, 14), source_ids: [readmeSource || packageSource].filter(Boolean) },
      { name: 'search visibility', keywords: keywords.slice(7, 11), source_ids: [superSearchSource || packageSource].filter(Boolean) },
    ],
    strategy_quality: {
      score: 0,
      source_backed_claims: 0,
      unsupported_claims: 0,
      competitor_contrast_count: competitorContrast.length,
      keyword_cluster_count: 3,
      blockers: [],
    },
    competitor_contrast: competitorContrast,
    readme_plan: [{
      operation: 'readme-positioning-block-update',
      text: [
        '<!-- BEGIN SKS MARKETING POSITIONING -->',
        '## Search Visibility Positioning',
        '',
        oneLiner,
        '',
        '- Source-ledger claims are kept in SKS marketing research and strategy artifacts.',
        '- SEO/GEO mutation plans update only package metadata and this managed README block in this release.',
        '- External visibility outcomes require separate measured evidence.',
        '<!-- END SKS MARKETING POSITIONING -->',
        '',
      ].join('\n'),
      source_ids: strategySources,
    }],
    package_plan: [
      {
        operation: 'package-description-update',
        description: 'Proof-first Codex trust layer for bounded agent workflows, search visibility evidence, and release integrity gates.',
        source_ids: strategySources,
      },
      {
        operation: 'package-keywords-update',
        keywords,
        source_ids: strategySources,
      },
    ],
    docs_plan: [
      { title: 'Document marketing claim sources and prohibited guarantees in release notes.', source_ids: [readmeSource || packageSource].filter(Boolean), auto_apply: false },
    ],
    do_not_claim: [
      'guaranteed ranking',
      'guaranteed traffic',
      'guaranteed AI citation',
      'best or fastest Codex tool',
      'competitor disparagement',
    ],
    blockers: [],
  };
  for (const pillar of strategy.message_pillars) {
    if (!pillar.source_ids.length) strategy.blockers.push(`pillar_source_missing:${pillar.title}`);
  }
  for (const plan of strategy.package_plan) {
    if (!plan.source_ids.length) strategy.blockers.push(`package_plan_source_missing:${plan.operation}`);
  }
  if (strategy.positioning.source_ids.length === 0) strategy.blockers.push('positioning_source_missing');
  return strategy;
}

function buildCompetitorContrast(research: MarketingResearch, strategySources: string[]): MarketingStrategy['competitor_contrast'] {
  return research.competitor_sources
    .filter((source) => source.verified)
    .map((source) => ({
      competitor: source.title,
      their_claim: source.summary,
      sks_contrast: 'SKS positions itself around proof-first release integrity and source-backed search visibility, while workflow-first Codex layers emphasize orchestration convenience.',
      source_ids: unique([source.id, ...strategySources]),
      safe_to_publish: true,
    }));
}

function scoreMarketingStrategy(strategy: MarketingStrategy, truth: ReturnType<typeof evaluateMarketingTruthfulness>): MarketingStrategy['strategy_quality'] {
  const blockers: string[] = [];
  let score = 0;
  const sourceBackedClaims = countSourceBackedStrategyClaims(strategy);

  if (strategy.positioning.source_ids.length) score += 20;
  else blockers.push('strategy_quality_source_backed_positioning_missing');
  if (strategy.message_pillars.length >= 3 && strategy.message_pillars.every((pillar) => pillar.source_ids.length)) score += 20;
  else blockers.push('strategy_quality_message_pillars_below_threshold');
  if (strategy.keyword_clusters.length >= 2 && strategy.keyword_clusters.every((cluster) => cluster.source_ids.length)) score += 15;
  else blockers.push('strategy_quality_keyword_clusters_below_threshold');
  if (strategy.competitor_contrast.every((contrast) => contrast.safe_to_publish && contrast.source_ids.length)) score += 15;
  else blockers.push('strategy_quality_competitor_contrast_unsafe');
  if (truth.forbidden_phrases.length === 0) score += 15;
  else blockers.push('strategy_quality_forbidden_phrases_present');
  if (hasSupportedSpecialClaim(strategy, /p95|latency|performance|fast/i, /perf|budget|report/i)
    && hasSupportedSpecialClaim(strategy, /parallel|worker|naruto/i, /parallel|naruto|agent|report|routes/i)
    && hasSupportedSpecialClaim(strategy, /super-search|source-backed|source backed/i, /super-search|source|report/i)) {
    score += 15;
  } else {
    blockers.push('strategy_quality_special_claim_sources_missing');
  }
  if (score < 80) blockers.push('strategy_quality_score_below_80');
  if (truth.unsupported_claims.length) blockers.push('strategy_quality_unsupported_claims_present');
  if (truth.source_less_publishable_claims.length) blockers.push('strategy_quality_source_less_publishable_claims_present');

  return {
    score,
    source_backed_claims: sourceBackedClaims,
    unsupported_claims: truth.unsupported_claims.length,
    competitor_contrast_count: strategy.competitor_contrast.length,
    keyword_cluster_count: strategy.keyword_clusters.length,
    blockers: unique(blockers),
  };
}

function countSourceBackedStrategyClaims(strategy: MarketingStrategy): number {
  return [
    strategy.positioning,
    ...strategy.message_pillars,
    ...strategy.keyword_clusters,
    ...strategy.readme_plan,
    ...strategy.package_plan,
    ...strategy.docs_plan,
    ...strategy.competitor_contrast,
  ].filter((item) => item.source_ids.length > 0).length;
}

function hasSupportedSpecialClaim(strategy: MarketingStrategy, textPattern: RegExp, sourcePattern: RegExp): boolean {
  const candidates = [
    ...strategy.message_pillars.map((pillar) => ({ text: pillar.claim, source_ids: pillar.source_ids })),
    ...strategy.readme_plan.map((plan) => ({ text: plan.text, source_ids: plan.source_ids })),
    ...strategy.package_plan.map((plan) => ({
      text: plan.operation === 'package-description-update' ? plan.description : plan.keywords.join(', '),
      source_ids: plan.source_ids,
    })),
  ];
  return candidates.some((candidate) => textPattern.test(candidate.text) && candidate.source_ids.some((id) => sourcePattern.test(id)));
}

async function resolveOrCreateMarketingMission(
  mode: SearchVisibilityMode,
  missionRef: string | null,
  options: SearchVisibilityCliOptions,
  prompt: string
): Promise<SearchVisibilityMission> {
  const explicit = missionRef && missionRef !== 'latest' ? await resolveSearchVisibilityMission(options.root, missionRef, mode) : null;
  if (explicit) return explicit;
  if (missionRef === 'latest') {
    const latest = await resolveSearchVisibilityMission(options.root, 'latest', mode);
    if (latest) return latest;
  }
  return createSearchVisibilityMission(mode, prompt, options);
}

async function collectInternalSources(root: string): Promise<MarketingSource[]> {
  const out: MarketingSource[] = [];
  for (const rel of INTERNAL_SOURCE_CANDIDATES) {
    const full = path.join(root, rel);
    if (!(await exists(full))) continue;
    const text = await readText(full, '');
    out.push({
      id: sourceId(rel),
      kind: 'internal',
      path: rel,
      url: null,
      title: rel,
      summary: summarizeSource(rel, text),
      sha256: sha256(text),
      verified: true,
      observed_at: new Date().toISOString(),
      blockers: [],
    });
  }
  return out;
}

async function collectSuperSearchSources(
  mission: SearchVisibilityMission,
  urls: string[],
  kind: 'external' | 'competitor',
  maxSources: number
): Promise<MarketingSource[]> {
  const selected = urls.slice(0, Math.max(1, maxSources || urls.length));
  const out: MarketingSource[] = [];
  for (const url of selected) {
    const result = await runSuperSearch({
      missionDir: mission.dir,
      query: url,
      mode: 'url_acquisition',
      env: { SKS_DISABLE_UPDATE_CHECK: '1' },
    }).catch((error: unknown) => ({
      ok: false,
      blockers: [error instanceof Error ? error.message : String(error)],
      sources: [],
    }));
    const verified = Array.isArray(result.sources) ? result.sources.find((source: any) => source.acquisition_verdict === 'verified_content') : null;
    out.push({
      id: sourceId(url),
      kind,
      path: verified?.content_artifact || null,
      url,
      title: verified?.title || url,
      summary: verified?.snippet || `Super-Search source for ${url}`,
      sha256: verified?.content_sha256 || null,
      verified: Boolean(result.ok && verified),
      observed_at: new Date().toISOString(),
      blockers: result.ok && verified ? [] : (Array.isArray(result.blockers) ? result.blockers.map(String) : ['super_search_source_unverified']),
    });
  }
  return out;
}

function buildMarketingClaims(inventory: SiteInventory, internalSources: MarketingSource[], externalSources: MarketingSource[]): MarketingClaim[] {
  const packageSource = internalSources.find((source) => source.path === 'package.json');
  const readmeSource = internalSources.find((source) => source.path === 'README.md');
  const perfSource = internalSources.find((source) => source.path?.includes('perf-budget'));
  const superSearchSource = internalSources.find((source) => source.path?.includes('super-search-local-http-smoke')) || externalSources.find((source) => source.verified);
  const claims: MarketingClaim[] = [];
  if (inventory.package.name) claims.push(publishableClaim('pkg-name', `${inventory.package.name} is the package name published in package metadata.`, 'identity', [packageSource?.id]));
  if (inventory.package.description) claims.push(publishableClaim('pkg-description', inventory.package.description, 'capability', [packageSource?.id]));
  if (readmeSource) claims.push(publishableClaim('readme-positioning', `README describes ${inventory.readme.h1 || inventory.package.name || 'the project'} and its SKS command surfaces.`, 'positioning', [readmeSource.id]));
  if (perfSource) claims.push(publishableClaim('perf-budget-source', 'Performance budget artifacts define command p95 budgets for release gates.', 'performance', [perfSource.id]));
  if (superSearchSource) claims.push(publishableClaim('super-search-source-backed', 'Super-Search artifacts provide source ledgers for search visibility evidence.', 'super_search', [superSearchSource.id]));
  return claims;
}

function publishableClaim(id: string, text: string, claimType: MarketingClaim['claim_type'], sourceIds: Array<string | undefined>): MarketingClaim {
  const source_ids = sourceIds.filter(Boolean) as string[];
  return {
    id,
    text,
    claim_type: claimType,
    source_ids,
    publishable: source_ids.length > 0,
    blockers: source_ids.length ? [] : ['source_ids_required'],
  };
}

function blockedStrategy(mission: SearchVisibilityMission | null, blockers: string[]): JsonData {
  return {
    schema: 'sks.search-visibility.marketing-strategy-command.v1',
    ok: false,
    mission_id: mission?.id || null,
    route: '$SEO-GEO-OPTIMIZER',
    status: 'blocked',
    blockers,
  };
}

function context(mode: SearchVisibilityMode, root: string, options: SearchVisibilityCliOptions): ProjectContext {
  return {
    root,
    mode,
    target: options.target,
    framework: options.framework,
    origin: options.url,
    offline: options.offline,
    strict: options.strict,
  };
}

function sourceId(value: string): string {
  return value.toLowerCase().replace(/https?:\/\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'source';
}

function summarizeSource(rel: string, text: string): string {
  if (rel.endsWith('.json')) return `${rel} JSON source (${Buffer.byteLength(text, 'utf8')} bytes)`;
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) || rel;
  return firstLine.replace(/^#+\s*/, '').trim().slice(0, 240);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
