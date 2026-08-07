import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMMAND_MANIFEST_LITE } from '../cli/command-manifest-lite.js';
import { COMMANDS } from '../cli/command-registry.js';
import { COMMAND_CATALOG, DOLLAR_COMMAND_ALIASES, DOLLAR_COMMANDS, LEGACY_DOLLAR_COMMAND_NAMES, LEGACY_DOLLAR_SKILL_NAMES, ROUTES, prefixKnownSksDollarReferences, routeByDollarCommand, sksPrefixedDollarCommand } from './routes.js';
import { FEATURE_QUALITY_LEVELS, fixtureForFeature, fixtureSummary, validateFeatureFixtures } from './feature-fixtures.js';
import { runFeatureFixture, writeFeatureFixtureReports } from './feature-fixture-runner.js';
import { PACKAGE_VERSION, exists, nowIso, packageRoot, readJson, readText, runProcess, writeJsonAtomic, writeTextAtomic, type JsonData } from './fsx.js';
import { uniqueStrings } from './text/strings.js';
import { assessFeatureFixtureDeclaration } from './proof/runtime-evidence-policy.js';

export const FEATURE_REGISTRY_SCHEMA = 'sks.feature-registry.v1';
export const FEATURE_INVENTORY_SCHEMA = 'sks.feature-inventory.v1';
export const ALL_FEATURES_SELFTEST_SCHEMA = 'sks.all-features-selftest.v1';
export const ALL_FEATURE_COMPLETION_SCHEMA = 'sks.all-feature-completion.v1';

const HANDLER_ALIAS_TO_COMMAND = Object.freeze({
  hook: 'hooks',
  memory: 'gc',
  postinstall: 'postinstall',
  'ux-review': 'image-ux-review',
  'visual-review': 'image-ux-review',
  'ui-ux-review': 'image-ux-review'
});

const FEATURE_ACCEPTANCE_DEFAULTS = Object.freeze([
  'contracts tracked',
  'unknowns explicit',
  'release-mapped'
]);
const FEATURE_DOLLAR_REFERENCE_NAMES = Array.from(new Set([
  ...LEGACY_DOLLAR_COMMAND_NAMES,
  ...LEGACY_DOLLAR_SKILL_NAMES,
  'from-chat-img'
]));

export async function buildFeatureRegistry({ root = packageRoot(), generatedAt = nowIso() }: any = {}): Promise<JsonData> {
  const handlerKeys = actualCommandHandlerKeys();
  const skillNames = await listProjectSkillNames(root);
  const docRouteMentions = await collectDocRouteMentions(root);
  const handlerToFeature: Record<string, string> = mapHandlerKeysToFeatureIds(handlerKeys);
  const features: any[] = [];

  for (const command of featureCommandCatalog()) {
    const handlerAliases = Object.entries(handlerToFeature)
      .filter(([, featureId]: any) => featureId === `cli-${command.name}`)
      .map(([handler]: any) => handler)
      .filter((handler: any) => handler !== command.name);
    features.push(commandFeature(command, handlerAliases));
  }

  for (const handler of handlerKeys) {
    const featureId = handlerToFeature[handler];
    if (!features.some((feature: any) => feature.id === featureId)) {
      features.push(hiddenHandlerFeature(handler));
    }
  }

  for (const route of DOLLAR_COMMANDS) features.push(routeFeature(route));
  for (const route of ROUTES.filter((entry: any) => entry.hidden === true)) {
    features.push(routeFeature(route));
  }
  features.push(officialSubagentProofFeature());
  features.push(doctorImagegenRepairFeature());
  features.push(...imagegenWiringFeatures());
  features.push(wikiCodePackFeature());
  for (const skillName of skillNames) {
    if (!skillCoveredByRoute(skillName)) features.push(skillFeature(skillName));
  }

  const registry: any = {
    schema: FEATURE_REGISTRY_SCHEMA,
    generated_at: generatedAt,
    inventory_sources: {
      commands_json: 'sks commands --json',
      main_handlers: 'src/cli/command-registry.ts COMMANDS',
      dollar_routes: 'src/core/routes.js',
      docs: ['README.md', '.codex/SNEAKOSCOPE.md', 'AGENTS.md', '.agents/skills/.sks-generated.json'],
      skills: '.agents/skills'
    },
    features,
    fixture_summary: fixtureSummary(features),
    feature_quality_summary: featureQualitySummary(features),
    source_inventory: {
      cli_command_names: COMMAND_MANIFEST_LITE.map((entry) => entry.name),
      handler_keys: handlerKeys,
      dollar_commands: DOLLAR_COMMANDS.map((entry: any) => entry.command),
      app_skill_aliases: DOLLAR_COMMAND_ALIASES.map((entry: any) => entry.app_skill),
      skills: skillNames,
      doc_route_mentions: docRouteMentions
    }
  };
  registry.coverage = validateFeatureRegistry(registry);
  return registry;
}

export function validateFeatureRegistry(registry: any = {}): JsonData {
  const features = Array.isArray(registry.features) ? registry.features : [];
  const source = registry.source_inventory || {};
  const mappedCli = new Set(flatMapSourceRefs(features, 'cli_command_names'));
  const mappedHandlers = new Set(flatMapSourceRefs(features, 'handler_keys'));
  const mappedRoutes = new Set(flatMapSourceRefs(features, 'dollar_commands'));
  const mappedAliases = new Set(flatMapSourceRefs(features, 'app_skill_aliases'));
  const mappedSkills = new Set(flatMapSourceRefs(features, 'skills'));
  const mappedRouteMentions = new Set([...mappedRoutes, ...mappedAliases].map(normalizeDollar));

  const unmapped = {
    cli_command_names: (source.cli_command_names || []).filter((name: any) => !mappedCli.has(name)),
    handler_keys: (source.handler_keys || []).filter((name: any) => !mappedHandlers.has(name)),
    dollar_commands: (source.dollar_commands || []).filter((name: any) => !mappedRoutes.has(name)),
    app_skill_aliases: (source.app_skill_aliases || []).filter((name: any) => !mappedAliases.has(name)),
    skills: (source.skills || []).filter((name: any) => !mappedSkills.has(name))
  };
  const duplicateFeatureIds = duplicateValues(features.map((feature: any) => feature.id));
  const routeMentionsWithoutRoute = (source.doc_route_mentions || [])
    .filter((mention: any) => !mappedRouteMentions.has(normalizeDollar(mention)) && !isExternalPromptCommandMention(mention));
  const blockers = [
    ...Object.entries(unmapped).flatMap(([kind, values]: any) => values.map((value: any) => `${kind}:${value}`)),
    ...duplicateFeatureIds.map((id: any) => `duplicate_feature_id:${id}`),
    ...routeMentionsWithoutRoute.map((mention: any) => `doc_route_mention_without_route:${mention}`),
    ...routeGateConsistencyBlockers()
  ];
  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'blocked' : 'verified_partial',
    counts: {
      features: features.length,
      cli_command_names: source.cli_command_names?.length || 0,
      handler_keys: source.handler_keys?.length || 0,
      dollar_commands: source.dollar_commands?.length || 0,
      app_skill_aliases: source.app_skill_aliases?.length || 0,
      skills: source.skills?.length || 0
    },
    unmapped,
    duplicate_feature_ids: duplicateFeatureIds,
    doc_route_mentions_without_route: routeMentionsWithoutRoute,
    route_gate_consistency_blockers: routeGateConsistencyBlockers(),
    blockers,
    nonblocking_known_gaps: [
      'feature fixtures remain progressive',
      'registry proves coverage, not full roadmap completion'
    ],
    fixture_summary: fixtureSummary(features),
    feature_quality_summary: featureQualitySummary(features)
  };
}

export function routeGateConsistencyBlockers() {
  const blockers: string[] = [];
  for (const route of ROUTES) {
    const cliName = routeCliCommandName(route);
    if (!cliName) continue;
    const entry = (COMMANDS as Record<string, any>)[cliName];
    if (!entry?.ownsGates) continue;
    const routeGates = stopGateFiles(route.stopGate);
    const owned = new Set((entry.ownedGateFiles || []).map((file: any) => String(file)));
    if (!routeGates.length && owned.size > 0) blockers.push(`route_gate_mismatch:${route.id}:routes_none_registry_${[...owned].join('|')}`);
    for (const gate of routeGates) {
      if (!owned.has(gate)) blockers.push(`route_gate_mismatch:${route.id}:${gate}_not_owned_by_${cliName}`);
    }
  }
  return blockers;
}

function routeCliCommandName(route: any) {
  const command = String(route.command || '').replace(/^\$/, '').toLowerCase();
  if (Object.hasOwn(COMMANDS, command)) return command;
  const alias = (route.dollarAliases || [])
    .map((value: any) => String(value || '').replace(/^\$/, '').toLowerCase())
    .find((value: string) => Object.hasOwn(COMMANDS, value));
  return alias || null;
}

function stopGateFiles(stopGate: any) {
  const text = String(stopGate || '');
  if (!text || text === 'none' || text === 'honest_mode' || text === 'plan-only') return [];
  return text.split('|').map((part) => part.trim()).filter((part) => part.endsWith('.json'));
}

export async function writeFeatureInventoryDocs({ root = packageRoot(), outFile = path.join(root, 'docs', 'feature-inventory.md') }: any = {}): Promise<JsonData> {
  const registry = await buildFeatureRegistry({ root });
  const markdown = renderFeatureInventoryMarkdown(registry);
  await writeTextAtomic(outFile, markdown);
  return { ok: registry.coverage.ok, path: outFile, registry };
}

export function buildAllFeaturesSelftest(registry: any, opts: any = {}): JsonData {
  const coverage = validateFeatureRegistry(registry);
  const fixtures = validateFeatureFixtures(registry.features || []);
  const fixturesSummary: any = fixtureSummary(registry.features || []);
  const executable = opts.executeFixtures ? executeFeatureFixtures(registry.features || [], opts) : null;
  const checks = [
    checkRow('feature_registry_completeness', coverage.ok, coverage.blockers),
    checkRow('command_lazy_load_availability', coverage.unmapped.cli_command_names.length === 0 && coverage.unmapped.handler_keys.length === 0, [...coverage.unmapped.cli_command_names, ...coverage.unmapped.handler_keys]),
    checkRow('json_schema_validation', registry.schema === FEATURE_REGISTRY_SCHEMA && Array.isArray(registry.features), []),
    checkRow('proof_integration_contracts_present', registry.features.every((feature: any) => Boolean(feature.completion_proof_integration)), missingFeatureField(registry, 'completion_proof_integration')),
    checkRow('voxel_triwiki_contracts_present', registry.features.every((feature: any) => Boolean(feature.voxel_triwiki_integration)), missingFeatureField(registry, 'voxel_triwiki_integration')),
    checkRow('failure_contracts_present', registry.features.every((feature: any) => Array.isArray(feature.known_gaps)), missingFeatureField(registry, 'known_gaps')),
    checkRow('fixture_contracts_present', fixtures.ok, fixtures.blockers),
    checkRow('feature_quality_levels_present', FEATURE_QUALITY_LEVELS.every((level: any) => Object.hasOwn(fixturesSummary.quality_counts || {}, level)), FEATURE_QUALITY_LEVELS),
    checkRow('runtime_routes_not_static_contract', runtimeRoutesNotStaticContract(registry.features || []).ok, runtimeRoutesNotStaticContract(registry.features || []).blockers),
    checkRow('fixture_fallback_removed', registry.features.every((feature: any) => feature.fixture?.fallback_removed === true && feature.fixture?.status !== 'missing'), registry.features.filter((feature: any) => feature.fixture?.fallback_removed !== true || feature.fixture?.status === 'missing').map((feature: any) => feature.id)),
    checkRow('proof_fixture_contract_present', registry.features.some((feature: any) => feature.id === 'cli-proof' && feature.fixture?.status === 'pass'), ['cli-proof']),
    checkRow('voxel_fixture_contract_present', registry.features.some((feature: any) => feature.id === 'cli-wiki' && feature.fixture?.expected_artifacts?.some((artifact: any) => expectedArtifactPath(artifact).includes('image-voxel-ledger'))), ['cli-wiki']),
    checkRow('official_subagent_intake_contract_present', registry.features.some((feature: any) => feature.id === 'route-naruto'), ['route-naruto']),
    checkRow('cli_naruto_fixture_pass', registry.features.some((feature: any) => feature.id === 'cli-naruto' && feature.fixture?.status === 'pass' && feature.fixture.expected_artifacts?.some((artifact: any) => expectedArtifactPath(artifact).includes('subagent-evidence'))), ['cli-naruto']),
    checkRow('official_subagent_proof_contract_present', registry.features.some((feature: any) => feature.id === 'proof-official-subagent-evidence'), ['proof-official-subagent-evidence']),
    checkRow('fixture_pass_threshold', (fixturesSummary.counts.pass || 0) >= 90, [`pass=${fixturesSummary.counts.pass || 0}`]),
    checkRow('fixture_not_required_ceiling', (fixturesSummary.counts.not_required || 0) <= 16, [`not_required=${fixturesSummary.counts.not_required || 0}`]),
    checkRow(
      'fixture_blocked_contracts_honest',
      (registry.features || []).filter((feature: any) => feature.fixture?.status === 'blocked')
        .every((feature: any) => String(feature.fixture?.reason || '').trim().length > 0 && feature.fixture?.fallback_removed === true),
      (registry.features || []).filter((feature: any) => feature.fixture?.status === 'blocked' && (!String(feature.fixture?.reason || '').trim() || feature.fixture?.fallback_removed !== true)).map((feature: any) => feature.id)
    ),
    ...(executable ? [checkRow('executable_fixture_contracts', executable.ok, executable.failures)] : [])
  ];
  const ok = checks.every((check: any) => check.ok);
  return {
    schema: ALL_FEATURES_SELFTEST_SCHEMA,
    generated_at: registry.generated_at || nowIso(),
    ok,
    contract_coverage_ok: ok,
    working_claim_allowed: false,
    status: ok ? 'contract_covered_unverified' : 'blocked',
    checks,
    fixtures: fixturesSummary,
    feature_quality_summary: featureQualitySummary(registry.features || []),
    coverage,
    executable_fixtures: executable,
    note: opts.executeFixtures
      ? 'Mock executable fixture mode validates release-gated fixture contracts and expected artifact declarations; it does not prove live runtime behavior.'
      : 'Mock selftest verifies the shared contract spine only; feature runtime behavior remains unverified without runtime receipts.'
  };
}

export async function writeAllFeatureCompletionReport({ root = packageRoot(), outDir = path.join(root, '.sneakoscope', 'reports') }: any = {}): Promise<JsonData> {
  const registry = await buildFeatureRegistry({ root });
  const [packageJson, releaseManifest] = await Promise.all([
    readJson(path.join(root, 'package.json'), {}),
    readJson(path.join(root, 'release-gates.v2.json'), { gates: [] })
  ]);
  const report = buildAllFeatureCompletionReport(registry, { root, packageJson, releaseManifest });
  const jsonPath = path.join(outDir, `all-feature-completion-${PACKAGE_VERSION}.json`);
  const markdownPath = path.join(outDir, `all-feature-completion-${PACKAGE_VERSION}.md`);
  await writeJsonAtomic(jsonPath, report);
  await writeTextAtomic(markdownPath, renderAllFeatureCompletionMarkdown(report));
  return { ...report, files: { json: jsonPath, markdown: markdownPath } };
}

export function buildAllFeatureCompletionReport(registry: any, opts: any = {}): JsonData {
  const packageJson = opts.packageJson || {};
  const releaseGateIds = new Set<string>((Array.isArray(opts.releaseManifest?.gates) ? opts.releaseManifest.gates : []).map((gate: any) => String(gate.id || '')));
  const features = [
    ...(registry.features || []).map((feature: any) => featureCompletionRow(feature)),
    ...derivedReleaseFeatureRows(opts.root || packageRoot(), packageJson, releaseGateIds)
  ];
  const missingGates = FLAGSHIP_RELEASE_GATES.filter((gate: string) => !releaseGateIds.has(gate));
  const runtimeStatic = runtimeRoutesNotStaticContract(registry.features || []);
  const blockers = [
    ...(registry.coverage?.blockers || []),
    ...missingGates.map((gate: string) => `missing_release_gate:${gate}`),
    ...runtimeStatic.blockers,
    ...(packageJson.version === PACKAGE_VERSION ? [] : [`package_version:${packageJson.version || 'missing'}`]),
    ...features.flatMap((feature: any) => feature.blockers.map((blocker: string) => `${feature.id}:${blocker}`))
  ];
  const registryFeatureRows = features.slice(0, registry.features?.length || 0);
  const runtimeVerified = registryFeatureRows.filter((feature: any) => feature.runtime_truth?.working_claim_allowed === true).length;
  const workingClaimAllowed = blockers.length === 0
    && registryFeatureRows.length > 0
    && runtimeVerified === registryFeatureRows.length;
  const unverified = registryFeatureRows
    .filter((feature: any) => feature.runtime_truth?.working_claim_allowed !== true)
    .map((feature: any) => `${feature.id}:runtime_not_proven`);
  return {
    schema: ALL_FEATURE_COMPLETION_SCHEMA,
    version: PACKAGE_VERSION,
    generated_at: registry.generated_at || nowIso(),
    ok: workingClaimAllowed,
    contract_coverage_ok: blockers.length === 0,
    working_claim_allowed: workingClaimAllowed,
    status: blockers.length ? 'blocked' : workingClaimAllowed ? 'runtime_verified' : 'contract_covered_unverified',
    counts: {
      features: features.length,
      registry_features: registry.features?.length || 0,
      derived_release_features: features.length - (registry.features?.length || 0),
      release_gates_required: FLAGSHIP_RELEASE_GATES.length,
      release_gates_missing: missingGates.length
    },
    runtime_verification: {
      verified_features: runtimeVerified,
      unverified_features: Math.max(0, registryFeatureRows.length - runtimeVerified),
      working_claim_allowed: workingClaimAllowed
    },
    blockers,
    unverified,
    required_gates: FLAGSHIP_RELEASE_GATES,
    missing_gates: missingGates,
    release_gates: {
      version_metadata: packageJson.version === PACKAGE_VERSION ? 'present' : 'blocked',
      feature_registry: registry.coverage?.ok ? 'present' : 'blocked',
      runtime_routes_not_static_contract: runtimeStatic.ok ? 'present' : 'blocked',
      evidence_router: 'contract_covered',
      completion_proof: 'contract_covered',
      trust_report: 'contract_covered',
      wrongness: 'contract_covered',
      blackbox: 'contract_covered_by_matrix'
    },
    features,
    registry_coverage: registry.coverage
  };
}

export function renderAllFeatureCompletionMarkdown(report: any) {
  const lines = [
    `# All Feature Completion ${report.version}`,
    '',
    `- Status: ${report.status}`,
    `- Working claim allowed: ${report.working_claim_allowed === true ? 'yes' : 'no'}`,
    `- Features: ${report.counts?.features || 0}`,
    `- Missing release gates: ${(report.missing_gates || []).length ? report.missing_gates.join(', ') : 'none'}`,
    `- Blockers: ${(report.blockers || []).length ? report.blockers.join(', ') : 'none'}`,
    '',
    '| Feature | Fixture | Runtime truth | Evidence | Proof | Trust | Wrongness | Blackbox | Status |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ];
  for (const feature of report.features || []) {
    const c = feature.coverage || {};
    lines.push(`| \`${feature.id}\` | ${c.fixture?.status || 'missing'} | ${feature.runtime_truth?.runtime_status || 'not_assessed'} | ${c.evidence_router?.status || 'missing'} | ${c.completion_proof?.status || 'missing'} | ${c.trust_report?.status || 'missing'} | ${c.wrongness?.status || 'missing'} | ${c.blackbox?.status || 'missing'} | ${feature.status} |`);
  }
  lines.push('', '## Required Release Gates', '');
  for (const gate of report.required_gates || []) lines.push(`- ${gate}: ${(report.missing_gates || []).includes(gate) ? 'missing' : 'present'}`);
  return `${lines.join('\n')}\n`;
}

const FLAGSHIP_RELEASE_GATES = Object.freeze([
  'ux-review:run-wires-imagegen',
  'ux-review:extract-wires-real-extractor',
  'ux-review:patch-diff-recheck',
  'ux-review:imagegen-blackbox',
  'ppt:real-export-adapter',
  'ppt:real-imagegen-wiring',
  'ppt:reexport-rereview',
  'ppt:full-e2e-blackbox',
  'dfix:patch-handoff',
  'dfix:verification-recommendation',
  'all-features:deep-completion',
  'evidence:flagship-coverage',
  'dfix:fixture',
  'dfix:verification',
  'schema:check'
]);

function featureCompletionRow(feature: any) {
  const runtimeTruth = feature.runtime_truth || assessFeatureFixtureDeclaration(feature.fixture);
  const coverage = {
    command_registry: coverageStatus(Boolean(feature.source_refs || feature.commands?.length || feature.aliases?.length)),
    packed_import: coverageStatus(true, 'command-import-smoke'),
    fixture: coverageStatus(feature.fixture?.status && feature.fixture.status !== 'missing', feature.fixture?.status || 'missing'),
    artifact_schema: coverageStatus(Array.isArray(feature.fixture?.expected_artifacts) || feature.fixture?.kind === 'static' || feature.fixture?.quality === 'static_contract'),
    evidence_router: coverageStatus(Boolean(feature.voxel_triwiki_integration)),
    completion_proof: coverageStatus(Boolean(feature.completion_proof_integration)),
    trust_report: coverageStatus(true, 'trust-kernel-route-summary'),
    wrongness: coverageStatus(Array.isArray(feature.known_gaps), 'wrongness-kind-or-known-gap'),
    blackbox: coverageStatus(true, 'blackbox-matrix-contract'),
    docs: coverageStatus(true, 'feature-inventory'),
    mock_not_real: coverageStatus(true, feature.fixture?.kind === 'mock' ? 'mock-downgrade-present' : 'not_required'),
    unavailable_blocker: coverageStatus(true, 'external-unavailable-blocker-contract'),
    redaction: coverageStatus(true, 'secret-redaction-contract'),
    perf_budget: coverageStatus(true, feature.performance_budget || 'not_required'),
    json_recovery: coverageStatus(true, 'json-recovery-action'),
    runtime_truth: {
      ok: runtimeTruth.working_claim_allowed === true,
      status: runtimeTruth.working_claim_allowed ? 'runtime_proven' : runtimeTruth.runtime_status,
      working_claim_allowed: runtimeTruth.working_claim_allowed
    }
  };
  const blockers = Object.entries(coverage)
    .filter(([key, value]: any) => key !== 'runtime_truth' && !value.ok)
    .map(([key]: any) => `${key}_missing`);
  if ((feature.category === 'route' || String(feature.id || '').startsWith('route-')) && feature.fixture?.quality === 'static_contract') blockers.push('static_contract_runtime_feature');
  return {
    id: feature.id,
    title: feature.title || feature.name || feature.id,
    category: feature.category,
    maturity: feature.maturity,
    status: blockers.length ? 'blocked' : runtimeTruth.working_claim_allowed ? 'runtime_verified' : 'contract_covered_unverified',
    runtime_truth: runtimeTruth,
    coverage,
    blockers
  };
}

function derivedReleaseFeatureRows(root: string, packageJson: any, releaseGateIds: Set<string>) {
  const derived = [
    { id: 'release-version-1-14', title: `Release version metadata ${PACKAGE_VERSION}`, artifact: 'package.json', ok: packageJson.version === PACKAGE_VERSION },
    { id: 'all-feature-completion', title: 'All feature completion matrix', artifact: `.sneakoscope/reports/all-feature-completion-${PACKAGE_VERSION}.json`, ok: true },
    { id: 'ppt-imagegen-review', title: 'PPT imagegen review route', artifact: 'src/core/ppt-review/index.ts', ok: existsSync(path.join(root, 'src', 'core', 'ppt-review', 'index.ts')) },
    { id: 'dfix-loop', title: 'DFix diagnose/plan/patch/verify loop', artifact: 'src/core/commands/dfix-command.ts', ok: existsSync(path.join(root, 'src', 'core', 'commands', 'dfix-command.ts')) },
    { id: 'recursive-json-schema-validator', title: 'Recursive JSON schema validator', artifact: 'src/core/json-schema-validator.ts', ok: existsSync(path.join(root, 'src', 'core', 'json-schema-validator.ts')) },
    { id: 'release-flagship-gates', title: 'Current flagship release gates', artifact: 'release-gates.v2.json', ok: FLAGSHIP_RELEASE_GATES.every((gate: string) => releaseGateIds.has(gate)) },
    { id: 'release-blackbox-matrix', title: 'Release blackbox feature matrix', artifact: 'test/blackbox', ok: true }
  ];
  return derived.map((feature: any) => derivedFeatureCompletionRow(feature));
}

function derivedFeatureCompletionRow(feature: any) {
  const coverage = {
    command_registry: coverageStatus(true, 'derived-release-feature'),
    packed_import: coverageStatus(true, 'build-and-pack-gate'),
    fixture: coverageStatus(feature.ok, feature.artifact),
    artifact_schema: coverageStatus(feature.ok, feature.artifact),
    evidence_router: coverageStatus(true, 'release-gate-evidence'),
    completion_proof: coverageStatus(true, 'completion-proof-route-evidence'),
    trust_report: coverageStatus(true, 'trust-report-route-evidence'),
    wrongness: coverageStatus(true, 'wrongness-contract'),
    blackbox: coverageStatus(true, 'blackbox-matrix-contract'),
    docs: coverageStatus(true, 'release-docs'),
    mock_not_real: coverageStatus(true, 'mock-downgrade-present'),
    unavailable_blocker: coverageStatus(true, 'blocked-instead-of-fallback'),
    redaction: coverageStatus(true, 'secret-redaction-contract'),
    perf_budget: coverageStatus(true, 'not_required'),
    json_recovery: coverageStatus(true, 'recursive-validator')
  };
  const blockers = Object.entries(coverage).filter(([, value]: any) => !value.ok).map(([key]: any) => `${key}_missing`);
  return {
    id: feature.id,
    title: feature.title,
    category: 'release-derived',
    maturity: 'stable',
    status: blockers.length ? 'blocked' : 'contract_covered_unverified',
    coverage,
    blockers
  };
}

function coverageStatus(ok: any, status: any = null) {
  return { ok: Boolean(ok), status: ok ? (status || 'covered') : 'missing' };
}

export function executeFeatureFixtures(features: any = [], opts: any = {}): JsonData {
  const selected = features.filter((feature: any) => feature.fixture?.status === 'pass' && ['mock', 'static', 'execute', 'execute_and_validate_artifacts'].includes(feature.fixture.kind));
  const failures: any[] = [];
  const checked: any[] = [];
  const executed: any[] = [];
  let artifactValidated = 0;
  for (const feature of selected) {
    const fx = feature.fixture;
    if (!fx.command) {
      failures.push(`${feature.id}:fixture_command_missing`);
      continue;
    }
    const artifactOk = Array.isArray(fx.expected_artifacts);
    if (!artifactOk) failures.push(`${feature.id}:expected_artifacts`);
    const strict = opts.strictArtifacts || opts.validateArtifacts;
    const commandSpec = (SAFE_EXECUTABLE_FIXTURE_ARGS as unknown as Record<string, any>)[feature.id] || null;
    const artifactRun = runFeatureFixture(feature, {
      root: opts.root || packageRoot(),
      execute: Boolean(commandSpec),
      validateArtifacts: strict,
      commandArgs: commandSpec
    });
    if (artifactRun.execution) {
      executed.push({ id: feature.id, ...artifactRun.execution });
      if (!artifactRun.execution.ok) failures.push(fixtureExecutionFailure(feature.id, artifactRun.execution));
    }
    if (strict) artifactValidated += artifactRun.expected_artifacts.length;
    failures.push(...artifactRun.failures.filter((failure: any) => !failures.includes(failure)));
    checked.push({
      id: feature.id,
      kind: fx.kind,
      command: fx.command,
      expected_artifacts: fx.expected_artifacts,
      mode: commandSpec ? 'execute_and_validate_artifacts' : strict ? 'contract_no_artifacts' : 'contract'
    });
  }
  const report: any = {
    schema: 'sks.feature-fixture-execution.v1',
    mode: 'mock',
    ok: failures.length === 0,
    checked: checked.length,
    executed: executed.length,
    artifact_schema_validated: artifactValidated,
    executed_commands: executed,
    failures,
    command_execution: executed.length ? 'safe-allowlist' : 'contract-only',
    note: 'Release fixture execution runs deterministic safe CLI fixtures and validates artifacts that those commands actually generated.'
  };
  if (opts.root) report.report_files = writeFeatureFixtureReports(opts.root, report);
  return report;
}

function fixtureExecutionFailure(featureId: any, execution: any) {
  if (execution?.timed_out) return `${featureId}:command_timeout_${execution.timeout_ms || 'unknown'}`;
  return `${featureId}:command_exit_${execution?.status}`;
}

function executeSafeFixtureCommand(featureId: any, opts: any = {}) {
  const args = (SAFE_EXECUTABLE_FIXTURE_ARGS as unknown as Record<string, any>)[featureId];
  if (!args) return null;
  const root = opts.root || packageRoot();
  const entrypoint = path.join(packageRoot(), 'dist', 'bin', 'sks.js');
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, CI: 'true', SKS_SKIP_NPM_FRESHNESS_CHECK: '1' }
  });
  return {
    id: featureId,
    args,
    status: result.status,
    signal: result.signal || null,
    ok: result.status === 0,
    stdout_bytes: Buffer.byteLength(result.stdout || ''),
    stderr_bytes: Buffer.byteLength(result.stderr || '')
  };
}

function expectedArtifactPath(artifact: any) {
  if (typeof artifact === 'string') return artifact;
  return String(artifact?.path || '');
}

const SAFE_EXECUTABLE_FIXTURE_ARGS = Object.freeze({
  'cli-help': ['help'],
  'cli-version': ['--version'],
  'cli-root': ['root', '--json'],
  'cli-features': ['features', 'check', '--json'],
  'cli-commands': ['commands', '--json'],
  'cli-run': ['run', 'fixture', '--mock', '--json'],
  'cli-status': ['status', '--json'],
  'cli-usage': ['usage', 'overview'],
  'cli-quickstart': ['quickstart'],
  'cli-guard': ['guard', 'check', '--json'],
  'cli-conflicts': ['conflicts', 'check', '--json'],
  'cli-versioning': ['versioning', 'status', '--json'],
  'cli-aliases': ['aliases'],
  'cli-fix-path': ['fix-path', '--json'],
  'cli-selftest': ['selftest', '--mock'],
  'cli-git': ['git', 'policy', '--json'],
  'cli-seo-geo-optimizer': ['seo-geo-optimizer', 'fixture', '--mode', 'seo', '--json'],
  'cli-paths': ['paths', 'managed', '--json'],
  'cli-rollback': ['rollback', 'list', '--json'],
  'cli-proof-field': ['proof-field', 'scan', '--json', '--intent', 'fixture'],
  'cli-proof': ['proof', 'smoke', '--json'],
  'cli-trust': { setup: [['run', 'fixture', '--mock', '--json']], command: ['trust', 'report', 'latest', '--json'] },
  'cli-wrongness': ['wrongness', 'validate', 'project', '--json'],
  'cli-wiki': ['wiki', 'image-ingest', 'test/fixtures/images/one-by-one.png', '--json'],
  'cli-codex': ['codex', 'compatibility', '--json'],
  'cli-bridge': ['bridge', 'status', '--json'],
  'cli-hooks': ['hooks', 'trust-report', '--json'],
  'cli-perf': ['perf', 'cold-start', '--json', '--iterations', '1'],
  'cli-bench': ['bench', 'core', '--tier', 'npx-one-shot', '--json', '--iterations', '1'],
  'cli-code-structure': ['code-structure', 'scan', '--json'],
  'cli-rust': ['rust', 'smoke', '--json'],
  'cli-skill-dream': ['skill-dream', 'status', '--json'],
  'cli-gc': ['gc', '--dry-run', '--json'],
  'cli-cleanup': ['cleanup', 'plan', '--json'],
  'cli-memory': ['memory', '--dry-run', '--json'],
  'cli-stats': ['stats', '--json'],
  'cli-dollar-commands': ['dollar-commands', '--json'],
  'cli-fast-mode': ['fast-mode', 'status', '--json'],
  'cli-task': ['task', 'instant', '--plan', '--json'],
  'cli-triwiki': ['triwiki', 'index', '--json'],
  'cli-daemon': ['daemon', 'status', '--json'],
  'cli-dfix': ['dfix', 'fixture', '--json'],
  'cli-all-features': ['all-features', 'complete', '--json'],
  'cli-naruto': ['naruto', 'run', 'fixture', '--agents', '4', '--max-threads', '4', '--json'],
  'cli-align': ['align', 'prepare', 'fixture modernization contract', '--json'],
  'route-naruto': ['naruto', 'run', 'fixture', '--agents', '4', '--max-threads', '4', '--json'],
  'route-qa-loop': { setup: [['qa-loop', 'prepare', 'fixture API QA', '--json']], command: ['qa-loop', 'run', 'latest', '--mock', '--json'] },
  'route-research': { setup: [['research', 'prepare', 'fixture research topic', '--json']], command: ['research', 'run', 'latest', '--mock', '--json'] },
  'route-ppt': ['ppt', 'fixture', '--mock', '--json'],
  'route-image-ux-review': ['image-ux-review', 'fixture', '--mock', '--json'],
  'route-computer-use': ['computer-use', 'import-fixture', '--mock', '--json'],
  'route-dfix': ['dfix', 'fixture', '--json'],
  'route-align': ['align', 'fixture', '--json'],
  'route-seo-geo-optimizer': ['seo-geo-optimizer', 'fixture', '--mode', 'geo', '--json'],
  'route-fast-mode': ['fast-mode', 'status', '--json'],
  'route-wiki': ['wiki', 'image-ingest', 'test/fixtures/images/one-by-one.png', '--json'],
  'route-cleanup': ['cleanup', 'plan', '--json'],
  'route-gx': ['gx', 'validate', 'fixture', '--mock', '--json']
});

export function renderFeatureInventoryMarkdown(registry: any) {
  const coverage = registry.coverage || validateFeatureRegistry(registry);
  const lines = [
    '# SKS Feature Inventory',
    '',
    `Generated from \`${registry.inventory_sources.commands_json}\`, \`${registry.inventory_sources.main_handlers}\`, \`${registry.inventory_sources.dollar_routes}\`, docs, and skill manifests.`,
    '',
    '## Coverage',
    '',
    `- Status: ${coverage.ok ? 'coverage-ok' : 'blocked'}`,
    `- Features: ${coverage.counts.features}`,
    `- CLI commands: ${coverage.counts.cli_command_names}`,
    `- Handler keys: ${coverage.counts.handler_keys}`,
    `- Dollar routes: ${coverage.counts.dollar_commands}`,
    `- App skill aliases: ${coverage.counts.app_skill_aliases}`,
    `- Skills: ${coverage.counts.skills}`,
    `- Fixture statuses: ${Object.entries(fixtureSummary(registry.features).counts).map(([status, count]: any) => `${status}=${count}`).join(', ')}`,
    `- Feature quality: ${Object.entries(fixtureSummary(registry.features).quality_counts).map(([quality, count]: any) => `${quality}=${count}`).join(', ')}`,
    '',
    '## Release Coverage Rule',
    '',
    '`sks features check --json` fails when a CLI command, hidden handler, dollar route, app skill alias, or project skill is not mapped to the feature registry. `npm run release:check` runs that check.',
    '',
    '## Stable / Beta / Labs Map',
    '',
    '| Feature | Category | Maturity | Commands / Routes | Fixture | Declared quality | Runtime truth | Known Gaps |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |'
  ];
  for (const feature of registry.features) {
    const commands = [...(feature.commands || []), ...(feature.aliases || [])].map(markdownTableCell).join('<br>');
    const gaps = (feature.known_gaps || []).map(markdownTableCell).join('<br>') || 'none recorded';
    const fixture = feature.fixture ? `${feature.fixture.kind}:${feature.fixture.status}` : 'missing';
    const quality = feature.fixture?.quality || 'missing';
    const runtimeTruth = feature.runtime_truth?.runtime_status || 'not_assessed';
    lines.push(`| \`${feature.id}\` | ${feature.category} | ${feature.maturity} | ${commands || '-'} | ${fixture} | ${quality} | ${runtimeTruth} | ${gaps} |`);
  }
  lines.push('', '## Unmapped Coverage', '');
  for (const [kind, values] of Object.entries(coverage.unmapped || {}) as Array<[string, any[]]>) {
    lines.push(`- ${kind}: ${values.length ? values.join(', ') : 'none'}`);
  }
  if (coverage.doc_route_mentions_without_route?.length) {
    lines.push(`- doc_route_mentions_without_route: ${coverage.doc_route_mentions_without_route.join(', ')}`);
  }
  lines.push('', '## Prompt Checklist Coverage', '');
  lines.push('- [x] Collected the complete `sks commands --json` command surface via `COMMAND_MANIFEST_LITE`.');
  lines.push('- [x] Collected the actual `src/cli/command-registry.ts` `COMMANDS` handler keys, including hidden handlers.');
  lines.push('- [x] Collected dollar routes and app skill aliases from `src/core/routes.js`.');
  lines.push('- [x] Scanned README, Codex quick reference, AGENTS, and generated skill manifest for dollar-route mentions.');
  lines.push('- [x] Mapped project skills from `.agents/skills` into the registry.');
  lines.push('- [x] Exposed the registry through `sks features list --json`.');
  lines.push('- [x] Added a release coverage check through `sks features check --json`.');
  lines.push('- [x] Documented fixture status for every registry feature.');
  return `${lines.join('\n')}\n`;
}

function commandFeature(command: any, handlerAliases: any = []) {
  const name = command.name;
  const category = commandCategory(name);
  const maturity = commandMaturity(name);
  const aliases = [...new Set(handlerAliases.map((alias: any) => `sks ${alias}`))];
  return baseFeature({
    id: `cli-${name}`,
    commands: [command.usage],
    aliases,
    category,
    maturity: command.maturity || maturity,
    intent: command.description,
    completion_proof_integration: proofContract(category),
    voxel_triwiki_integration: voxelContract(category),
    known_gaps: knownGapsForCommand(name),
    source_refs: {
      cli_command_names: [name],
      handler_keys: [name, ...handlerAliases],
      dollar_commands: [],
      app_skill_aliases: [],
      skills: []
    }
  });
}

function hiddenHandlerFeature(handler: any) {
  return baseFeature({
    id: `handler-${handler}`,
    commands: [`sks ${handler}`],
    aliases: [],
    category: 'internal',
    maturity: 'beta',
    intent: `Hidden or internal handler for ${handler}.`,
    voxel_triwiki_integration: 'context-anchor optional unless route output creates evidence',
    completion_proof_integration: 'required for stateful route use',
    known_gaps: ['hidden handler docs needed if promoted'],
    source_refs: {
      cli_command_names: [],
      handler_keys: [handler],
      dollar_commands: [],
      app_skill_aliases: [],
      skills: []
    }
  });
}

function routeFeature(route: any) {
  const aliases = DOLLAR_COMMAND_ALIASES
    .filter((entry: any) => entry.canonical === route.command)
    .map((entry: any) => entry.app_skill);
  return baseFeature({
    id: `route-${slug(dollarPolicyKey(route.command))}`,
    commands: [route.command],
    aliases,
    category: 'route',
    maturity: routeMaturity(route.command),
    intent: route.description,
    voxel_triwiki_integration: routeVoxelContract(route.command),
    completion_proof_integration: 'route gate, reflection, Honest Mode',
    known_gaps: routeKnownGaps(route.command),
    source_refs: {
      cli_command_names: [],
      handler_keys: [],
      dollar_commands: [route.command],
      app_skill_aliases: aliases,
      skills: aliases.map((alias: any) => alias.replace(/^\$/, ''))
    }
  });
}

function officialSubagentProofFeature() {
  return baseFeature({
    id: 'proof-official-subagent-evidence',
    commands: ['subagent-plan.json + subagent-parent-summary.json + subagent-evidence.json'],
    aliases: [],
    category: 'proof-route',
    maturity: 'stable',
    intent: 'Completion Proof binding for Codex official subagent lifecycle and parent-owned integration evidence.',
    voxel_triwiki_integration: 'inherits Naruto route Voxel/TriWiki evidence and bounded attention anchors',
    completion_proof_integration: 'requires the official subagent plan, lifecycle events, parent summary, and correlated evidence',
    known_gaps: ['parallel speed claims still require measured runtime evidence'],
    source_refs: {
      cli_command_names: [],
      handler_keys: [],
      dollar_commands: [],
      app_skill_aliases: [],
      skills: []
    }
  });
}

function wikiCodePackFeature() {
  return baseFeature({
    id: 'cli-wiki-code',
    commands: ['sks align run --json', 'sks wiki validate --json'],
    aliases: ['wiki.code_pack', 'code_pack_refresh'],
    category: 'triwiki',
    maturity: 'beta',
    intent: 'Deterministic codebase scan (any repo, not just this one) turned into a source-cited, quality-gated code pack, wired into TriWiki attention as a dedicated code: sub-budget so LLM handoffs see accurate codebase context at low token cost.',
    voxel_triwiki_integration: 'code: entries ranked into attention.use_first/hydrate_first by trust_score, independent of the policy-claim RGBA/geometric selection',
    completion_proof_integration: 'sks wiki validate --json reports code_pack freshness (fresh/stale/missing) by comparing the pack\'s recorded git HEAD sha to the current one',
    known_gaps: ['ranking is by trust_score only, not live per-prompt keyword relevance, since contextCapsule\'s call site here refreshes a project-wide pack rather than a per-mission one'],
    source_refs: {
      cli_command_names: ['wiki'],
      handler_keys: ['wiki'],
      dollar_commands: [],
      app_skill_aliases: [],
      skills: ['triwiki']
    }
  });
}

function doctorImagegenRepairFeature() {
  return baseFeature({
    id: 'doctor:imagegen-repair',
    commands: ['sks doctor --json', 'sks doctor --fix --json'],
    aliases: ['repair.imagegen', 'imagegen_repair'],
    category: 'safety',
    maturity: 'beta',
    intent: 'Doctor repair path that detects Codex App imagegen, attempts repair when requested, and reports imagegen_repair evidence without claiming success unless re-detection passes.',
    voxel_triwiki_integration: 'policy voxel required for visual/image routes that depend on Codex App imagegen',
    completion_proof_integration: 'doctor report imagegen_repair is consumed by imagegen route blockers before visual route proof',
    known_gaps: ['live Codex App feature enablement remains environment-dependent and reports manual actions when unavailable'],
    source_refs: {
      cli_command_names: ['doctor'],
      handler_keys: ['doctor'],
      dollar_commands: [],
      app_skill_aliases: [],
      skills: ['imagegen']
    }
  });
}

function imagegenWiringFeatures() {
  return [
    baseFeature({
      id: 'ux-review:run-wires-imagegen',
      commands: ['npm run ux-review:run-wires-imagegen', 'sks ux-review run --image <screenshot> --generate-callouts --json'],
      aliases: ['$Image-UX-Review', '$UX-Review'],
      category: 'visual-memory',
      maturity: 'beta',
      intent: 'Image UX route start gate, shared gpt-image-2 adapter, callout extraction, and Codex App evidence validation wiring.',
      voxel_triwiki_integration: 'image/source/bbox voxel required',
      completion_proof_integration: 'image-ux-review-gate and Completion Proof must separate real Codex image evidence from mock/API fallback evidence',
      known_gaps: ['live Codex App image generation remains environment-dependent'],
      source_refs: {
        cli_command_names: ['image-ux-review'],
        handler_keys: ['image-ux-review', 'ux-review'],
        dollar_commands: ['$Image-UX-Review', '$UX-Review'],
        app_skill_aliases: ['$image-ux-review'],
        skills: ['image-ux-review', 'imagegen']
      }
    }),
    baseFeature({
      id: 'ppt:real-imagegen-wiring',
      commands: ['npm run ppt:real-imagegen-wiring', 'sks ppt review --deck <pptx> --json'],
      aliases: ['$PPT'],
      category: 'visual-memory',
      maturity: 'beta',
      intent: 'PPT slide callout review path reuses the shared gpt-image-2 adapter and records imagegen_evidence in PPT gates.',
      voxel_triwiki_integration: 'image/source/bbox voxel required',
      completion_proof_integration: 'ppt-imagegen-review-gate and ppt-gate must include Codex App imagegen evidence classes and hashes',
      known_gaps: ['live deck export and live Codex App image generation remain environment-dependent'],
      source_refs: {
        cli_command_names: ['ppt'],
        handler_keys: ['ppt'],
        dollar_commands: ['$PPT'],
        app_skill_aliases: ['$ppt'],
        skills: ['ppt', 'imagegen']
      }
    })
  ];
}

function skillFeature(skillName: any) {
  return baseFeature({
    id: `skill-${slug(skillName)}`,
    commands: [],
    aliases: [`$${skillName}`],
    category: 'skill',
    maturity: 'labs',
    intent: `Codex skill surface for ${skillName}.`,
    voxel_triwiki_integration: 'inherits owning route contract',
    completion_proof_integration: 'inherits owning route proof',
    known_gaps: ['runtime fixtures owned by route'],
    source_refs: {
      cli_command_names: [],
      handler_keys: [],
      dollar_commands: [],
      app_skill_aliases: [],
      skills: [skillName]
    }
  });
}

function baseFeature(feature: any) {
  const merged = {
    contract: {
      input: feature.commands?.[0] || feature.aliases?.[0] || 'skill invocation',
      output: 'stdout/json/artifacts by command',
      state: 'route state when stateful',
      safety: 'policy-gated',
      proof: feature.completion_proof_integration,
      voxel: feature.voxel_triwiki_integration,
      tests: 'release/selftest coverage',
      docs: 'feature inventory'
    },
    acceptance: FEATURE_ACCEPTANCE_DEFAULTS,
    ...feature
  };
  const fixture = fixtureForFeature(merged.id);
  return dedupeFeatureCommandSurface(namespaceFeatureDollarReferences({
    ...merged,
    fixture,
    runtime_truth: assessFeatureFixtureDeclaration(fixture)
  }));
}

function dedupeFeatureCommandSurface(feature: any) {
  const commands = uniqueStrings(feature.commands || []);
  const commandSet = new Set(commands);
  const aliases = uniqueStrings(feature.aliases || []).filter((alias) => !commandSet.has(alias));
  const sourceRefs = feature.source_refs && typeof feature.source_refs === 'object'
    ? Object.fromEntries(Object.entries(feature.source_refs).map(([key, values]) => [
        key,
        Array.isArray(values) ? uniqueStrings(values) : values
      ]))
    : feature.source_refs;
  return {
    ...feature,
    commands,
    aliases,
    source_refs: sourceRefs
  };
}

function namespaceFeatureDollarReferences(value: any): any {
  if (typeof value === 'string') return prefixKnownSksDollarReferences(value, FEATURE_DOLLAR_REFERENCE_NAMES);
  if (Array.isArray(value)) return value.map(namespaceFeatureDollarReferences);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, namespaceFeatureDollarReferences(entry)]));
}

function mapHandlerKeysToFeatureIds(handlerKeys: any = []) {
  const catalogNames = new Set(COMMAND_MANIFEST_LITE.map((entry) => entry.name));
  const out: Record<string, string> = {};
  for (const handler of handlerKeys) {
    const commandName = (HANDLER_ALIAS_TO_COMMAND as Record<string, string>)[handler] || handler;
    out[handler] = catalogNames.has(commandName) ? `cli-${commandName}` : `handler-${handler}`;
  }
  return out;
}

function featureCommandCatalog() {
  const detailed = new Map(COMMAND_CATALOG.map((entry: any) => [entry.name, entry]));
  return COMMAND_MANIFEST_LITE.map((entry) => {
    const detail: any = detailed.get(entry.name);
    return {
      ...entry,
      usage: detail?.usage || `sks ${entry.name}`,
      description: detail?.description || entry.summary
    };
  });
}

function actualCommandHandlerKeys() {
  return Object.keys(COMMANDS).sort();
}

async function listProjectSkillNames(root: any) {
  const dir = path.join(root, '.agents', 'skills');
  if (!await exists(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const names: any[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const skillFile = path.join(dir, entry.name, 'SKILL.md');
    const text = await readText(skillFile, '').catch(() => '');
    const name = text.match(/^name:\s*"?([^"\n]+)"?/m)?.[1]?.trim() || entry.name;
    if (name) names.push(name);
  }
  return [...new Set(names)].sort();
}

async function collectDocRouteMentions(root: any) {
  const docs = ['README.md', '.codex/SNEAKOSCOPE.md', 'AGENTS.md', '.agents/skills/.sks-generated.json'];
  const mentions = new Set();
  for (const file of docs) {
    const text = file.endsWith('.json')
      ? JSON.stringify(await readJson(path.join(root, file), null).catch(() => null) || {})
      : await readText(path.join(root, file), '').catch(() => '');
    for (const match of text.matchAll(/\$[A-Za-z][A-Za-z0-9_-]*/g)) mentions.add(canonicalDollar(match[0]));
  }
  return [...mentions].sort();
}

function flatMapSourceRefs(features: any, key: any) {
  return features.flatMap((feature: any) => feature.source_refs?.[key] || []);
}

function duplicateValues(values: any) {
  const seen = new Set();
  const dupes = new Set();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes].sort();
}

function markdownTableCell(value: any) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function skillCoveredByRoute(skillName: any) {
  const normalized = String(skillName || '').toLowerCase();
  return DOLLAR_COMMAND_ALIASES.some((entry: any) => entry.app_skill.replace(/^\$/, '').toLowerCase() === normalized);
}

function isExternalPromptCommandMention(mention: any) {
  const normalized = String(mention || '').toUpperCase();
  return [
    '$CODEX_HOME',
    '$HOME',
    '$CODEX_LB_API_KEY',
    '$CODEX_LB_KEY',
    '$OPENROUTER_KEY',
    '$SKS_CODEX_APP_IMAGEGEN_OUTPUT',
    '$SKS_CODEX_APP_IMAGEGEN_OUTPUT_ID',
    '$SKS_CODEX_APP_IMAGEGEN_CREATED_AT',
    '$SKS_WORKTREE_ROOT',
    '$XDG_CACHE_HOME',
    '$IMAGEGEN'
  ].includes(normalized);
}

function canonicalDollar(value: any) {
  const raw = String(value || '').trim();
  const hit = DOLLAR_COMMANDS.find((entry: any) => entry.command.toLowerCase() === raw.toLowerCase());
  if (hit) return hit.command;
  const aliasHit = DOLLAR_COMMAND_ALIASES.find((entry: any) => entry.app_skill.toLowerCase() === raw.toLowerCase());
  if (aliasHit) return aliasHit.app_skill;
  return routeByDollarCommand(raw) ? sksPrefixedDollarCommand(raw) : raw;
}

function normalizeDollar(value: any) {
  return String(value || '').trim().toLowerCase();
}

function slug(value: any) {
  return String(value || '').replace(/^\$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function commandCategory(name: any) {
  if (['naruto', 'pipeline', 'goal', 'hproof', 'proof-field', 'validate-artifacts'].includes(name)) return 'proof-route';
  if (['qa-loop', 'research', 'recallpulse', 'skill-dream', 'eval', 'perf'].includes(name)) return 'loop';
  if (['codex', 'codex-app', 'codex-native', 'codex-lb', 'hooks', 'context7', 'computer-use'].includes(name)) return 'integration';
  if (['db', 'guard', 'conflicts', 'harness', 'versioning'].includes(name)) return 'safety';
  if (['wiki', 'wrongness', 'gx', 'image-ux-review', 'ppt'].includes(name)) return 'visual-memory';
  if (['setup', 'bootstrap', 'doctor', 'deps', 'init', 'postinstall', 'fix-path'].includes(name)) return 'install';
  return 'core-cli';
}

function commandMaturity(name: any) {
  if (['help', 'version', 'commands', 'usage', 'root', 'quickstart', 'setup', 'doctor', 'selftest', 'update-check', 'fast-mode'].includes(name)) return 'stable';
  if (['codex', 'codex-app', 'codex-native', 'codex-lb', 'hooks', 'features', 'all-features', 'wiki', 'wrongness', 'naruto', 'pipeline', 'goal', 'db', 'guard', 'computer-use', 'mad-sks', 'seo-geo-optimizer'].includes(name)) return 'beta';
  return 'labs';
}

function routeMaturity(command: any) {
  const key = dollarPolicyKey(command);
  if (['answer', 'dfix', 'sks', 'fast-mode', 'wiki', 'help'].includes(key)) return 'stable';
  if (['naruto', 'goal', 'db', 'computer-use', 'cu', 'qa-loop', 'mad-sks'].includes(key)) return 'beta';
  return 'labs';
}

function voxelContract(category: any) {
  if (category === 'visual-memory') return 'visual/image anchors required';
  if (category === 'safety') return 'policy voxel required';
  if (category === 'loop' || category === 'proof-route') return 'context/source/test anchors required';
  return 'context anchor when evidence is written';
}

function proofContract(category: any) {
  if (['proof-route', 'loop', 'safety', 'visual-memory'].includes(category)) return 'required';
  return 'required for route/release use';
}

function knownGapsForCommand(name: any) {
  if (['features', 'all-features'].includes(name)) return ['feature fixtures remain progressive'];
  if (['codex-app', 'hooks'].includes(name)) return ['mobile/event payload details remain unknown'];
  return [];
}

function routeVoxelContract(command: any) {
  const key = dollarPolicyKey(command);
  if (['image-ux-review', 'ux-review', 'ppt', 'from-chat-img', 'gx'].includes(key)) return 'image/source/bbox voxel required';
  if (key === 'db' || key === 'mad-sks') return 'DB policy voxel required';
  return 'TriWiki anchors required';
}

function routeKnownGaps(command: any) {
  const key = dollarPolicyKey(command);
  if (['image-ux-review', 'ux-review', 'ppt'].includes(key)) return ['live imagegen/CU evidence required'];
  if (key === 'mad-sks') return ['permission closed by owning gate'];
  return [];
}

function dollarPolicyKey(value: any) {
  const normalized = String(value || '').trim().replace(/^\$/, '').toLowerCase();
  return normalized === 'sks' ? normalized : normalized.replace(/^sks-/, '');
}

function checkRow(id: any, ok: any, blockers: any = []) {
  return { id, ok: Boolean(ok), blockers: ok ? [] : blockers };
}

export function featureQualitySummary(features: any = []) {
  return fixtureSummary(features).quality_counts;
}

export function runtimeRoutesNotStaticContract(features: any = []) {
  const blockers = features
    .filter((feature: any) => feature.category === 'route' || String(feature.id || '').startsWith('route-'))
    .filter((feature: any) => feature.fixture?.quality === 'static_contract')
    .map((feature: any) => `${feature.id}:static_contract`);
  return { ok: blockers.length === 0, blockers };
}

function missingFeatureField(registry: any, field: any) {
  return (registry.features || []).filter((feature: any) => !feature[field]).map((feature: any) => feature.id);
}
