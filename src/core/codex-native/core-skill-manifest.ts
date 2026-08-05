import { PACKAGE_VERSION, nowIso, sha256 } from '../fsx.js';
import { coreEngineeringDirectiveReference } from '../lean-engineering-policy.js';
import { normalizeDollarSkillName, prefixKnownSksDollarReferences, sksPrefixedDollarCommand, sksPrefixedSkillName } from '../routes/dollar-prefix.js';
import { compactSkillDiscoveryDescription } from '../skills/skill-agent-metadata.js';
import { canonicalSkillName } from './skill-name-canonicalizer.js';

type LegacySksCoreSkillRoute =
  | '$Naruto'
  | '$QA-LOOP'
  | '$Research'
  | '$DFix'
  | '$Image-UX-Review'
  | '$Computer-Use'
  | '$Init-Deep'
  | '$SEO-GEO-OPTIMIZER'
  | '$Cleanup'
  | '$Align';

export type SksCoreSkillRoute = '$sks' | `$sks-${string}`;

export interface SksCoreSkillTemplate {
  id: string;
  canonical_name: string;
  display_name: string;
  route: SksCoreSkillRoute;
  relative_path: string;
  template_version: string;
  content_sha256: string;
  mutable_by_doctor: false;
  mutable_by_update: false;
  mutable_by_setup: false;
}

export interface SksCoreSkillManifest {
  schema: 'sks.core-skill-manifest.v1';
  generated_at: string;
  package_version: string;
  skills: SksCoreSkillTemplate[];
}

export const CORE_SKILL_TEMPLATE_VERSION = 'sks-core-skill-template.v2';
export const CORE_SKILL_MANAGED_BEGIN = '<!-- BEGIN SKS IMMUTABLE CORE SKILL -->';
export const CORE_SKILL_MANAGED_END = '<!-- END SKS IMMUTABLE CORE SKILL -->';

const CORE_SKILL_DEFINITIONS: Array<{
  id: string;
  canonical_name: string;
  display_name: string;
  route: LegacySksCoreSkillRoute;
  purpose: string;
  when: string;
  workflow?: string;
  safety?: string;
  cli?: string;
  evidence: string;
  fallback: string;
}> = [
  {
    id: 'sks-core-naruto',
    canonical_name: 'naruto',
    display_name: 'naruto',
    route: '$Naruto',
    purpose: 'run a Codex official subagent workflow with official agent threads while parent integration remains owner.',
    when: 'Use when the user explicitly invokes $Naruto or the selected route requires bounded parallel delegation.',
    workflow: 'Run sks naruto run "<task>" [--agents N] [--max-threads N] [--json] with Codex official subagent threads only. The parent owns decomposition, per-wave capacity, later root-owned waves, integration, and final verification. Automatic targets begin at 4/6/8/16 by task size: bounded, explicit parallel, large-scale, then mass cheap-model fan-out on the Luna/Terra lanes. After decomposition both lanes may expand to the SKS-owned 256-child ceiling when independent useful slices and real host capacity remain positive; max_threads defaults to a 256-child frame budget cap, never a target. A measured lower Codex host cap or explicit provider/API budget remains authoritative, and multi-wave scheduling reuses returned capacity. Route tiny mechanical and mass shards to Luna Max, broad search and exploration shards to Terra Max, and implementation or judgment to Sol; max_depth=1 blocks nested delegation. Wait for every planned thread before final. In an active Codex App Naruto mission, commit the strict parent evidence with sks naruto parent-summary --mission <id> --stdin, then return localized Markdown without exposing the JSON.',
    safety: 'Preserve user-authored content, inherit the parent permission mode, do not spawn nested subagents, do not inject the full pack or the full TriWiki context into every child, and do not fall back to another model, process runtime, custom scheduler, or worker pool. The historical Naruto process runtime is removed; stop with explicit blocker evidence when the official path is unavailable.',
    cli: 'sks naruto run "<task>" [--agents N] [--max-threads N] [--json]; sks naruto status|subagents|proof [--mission <id>] [--json]; sks naruto parent-summary --mission <id> --stdin [--json]',
    evidence: 'subagent-plan.json, subagent-events.jsonl, subagent-parent-summary.json, subagent-evidence.json, naruto-summary.json, and naruto-gate.json.',
    fallback: 'Return explicit official-subagent availability blockers and continue parent-owned only when the sealed task still has meaningful in-scope work; never fabricate process, PID, or subagent evidence.'
  },
  {
    id: 'sks-core-qa-loop',
    canonical_name: 'qa-loop',
    display_name: 'qa-loop',
    route: '$QA-LOOP',
    purpose: 'dogfood UI/API behavior with safety gates, Codex Chrome Extension-first web UI evidence, and QA reports.',
    when: 'Use when route completion needs human-proxy verification, rechecks, and QA ledgers.',
    workflow: 'Infer the QA scope, dogfood real UI/API flows, and for web/browser/webapp UI evidence use the Codex Chrome Extension readiness gate first. If the extension is missing or disabled, rapidly halt and ask the user to set it up before resuming. Computer Use is reserved for native Mac/non-web surfaces and must not satisfy web UI evidence.',
    evidence: 'qa-ledger.json, dated QA report, qa-gate.json, and post-fix verification.',
    fallback: 'Mark unverified browser/native surfaces explicitly; never substitute fake visual evidence.'
  },
  {
    id: 'sks-core-research',
    canonical_name: 'research',
    display_name: 'research',
    route: '$Research',
    purpose: 'run evidence-bound discovery, source ledgers, and synthesis cycles.',
    when: 'Use for discovery, evaluation, external-source claims, or frontier-style research.',
    workflow: 'Frame the research criteria and map assumptions before retrieval. Run layered Super Search first and accept only source rows correlated to verified proof, source-ledger, and hydrated-content artifacts. Then run exactly three independent official research_reviewer threads on GPT-5.6 Sol Max using Einstein, von Neumann, and Skeptic composite lenses. Each reviewer must return one literal "Eureka!" idea, source ids, falsifiers, cheap probes, and zero unresolved objections before approval. Any objection triggers a mission-local research_synthesizer revision and a fresh three-thread review cycle. agent-ledger.json and debate-ledger.json are compatibility projections only; do not launch a removed legacy scheduler or a custom debate pool.',
    safety: 'Preserve user-authored content, keep research route state bounded, and do not edit repository source. Do not overclaim genius, novelty, breakthrough, publication acceptance, or experimental support beyond recorded evidence.',
    evidence: 'research plan, source ledger, cycle record, synthesis, and final review.',
    fallback: 'State source/tool unavailability and avoid unsupported live-accuracy claims.'
  },
  {
    id: 'sks-core-dfix',
    canonical_name: 'dfix',
    display_name: 'dfix',
    route: '$DFix',
    purpose: 'perform tiny direct fixes with cheap verification.',
    when: 'Use only for narrow copy/config/docs/labels/spacing/translation/mechanical edits.',
    evidence: 'focused diff and DFix Honest check.',
    fallback: 'Escalate broad implementation to a full execution route.'
  },
  {
    id: 'sks-core-image-ux-review',
    canonical_name: 'image-ux-review',
    display_name: 'image-ux-review',
    route: '$Image-UX-Review',
    purpose: 'run one screenshot-to-generated-annotation-to-UX-report pipeline without duplicate picker skills.',
    when: 'Use for $Image-UX-Review, $UX-Review, $Visual-Review, or $UI-UX-Review requests; all aliases resolve to this one canonical skill.',
    workflow: 'Capture or attach the real source screenshot first; web/browser/webapp capture must pass the Codex Chrome Extension readiness gate first, while Computer Use is reserved for native Mac/non-web surfaces. Send the source image as the I2I reference to the selected Codex imagegen provider with gpt-image-2 and a senior Toss UI/UX designer prompt that visibly adds numbered P0/P1/P2/P3 callouts, hierarchy, contrast, alignment, density, affordance, eye-flow arrows, and a corrected mini-comp. Then analyze the generated annotated image pixels with vision/OCR, not the source screenshot, and write the issue ledger, extraction report, and UX/UI change report with the generated image path and sha256.',
    safety: 'Do not substitute text-only critique, a source-screenshot-only report, placeholders, partial image frames, mock evidence, or an unrelated API provider for the selected real imagegen path. Apply fixes only when requested and recheck changed screens.',
    cli: 'sks ux-review run --image <path> [--fix] --json; legacy $sks-ux-review, $sks-visual-review, and $sks-ui-ux-review inputs route here internally.',
    evidence: 'image-ux-screen-inventory.json, image-ux-gpt-image-2-request.json, image-ux-gpt-image-2-response.json, image-ux-generated-review-ledger.json, image-ux-issue-ledger.json, image-ux-callout-extraction-report.json, image-ux-iteration-report.json, and image-ux-review-gate.json.',
    fallback: 'Block full verification if the real source screenshot, completed generated annotated image, generated-image callout extraction, or generated-image-based UX/UI report is unavailable.'
  },
  {
    id: 'sks-core-computer-use',
    canonical_name: 'computer-use',
    display_name: 'computer-use',
    route: '$Computer-Use',
    purpose: 'operate native macOS desktop apps through Codex Computer Use.',
    when: 'Use only for native Mac/non-web app or OS-setting surfaces.',
    evidence: 'native desktop interaction evidence where live Computer Use is available.',
    fallback: 'Do not use Computer Use as browser/web evidence; mark unavailable surfaces unverified.'
  },
  {
    id: 'sks-core-init-deep',
    canonical_name: 'init-deep',
    display_name: 'init-deep',
    route: '$Init-Deep',
    purpose: 'refresh project-local memory, directory rules, and loop memory hints.',
    when: 'Use when deeper local context or directory-specific recall is required.',
    evidence: '.sneakoscope/context/AGENTS.generated.md and managed memory artifacts.',
    fallback: 'Preserve user content and skip directories that cannot be safely updated.'
  },
  {
    id: 'sks-core-search-visibility-core',
    canonical_name: 'search-visibility-core',
    display_name: 'search-visibility-core',
    route: '$SEO-GEO-OPTIMIZER',
    purpose: 'provide the shared search-visibility kernel for SEO and GEO audit, plan, explicit apply, verify, rollback, and Completion Proof without ranking, traffic, indexing, rich-result, answer inclusion, or AI citation guarantees.',
    when: 'Use when $SEO-GEO-OPTIMIZER or sks seo-geo-optimizer needs typed mode-specific evidence, gates, artifacts, or safe mutation planning for websites, docs, packages, README/npm/GitHub surfaces, or storefront SEO architecture.',
    workflow: 'Read the touched search-visibility flow before planning: SEO constants/source-of-truth, metadata builders, route topology, sitemap/robots, llms.txt, structured-data builders, target route files, internal-link sources, and SEO tests. Inventory canonical URLs, alternates/hreflang, crawlable localized sitemap rows, JSON-LD, crawler hints, claim evidence, and verification commands before compiling mutation-plan.json.',
    safety: 'Treat SEO/GEO as an architecture compiler, not scattered page copy. Prefer existing project helpers and constants; never duplicate public route strings across files. JSON-LD must describe visible or source-of-truth facts only. Do not invent prices, reviews, ratings, availability, shipping terms, rankings, traffic, rich-result eligibility, indexing, or AI-answer outcomes.',
    cli: 'sks seo-geo-optimizer doctor|audit|plan|apply|verify|status|rollback|fixture --mode seo|geo',
    evidence: 'search-visibility/intake.json, adapter-detection.json, site-inventory.json, route-graph.json, robots-policy.json, structured-data-ledger.json, sitemap coverage, llms.txt plan/evidence, mutation-plan.json, rollback-manifest.json, verification-report.json, seo-gate.json or geo-gate.json, and completion-proof.json.',
    fallback: 'Keep unsupported frameworks plan-only, record unverified production/browser/Search Console/AI citation outcomes, and never invent guarantee evidence.'
  },
  {
    id: 'sks-core-seo-geo-optimizer',
    canonical_name: 'seo-geo-optimizer',
    display_name: 'seo-geo-optimizer',
    route: '$SEO-GEO-OPTIMIZER',
    purpose: 'run the unified SEO/GEO optimizer route for Search Engine Optimization and Generative Engine Optimization, not geolocation or GeoIP, with no ranking, traffic, indexing, rich-result, answer inclusion, or AI citation guarantee.',
    when: 'Use the single CLI entrypoint: sks seo-geo-optimizer doctor|audit|plan|apply|verify|status|rollback|fixture --mode seo|geo for SEO and GEO visibility work. Legacy seo-geo wording, SEO, GEO, search visibility, AI visibility, sitemap, canonical, JSON-LD, llms.txt, metadata, keyword/intent, or crawler-policy requests should converge here.',
    workflow: 'Follow the architecture-first playbook: identify target intent and market, locate the central SEO source of truth, update/reuse canonical helpers before page code, build metadata through project helpers, emit independently crawlable localized sitemap rows plus alternates when applicable, add factual JSON-LD only from visible/source data, add internal crawl links, update AI/GEO documentation surfaces such as llms.txt when strategic, add focused tests/guards, then verify. For CELIMAX-style storefronts, prefer STOREFRONT_PATH, buildSeoMetadata, buildSeoPath, buildSeoUrl, app/sitemap.ts, proxy.ts, public/llms.txt, and market-specific tests when those files exist.',
    safety: 'Separate implemented, verified, and unverified claims. Competitor/retailer intent pages must be factual, helpful, and non-deceptive; block keyword stuffing, doorway pages, hidden AI-only text, fake ratings/reviews/prices/availability/shipping, competitor defamation, and unsupported "official retailer", "cheapest", "best", "exclusive", first-page, traffic, Search Console, or AI-citation claims.',
    cli: 'sks seo-geo-optimizer doctor|audit|plan|apply|verify|status|rollback|fixture --mode seo|geo',
    evidence: 'SEO intent map, canonical URL map, metadata summary, JSON-LD summary, sitemap coverage summary, internal link plan, unsupported claims ledger, Search Console/analytics follow-up plan, site inventory, route graph, seo-findings.json or geo-findings.json, claim-evidence-ledger.json, ai-crawler-policy.json, llms-txt-plan.json, verification report, route gate, and Completion Proof.',
    fallback: 'Do not auto-allow training crawlers or fabricate AI answer visibility; mark missing live outcomes unverified and keep recovery on the unified optimizer route.'
  },
  {
    id: 'sks-core-cleanup',
    canonical_name: 'cleanup',
    display_name: 'cleanup',
    route: '$Cleanup',
    purpose: 'blank the active SKS TriWiki so no prior memory, wrongness, generated graph, pack, cache, report, or AGENTS projection can influence the next code index.',
    when: 'Use only when the user asks for TriWiki cleanup/reset/blanking or invokes $Cleanup; this is an explicit R3 local mutation.',
    workflow: 'Run sks cleanup plan first. After the operator reviews the inventory, run sks cleanup run --apply. The command locks TriWiki state, re-hashes the planned bytes, moves active TriWiki surfaces through a temporary same-filesystem swap, removes managed AGENTS.md projections, verifies the blank state, then permanently deletes the swap. No prior generation or quarantine is retained. Use sks cleanup proof to verify the blank state. It never consolidates old prose into new active memory.',
    safety: 'Preserve repository source, ordinary docs, missions, evidence, and release proof history. Refuse symlink targets, plan/apply byte drift, and implicit apply. Roll back before the deletion commit; after deletion begins, report any incomplete deletion honestly. Never run doctor --fix as a substitute.',
    cli: 'sks cleanup plan|run|status|proof [--apply] [--json]',
    evidence: '.sneakoscope/triwiki-cleanup-receipt.json proving destructive blanking, no retained backup, and removal of the temporary swap.',
    fallback: 'If the active state or temporary-swap deletion cannot be proved, keep the command blocked and report exact paths; do not claim cleanup.'
  },
  {
    id: 'sks-core-align',
    canonical_name: 'align',
    display_name: 'align',
    route: '$Align',
    purpose: 'create or replace TriWiki with an exhaustive repository code-navigation index so an LLM can find the purpose, file, symbol, exact coordinate, and supported directed relationships of current code quickly.',
    when: 'Use when the user invokes $Align or asks to reread the current codebase and rebuild or repair TriWiki strictly from current code. Cleanup is optional and independent.',
    workflow: 'Run sks align run directly against either an absent or existing TriWiki. Align ignores all prior TriWiki state as index input, walks every accepted current source file without incremental or fragment cache reuse, derives purpose only from source comments/docstrings, records exact file and symbol coordinates plus extractor-supported source relations, rechecks the full source inventory digest, validates graph/meta/manifest/code-pack/context-pack in temporary staging, transactionally replaces the active generation, then deletes the temporary prior-state handle. context-graph.json is the exhaustive authority; context-pack.json and managed AGENTS.md blocks are bounded fast-lookup projections. Keep align-ledger.json and align-gate.json truthful, then finish reflection and Honest Mode.',
    safety: 'Never read prior TriWiki memory, wrongness, mission prompts, ordinary docs, external docs, proof cards, or LLM inference as index input. Refuse caps, extraction-limit violations, unreadable/oversized/binary supported-source files, symlink escapes, source drift during the scan, partial staging, non-code extractors, or incomplete file coverage. Do not retain a previous generation.',
    cli: 'sks align prepare|run|status|proof [mission|"scope"] [--json]',
    evidence: 'work-order-ledger.json, align-plan.json, align-ledger.json, align-gate.json, .sneakoscope/wiki/context-graph.json, context-graph.meta.json, code-navigation-manifest.json, code-pack.json, context-pack.json, managed AGENTS.md projections, completion-proof.json, trust-report.json, and Honest Mode.',
    fallback: 'If exhaustive source coverage, source CAS, staging validation, projection, transactional replacement, or temporary-swap deletion cannot be proved, roll back before deletion when possible, record the exact blocker, and leave align-gate.json blocked.'
  }
];

const LEGACY_CORE_DOLLAR_NAMES = Array.from(new Set(CORE_SKILL_DEFINITIONS.flatMap((skill) => [
  skill.canonical_name,
  normalizeDollarSkillName(skill.route)
])));

export function legacyCoreSkillNames(): string[] {
  return CORE_SKILL_DEFINITIONS.map((skill) => skill.canonical_name);
}

export function currentCoreSkillName(name: string): string {
  return sksPrefixedSkillName(name);
}

function currentCoreSkillDefinition(skill: typeof CORE_SKILL_DEFINITIONS[number]) {
  const rewrite = (value: string | undefined) => value === undefined
    ? undefined
    : prefixKnownSksDollarReferences(value, LEGACY_CORE_DOLLAR_NAMES);
  return {
    ...skill,
    canonical_name: currentCoreSkillName(skill.canonical_name),
    display_name: currentCoreSkillName(skill.display_name),
    route: sksPrefixedDollarCommand(skill.route) as SksCoreSkillRoute,
    when: rewrite(skill.when) as string,
    workflow: rewrite(skill.workflow),
    safety: rewrite(skill.safety),
    cli: rewrite(skill.cli),
    fallback: rewrite(skill.fallback) as string
  };
}

export function coreSkillDefinitions(): ReadonlyArray<ReturnType<typeof currentCoreSkillDefinition>> {
  return CORE_SKILL_DEFINITIONS.map(currentCoreSkillDefinition);
}

export function isCoreSkillName(name: string): boolean {
  const canonical = canonicalSkillName(name);
  return CORE_SKILL_DEFINITIONS.some((skill) => currentCoreSkillName(skill.canonical_name) === canonical);
}

export function renderCoreSkillTemplate(name: string): string {
  const canonical = canonicalSkillName(name);
  const legacy = CORE_SKILL_DEFINITIONS.find((entry) => (
    entry.canonical_name === canonical || currentCoreSkillName(entry.canonical_name) === canonical
  ));
  if (!legacy) throw new Error(`Unknown SKS core skill: ${name}`);
  const skill = currentCoreSkillDefinition(legacy);
  const directive = coreEngineeringDirectiveReference();
  const description = compactSkillDiscoveryDescription(
    `${skill.purpose.charAt(0).toUpperCase()}${skill.purpose.slice(1)}`
  );
  const activation = skill.when.replace(/^Use\s+(?:only\s+)?(?:(?:when|for)\s+)?/i, '');
  return [
    '---',
    `name: ${skill.display_name}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    CORE_SKILL_MANAGED_BEGIN,
    `id: ${skill.id}`,
    `canonical_name: ${skill.canonical_name}`,
    `route: ${skill.route}`,
    `template_version: ${CORE_SKILL_TEMPLATE_VERSION}`,
    'mutable_by_doctor: false',
    'mutable_by_update: false',
    'mutable_by_setup: false',
    CORE_SKILL_MANAGED_END,
    '',
    `# ${skill.route}`,
    '',
    '## Outcome',
    '',
    `Purpose: ${skill.purpose}`,
    '',
    '## Activation',
    '',
    `Route: ${skill.route}`,
    `Command: ${skill.route}`,
    `Use when: ${activation}`,
    '',
    '## Workflow',
    '',
    `Workflow: ${skill.workflow || 'Run the selected route lifecycle, read source evidence before mutation planning, keep changes scoped, verify with the cheapest sufficient check, and record blockers honestly.'}`,
    '',
    '## Runtime contract',
    '',
    `CLI entrypoint: ${skill.cli || skill.route}`,
    `Core directive: ${directive.directive_id}/${directive.directive_hash}`,
    '',
    '## Safety',
    '',
    `Safety: ${skill.safety || 'Preserve user-authored content, keep route state bounded, avoid unsupported guarantees, and stop on hard blockers instead of fabricating fallback behavior.'}`,
    '',
    '## Evidence',
    '',
    `Evidence/artifacts: ${skill.evidence}`,
    '',
    '## Failure recovery',
    '',
    `Failure/recovery: ${skill.fallback}`,
    ''
  ].join('\n');
}

export function buildSksCoreSkillManifest(generatedAt: string = nowIso()): SksCoreSkillManifest {
  return {
    schema: 'sks.core-skill-manifest.v1',
    generated_at: generatedAt,
    package_version: PACKAGE_VERSION,
    skills: coreSkillDefinitions().map((skill) => {
      const content = renderCoreSkillTemplate(skill.canonical_name);
      return {
        id: skill.id,
        canonical_name: skill.canonical_name,
        display_name: skill.display_name,
        route: skill.route,
        relative_path: `.agents/skills/${skill.canonical_name}/SKILL.md`,
        template_version: CORE_SKILL_TEMPLATE_VERSION,
        content_sha256: sha256(content),
        mutable_by_doctor: false,
        mutable_by_update: false,
        mutable_by_setup: false
      };
    })
  };
}

export function coreSkillTemplateByCanonicalName(name: string): SksCoreSkillTemplate | null {
  const canonical = currentCoreSkillName(canonicalSkillName(name));
  return buildSksCoreSkillManifest('1970-01-01T00:00:00.000Z').skills.find((skill) => skill.canonical_name === canonical) || null;
}

export function isSksManagedCoreSkillContent(text: string): boolean {
  const value = String(text || '');
  return value.includes(CORE_SKILL_MANAGED_BEGIN) && value.includes(CORE_SKILL_MANAGED_END);
}
