export type SearchVisibilityMode = 'seo' | 'geo';
export type SearchVisibilityRoute = '$SEO-GEO-OPTIMIZER';
export type SearchVisibilityTarget = 'auto' | 'website' | 'docs' | 'package';
export type SearchVisibilityResolvedTarget = Exclude<SearchVisibilityTarget, 'auto'>;
export type SearchVisibilityFramework = 'auto' | 'next-app' | 'next-pages' | 'static' | 'package' | 'unsupported';
export type SearchVisibilityStatus =
  | 'prepared'
  | 'audited'
  | 'planned'
  | 'applied'
  | 'audit_only'
  | 'locally_verified'
  | 'production_verified'
  | 'verified_partial'
  | 'blocked'
  | 'measured_outcome_pending'
  | 'measured_outcome_recorded';
export type VerificationLevel =
  | 'implemented'
  | 'locally_verified'
  | 'production_verified'
  | 'measured_outcome';

export interface SearchVisibilityCliOptions {
  root: string;
  url: string | null;
  target: SearchVisibilityTarget;
  framework: SearchVisibilityFramework;
  offline: boolean;
  strict: boolean;
  json: boolean;
  apply: boolean;
  yes: boolean;
  allowDirtyTouched: boolean;
  browser: boolean;
  includeLlmsTxt: boolean;
  includeMarketing: boolean;
  includeCompetitors: boolean;
  strategyRef: string | null;
  maxMarketingSources: number;
  observeQueries: boolean;
  queryFile: string | null;
  scope: string[];
}

export interface SearchVisibilityCapabilities {
  sourceAudit: boolean;
  builtHtmlAudit: boolean;
  liveHttpAudit: boolean;
  renderedBrowserAudit: boolean;
  metadataMutation: boolean;
  sitemapMutation: boolean;
  robotsMutation: boolean;
  structuredDataMutation: boolean;
  localeMutation: boolean;
}

export interface EvidenceRef {
  type: 'source' | 'built_html' | 'http' | 'rendered_dom' | 'official_source' | 'user_fact' | 'generated_artifact';
  path: string | null;
  line: number | null;
  selector: string | null;
  hash: string | null;
  url: string | null;
  observed_at: string;
  summary: string;
}

export interface DetectionResult {
  adapterId: string;
  confidence: number;
  evidence: Array<{ path: string; reason: string }>;
  capabilities: SearchVisibilityCapabilities;
  blockers: string[];
}

export interface ProjectContext {
  root: string;
  mode: SearchVisibilityMode;
  target: SearchVisibilityTarget;
  framework: SearchVisibilityFramework;
  origin: string | null;
  offline: boolean;
  strict: boolean;
}

export interface SiteInventory {
  schema: 'sks.search-visibility.site-inventory.v1';
  root: string;
  origin: string | null;
  target: SearchVisibilityResolvedTarget;
  detected_adapter: DetectionResult;
  package: {
    path: string | null;
    name: string | null;
    version: string | null;
    description: string | null;
    keywords: string[];
    repository: string | null;
    homepage: string | null;
    bugs: string | null;
    bin: string[];
    scripts: Record<string, string>;
    framework_versions: Record<string, string>;
  };
  readme: {
    path: string | null;
    h1: string | null;
    headings: string[];
    command_mentions: string[];
    links: string[];
  };
  routes: SiteRoute[];
  html_files: HtmlFileSummary[];
  policy_files: PolicyFileSummary[];
  locale_candidates: LocaleCandidate[];
  metadata_helpers: string[];
  structured_data_sources: string[];
  live_url_checked: boolean;
  browser_checked: boolean;
  generated_at: string;
}

export interface SiteRoute {
  path: string;
  source: string;
  kind: 'static' | 'dynamic' | 'parameterized';
  locale: string | null;
}

export interface HtmlFileSummary {
  path: string;
  title: string | null;
  description: string | null;
  canonical: string | null;
  robots: string | null;
  lang: string | null;
  links: string[];
  jsonLdCount: number;
  jsonLdParseErrors: string[];
  visibleTextSample: string;
}

export interface PolicyFileSummary {
  path: string;
  kind: 'robots' | 'sitemap' | 'llms' | 'manifest' | 'other';
  exists: boolean;
  managed: boolean;
  hash: string | null;
}

export interface LocaleCandidate {
  code: string;
  source: string;
  confidence: number;
}

export interface Finding {
  id: string;
  ruleId: string;
  domain: 'seo' | 'geo' | 'shared';
  category: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  blocking: boolean;
  summary: string;
  evidence: EvidenceRef[];
  affected: string[];
  remediation: string;
  autoFixable: boolean;
  requiredCapability?: keyof SearchVisibilityCapabilities;
  status?: 'confirmed' | 'not_verified';
}

export interface RouteGraph {
  schema: 'sks.search-visibility.route-graph.v1';
  routes: SiteRoute[];
  canonical_edges: Array<{ from: string; to: string; source: string }>;
  internal_links: Array<{ from: string; to: string; source: string }>;
  redirects: Array<{ from: string; to: string; source: string; verified: boolean }>;
  generated_at: string;
}

export interface MutationOperation {
  id: string;
  path: string;
  baseSha256: string | null;
  proposedSha256: string;
  kind: 'create' | 'replace-range' | 'managed-merge' | 'delete-owned';
  operationType?: 'package-description-update' | 'package-keywords-update' | 'readme-positioning-block-update';
  owner: 'sks-search-visibility';
  findingIds: string[];
  reversible: boolean;
  preview: string;
  content: string | null;
  risk: 'low' | 'medium' | 'high';
  requiredVerification: string[];
  scopeAuthorization: string[];
  ownershipStrategy: string;
}

export interface MarketingSource {
  id: string;
  kind: 'internal' | 'external' | 'competitor';
  path: string | null;
  url: string | null;
  title: string;
  summary: string;
  sha256: string | null;
  verified: boolean;
  observed_at: string;
  blockers: string[];
}

export interface MarketingClaim {
  id: string;
  text: string;
  claim_type: 'identity' | 'capability' | 'performance' | 'parallel' | 'super_search' | 'positioning' | 'competitor' | 'unsupported';
  source_ids: string[];
  publishable: boolean;
  blockers: string[];
}

export interface MarketingResearch {
  schema: 'sks.search-visibility.marketing-research.v1';
  ok: boolean;
  mission_id: string;
  internal_sources: MarketingSource[];
  external_sources: MarketingSource[];
  competitor_sources: MarketingSource[];
  claims: MarketingClaim[];
  blocked_claims: MarketingClaim[];
  blockers: string[];
}

export interface MarketingStrategy {
  schema: 'sks.search-visibility.marketing-strategy.v1';
  ok: boolean;
  mission_id: string;
  positioning: {
    one_liner: string;
    source_ids: string[];
  };
  message_pillars: Array<{ title: string; claim: string; source_ids: string[] }>;
  keyword_clusters: Array<{ name: string; keywords: string[]; source_ids: string[] }>;
  strategy_quality: {
    score: number;
    source_backed_claims: number;
    unsupported_claims: number;
    competitor_contrast_count: number;
    keyword_cluster_count: number;
    blockers: string[];
  };
  competitor_contrast: Array<{
    competitor: string;
    their_claim: string;
    sks_contrast: string;
    source_ids: string[];
    safe_to_publish: boolean;
  }>;
  readme_plan: Array<{ operation: 'readme-positioning-block-update'; text: string; source_ids: string[] }>;
  package_plan: Array<
    | { operation: 'package-description-update'; description: string; source_ids: string[] }
    | { operation: 'package-keywords-update'; keywords: string[]; source_ids: string[] }
  >;
  docs_plan: Array<{ title: string; source_ids: string[]; auto_apply: false }>;
  do_not_claim: string[];
  blockers: string[];
}

export interface MarketingTruthfulnessGate {
  schema: 'sks.search-visibility.marketing-truthfulness-gate.v1';
  ok: boolean;
  unsupported_claims: string[];
  forbidden_phrases: string[];
  competitor_disparagement: string[];
  source_less_publishable_claims: string[];
  blockers: string[];
}

export interface MutationPlan {
  schema: 'sks.search-visibility.mutation-plan.v1';
  generated_at: string;
  mission_id: string;
  route: SearchVisibilityRoute;
  mode: SearchVisibilityMode;
  adapter: string;
  detection_confidence: number;
  status: 'planned' | 'blocked';
  operations: MutationOperation[];
  blockers: string[];
  unverified: string[];
}

export interface MutationJournalEvent {
  schema: 'sks.search-visibility.mutation-journal-event.v1';
  ts: string;
  operation_id: string;
  event: 'applied' | 'rolled_back' | 'blocked';
  path: string;
  before_sha256: string | null;
  after_sha256: string | null;
  message: string;
}

export interface RollbackManifest {
  schema: 'sks.search-visibility.rollback-manifest.v1';
  generated_at: string;
  mission_id: string;
  route: SearchVisibilityRoute;
  operations: Array<{
    operation_id: string;
    path: string;
    inverse: 'delete-created' | 'restore-content' | 'none';
    before_sha256: string | null;
    after_sha256: string | null;
    backup_path: string | null;
  }>;
  blockers: string[];
}

export interface VerificationResult {
  schema: 'sks.search-visibility.verification-report.v1';
  generated_at: string;
  mission_id: string;
  route: SearchVisibilityRoute;
  status: SearchVisibilityStatus;
  source_verified: boolean;
  build_verified: boolean;
  http_verified: boolean;
  browser_verified: boolean;
  production_verified: boolean;
  http_evidence: HttpVerificationEvidence;
  measured_outcome: 'pending' | 'recorded' | 'not_applicable';
  checked_artifacts: Array<{ path: string; ok: boolean; message: string }>;
  blockers: string[];
  unverified: string[];
}

export interface HttpVerificationEvidence {
  attempted: boolean;
  verified: boolean;
  requested_url: string | null;
  final_url: string | null;
  status_code: number | null;
  content_type: string | null;
  content_bytes: number | null;
  content_sha256: string | null;
  observed_at: string | null;
  error: string | null;
}

export interface SearchVisibilityGate {
  schema: 'sks.search-visibility.gate.v1';
  generated_at: string;
  mission_id: string;
  route: SearchVisibilityRoute;
  ok: boolean;
  passed: boolean;
  status: SearchVisibilityStatus;
  command_identity: boolean;
  required_artifacts: Array<{ path: string; present: boolean }>;
  unsupported_claims: string[];
  blockers: string[];
  unverified: string[];
  completion_proof: string;
}

export interface EntityFact {
  key: string;
  value: string;
  source: string;
  visible_on: string[];
  observed_at: string;
  confidence: number;
  freshness: 'stable' | 'fresh' | 'stale' | 'unknown';
}

export interface EntityFacts {
  schema: 'sks.search-visibility.entity-facts.v1';
  entity_id: string;
  type: 'Organization' | 'SoftwareApplication' | 'Product' | 'Person' | 'Article' | 'Unknown';
  canonical_name: string | null;
  canonical_url: string | null;
  facts: EntityFact[];
  conflicts: Array<{ key: string; values: string[]; sources: string[] }>;
}

export interface ClaimEvidence {
  id: string;
  claim: string;
  claim_type: 'identity' | 'capability' | 'commercial' | 'policy' | 'supporting_source';
  supporting_source: string;
  source_hash: string | null;
  visible_location: string | null;
  confidence: number;
  freshness: 'stable' | 'fresh' | 'stale' | 'unknown';
  contradiction: string | null;
  safe_to_publish: boolean;
  verification_level: VerificationLevel;
}

export interface CrawlerPolicySource {
  userAgent: string;
  provider: string;
  purpose: 'search' | 'training' | 'user_retrieval' | 'ads_validation' | 'other';
  officialSource: string;
  observedAt: string;
  expiresAt: string;
  robotsSemantics: string;
}

export interface SearchVisibilityAdapter {
  id: string;
  detect(ctx: ProjectContext): Promise<DetectionResult>;
  discover(ctx: ProjectContext, detection: DetectionResult): Promise<SiteInventory>;
  audit(ctx: ProjectContext, inventory: SiteInventory): Promise<Finding[]>;
  plan?(ctx: ProjectContext, findings: Finding[], inventory: SiteInventory): Promise<MutationOperation[]>;
  verify(ctx: ProjectContext, inventory: SiteInventory): Promise<VerificationResult>;
}
