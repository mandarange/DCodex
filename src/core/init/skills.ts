import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import type { Dirent } from 'node:fs';
import { exists, nowIso, PACKAGE_VERSION, readJson, readText, sha256, withScratchDir, writeJsonAtomic, writeTextAtomic } from '../fsx.js';
import { buildSksCoreSkillManifest, isCoreSkillName, legacyCoreSkillNames } from '../codex-native/core-skill-manifest.js';
import { syncCoreSkillsIntegrity } from '../codex-native/core-skill-integrity.js';
import {
  managedSkillGenerationLockPath,
  withManagedSkillGenerationLock
} from '../codex-native/managed-skill-generation-lock.js';
import { dbSafetyGuardSkillText, madSksSqlPlanePolicyText } from '../mad-sks/sql-plane/policy.js';
import { skillDreamPolicyText } from '../skill-forge.js';
import { installOfficialSubagentAgentConfigs } from '../subagents/official-subagent-config.js';
import { reconcileRetiredAgentRoleResidue } from '../agents/agent-role-config.js';
import {
  ensureConfinedDirectory,
  inspectConfinedPath,
  moveConfinedPath,
  publicPathError,
  removeConfinedDirectoryIfEmpty,
  removeManagedPathVerified,
  uniqueConfinedPath
} from '../managed-path-safety.js';
import { collectNestedProjectRoots } from '../doctor/current-project-guidance-nested.js';
import { coreEngineeringDirectiveReferenceText } from '../lean-engineering-policy.js';
import { compareSemVer } from '../update/semver.js';
import { AWESOME_DESIGN_MD_REFERENCE, CODEX_APP_IMAGE_GENERATION_DOC_URL, CODEX_COMPUTER_USE_ONLY_POLICY, CODEX_IMAGEGEN_REQUIRED_POLICY, CODEX_WEB_VERIFICATION_POLICY, DOLLAR_COMMANDS, FROM_CHAT_IMG_CHECKLIST_ARTIFACT, FROM_CHAT_IMG_COVERAGE_ARTIFACT, FROM_CHAT_IMG_QA_LOOP_ARTIFACT, FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT, FROM_CHAT_IMG_TEMP_TRIWIKI_SESSIONS, GETDESIGN_REFERENCE, IMAGEGEN_SOCIAL_SOURCE_POLICY, LEGACY_DOLLAR_SKILL_NAMES, OPENAI_CHATGPT_IMAGES_2_DOC_URL, OPENAI_GPT_IMAGE_2_MODEL_DOC_URL, OPENAI_IMAGE_GENERATION_DOC_URL, RESERVED_CODEX_PLUGIN_SKILL_NAMES, SOLUTION_SCOUT_SKILL_NAME, pptPipelineAllowlistPolicyText, productDesignPluginPolicyText } from '../routes.js';
import { prefixKnownSksDollarReferences, sksPrefixedSkillName } from '../routes/dollar-prefix.js';
import { escapeRegExp } from '../text/regex.js';
import {
  compactSkillDiscoveryDescription,
  renderSkillAgentMetadata,
  skillFrontmatterDescription
} from '../skills/skill-agent-metadata.js';
import {
  REMOVED_SKS_SKILL_NAMES,
  LEGACY_UNPREFIXED_SKS_SKILL_NAMES,
  LEGACY_SKS_SUPPORT_SKILL_NAMES,
  PACKAGED_SKILLS_MANIFEST_SCHEMA,
  REMOVED_SKS_SKILL_NAME_SET,
  RETIRED_PUBLIC_IMAGE_UX_REVIEW_SKILL_ALIASES,
  RETIRED_PUBLIC_IMAGE_UX_REVIEW_SKILL_ALIAS_SET,
  SKILL_ALIASES,
  SKS_SKILL_MANIFEST_FILE,
  SKS_SKILL_NAMES_TO_CLEAN_UP,
  canonicalSkillNameFromValue
} from './skills/inventory.js';
import {
  listSkillDirs,
  pruneProjectGeneratedManifest,
  rootFromSkillsDir
} from './skills/filesystem.js';
import {
  loadBundledSkillsManifest,
  loadSkillsManifest,
  mergePackagedSkillsManifestHashHistory,
  normalizeSkillsManifest,
  runtimeBuildSourceTime,
  skillManifestGenerationSha256,
  skillsManifestFromHashLedger
} from './skills/manifest.js';

export { REMOVED_SKS_SKILL_NAMES, LEGACY_UNPREFIXED_SKS_SKILL_NAMES } from './skills/inventory.js';
export {
  loadBundledSkillsManifest,
  loadSkillsManifest,
  mergePackagedSkillsManifestHashHistory,
  skillsManifestFromHashLedger
} from './skills/manifest.js';

const MANAGED_SKILL_MARKER_VERSION = '1';
const GENERATED_PRUNE_POLICY = 'remove_previous_sks_generated_paths_absent_from_current_manifest';
const REFLECTION_MEMORY_PATH = '.sneakoscope/memory/q2_facts/post-route-reflection.md';
const MANAGED_SKILL_MARKER_RE = /BEGIN SKS (?:IMMUTABLE CORE|MANAGED) SKILL/;
const FORGE_SKILL_MARKER_RE = /BEGIN SKS FORGE SKILL/;

function reflectionInstructionText(commandPrefix: any = 'sks') {
  return `Post-route reflection: when explicitly requested or required by the strict profile, full routes load \`reflection\` after work/tests and before final; DFix/Answer/Help/Wiki/SKS discovery are exempt. Write reflection.md; record only real misses/gaps, or no_issue_acknowledged. For lessons, append TriWiki claim rows to ${REFLECTION_MEMORY_PATH}. Run "${commandPrefix} wiki refresh" or pack, validate, then pass reflection-gate.json.`;
}

async function installOfficialSkills(root: any) {
  const quarantinedUserCollisions: string[] = [];
  const quarantinedManifestCollisions = await prepareReservedSkillManifestsForWrite(root);
  const canonicalMadSksSqlPlanePolicy = madSksSqlPlanePolicyText()
    .replace(/^---[\s\S]*?---\s*/, '')
    .trim();
  const skills = {
    'dfix': `---\nname: dfix\ndescription: Direct Fix mode for $DFix or $dfix requests and inferred tiny copy/config/docs/labels/spacing/translation/simple mechanical edits.\n---\n\nUse for tiny copy/config/docs/labels/spacing/translation/simple mechanical edits. List exact micro-edits, inspect only needed files, apply only those edits, and run cheap verification. Keep broad implementation out of DFix; for UI/UX micro-edits read \`design.md\` when present and use imagegen for image/logo/raster assets. Bypass broad SKS routing, mission state, TriWiki/TriFix/reflection/state recording, Goal, Research, eval, redesign, and repeated full-route Honest Mode loops. Report the change, actual verification, and remaining issues once. ${CODEX_IMAGEGEN_REQUIRED_POLICY}\n`,
    'answer': `---\nname: answer\ndescription: Answer questions with research or docs; never implement.\n---\n\nUse for explanations, comparisons, status, facts, source-backed research, or docs guidance. Use repo/TriWiki first for project-local facts; hydrate low-trust claims from source. Browse or use Context7 for current external package/API/framework/MCP docs. End with a concise answer that separates what was verified from what was inferred; do not create missions, subagents, or file edits.\n`,
    'sks': `---\nname: sks\ndescription: General Sneakoscope Codex command route for $SKS or $sks usage, setup, status, and workflow help.\n---\n\nUse local SKS commands: bootstrap, deps, commands, quickstart, codex-app, context7, guard, conflicts, reasoning, wiki, pipeline status, pipeline plan, skill-dream. Execute general code-changing work in the current task; use Naruto only for explicit parallel work or concrete independent slices. Surface route/guard/scope, use TriWiki, do not edit installed harness files outside this engine repo, and clear conflicting third-party Codex harness markers via \`sks conflicts cleanup --yes\`. ${skillDreamPolicyText()}\n`,
    'plan': `---\nname: plan\ndescription: Write a plan artifact only; never edit product or source files.\n---\n\nUse when the user invokes $Plan or asks for a plan-only frontdoor. Produce a concrete plan artifact under .sneakoscope/plans/<slug>.md with goal, scope, files to inspect, implementation steps, acceptance checks, and rollback notes. Do not edit product/source files, generated harness files, package metadata, or docs beyond the plan artifact. Keep implementation_allowed=false and hand off execution to $Work only after the user or route explicitly moves from planning to work. Finish with what is planned, what remains unimplemented, and Honest Mode.\n`,
    'work': `---\nname: work\ndescription: Execute the latest plan with evidence-gated completion. 예: $Work\n---\n\nUse when the user invokes $Work or asks to execute the latest SKS plan. Resolve the newest .sneakoscope/plans/*.md, route execution through Naruto evidence gates, keep leases and verification artifacts current, and do not claim completion without machine evidence or explicit blocker evidence. If no plan exists, block with a clear next action: run $Plan first or provide a task.\n`,
    'review': `---\nname: review\ndescription: Parallel diff review with machine-evidence first findings. 예: $Review 또는 sks review --staged\n---\n\nUse when the user asks for $Review or sks review. Review the selected diff read-only unless --fix is explicitly supplied. Machine evidence such as TypeScript, lint, tests, conflict markers, or secret scans outranks LLM findings and must be tagged evidence: machine; judgment-only findings must be tagged evidence: llm. --fix may attempt at most one machine-evidence fix pass and must re-run verification once. Do not mutate code for LLM-only opinions.\n`,
    'fast-mode': `---\nname: fast-mode\ndescription: Dollar-command route for $Fast-Mode, $Fast-On, and $Fast-Off global Codex Desktop Fast mode toggles.\n---\n\nUse when the user invokes $Fast-Mode, $Fast-On, $Fast-Off, or asks to turn SKS Fast mode on/off. Prefer \`sks fast-mode on|off|status|clear --json\`. By default on/off updates the global Codex Desktop config so Codex Fast mode (official service_tier) persists and also keeps .sneakoscope/state/fast-mode.json in sync for SKS workers. Use \`--project\` only when the user explicitly wants project-local worker preference without touching global Codex config. Explicit runtime flags still win: \`--fast\`, \`--no-fast\`, and \`--service-tier standard|fast\` override the saved preference for that run. Finish with a short status and Honest Mode; do not start Naruto or broad implementation for a toggle-only request.\n`,
    'fast-on': `---\nname: fast-on\ndescription: Alias for $Fast-On global Codex Desktop Fast mode enablement.\n---\n\nUse the same rules as fast-mode. Run or instruct \`sks fast-mode on --json\`, then report Global (desktop), Project (sks workers), state file, and the fact that explicit per-run flags still override the saved preference.\n`,
    'fast-off': `---\nname: fast-off\ndescription: Alias for $Fast-Off global Codex Desktop Fast mode disablement.\n---\n\nUse the same rules as fast-mode. Run or instruct \`sks fast-mode off --json\`, then report Global (desktop), Project (sks workers), state file, and the fact that explicit per-run flags still override the saved preference.\n`,
    'wiki': `---\nname: wiki\ndescription: Dollar-command route for $Wiki TriWiki pack/validate/image tools; code-index rebuild uses $Align.\n---\n\nUse for $Wiki pack, validate, prune, image/voxel, or wrongness requests. Code-index / wiki+pack rebuild SSOT is \`$Align\` / \`sks align run\` (NC-21). \`sks wiki refresh --code\` aliases into align and is not a parallel truth source. Memory pack refresh without --code may still use \`sks wiki refresh\` then validate .sneakoscope/wiki/context-pack.json. Prune: \`sks wiki prune --dry-run\` first. Do not start ambiguity-gated implementation, nested subagents, or unrelated work. Finish with Honest Mode once at the end.\n`,
    'align': `---\nname: align\ndescription: Dollar-command route for $Align code-only TriWiki rebuild including wiki/pack.\n---\n\nUse when the user invokes $Align or asks to rebuild TriWiki from current repository code. Align is independent of triwiki-cleanup / $Cleanup and does not require a cleanup receipt. Run \`sks align prepare\` then \`sks align run\` (or \`sks align run\` directly). context-graph.json is exhaustive authority; context-pack and managed AGENTS.md are bounded projections. Fail closed on caps/binary/oversized sources. Do not nest subagents. Agents never run \`sks doctor --fix\`. Report actual verification and remaining gaps once; reflection and Honest Mode are optional unless requested or required by the strict profile.\n`,
    'cleanup': `---\nname: cleanup\ndescription: Dollar-command route for $Cleanup / triwiki-cleanup R3 destructive TriWiki blanking.\n---\n\nUse only when the user invokes $Cleanup or explicitly asks for triwiki-cleanup (blank/reset active TriWiki). This is NOT harness-conflicts-cleanup (\`sks conflicts cleanup\`). Run \`sks cleanup plan\` first, then \`sks cleanup run --apply\` only after the plan is reviewed. No backup/quarantine/restore generation is retained on success. Preserve repository source, ordinary docs, missions, and release evidence. Never run \`sks doctor --fix\`. Do not start Naruto, nested subagents, or unrelated implementation from this route.\n`,
    'from-chat-img': `---\nname: from-chat-img\ndescription: Explicit $From-Chat-IMG Naruto add-on gate for chat screenshot plus attachment analysis.\n---\n\nUse only for From-Chat-IMG/$From-Chat-IMG. It enters the Naruto pipeline with from_chat_img_required=true and an add-on coverage gate. Treat uploads as chat screenshot plus originals. For web/browser/webapp targets use Codex Chrome Extension first; for native Mac/non-web app surfaces use Codex Computer Use visual inspection when available. List requirements first, match regions to attachments with confidence, write ${FROM_CHAT_IMG_COVERAGE_ARTIFACT}, ${FROM_CHAT_IMG_CHECKLIST_ARTIFACT}, ${FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT}, and ${FROM_CHAT_IMG_QA_LOOP_ARTIFACT}, then continue Naruto worker proof, review, reflection, and Honest Mode. ${CODEX_WEB_VERIFICATION_POLICY} ${CODEX_COMPUTER_USE_ONLY_POLICY} The ledger must account for every visible customer request, screenshot image region, and separate attachment; ${FROM_CHAT_IMG_CHECKLIST_ARTIFACT} must have a checked item for each request, image-region/attachment match, work item, scoped QA-LOOP, and verification step; ${FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT} stores temporary TriWiki-backed session context with expires_after_sessions=${FROM_CHAT_IMG_TEMP_TRIWIKI_SESSIONS}. ${FROM_CHAT_IMG_QA_LOOP_ARTIFACT} must prove QA-LOOP ran over the exact customer-request work-order range after implementation, with every work item covered, post-fix verification complete, and zero unresolved findings. naruto-gate.json cannot pass From-Chat-IMG completion until from_chat_img_request_coverage=true, unresolved_items is empty, every checklist box is checked, and scoped_qa_loop_completed=true.\n`,
    'qa-loop': `---\nname: qa-loop\ndescription: $QA-LOOP dogfoods UI/API as human proxy with safety gates, Codex Chrome Extension-first web UI evidence, safe fixes, rechecks, and a QA report.\n---\n\nUse only $QA-LOOP. Infer scope, target, mutation policy, and login boundary from the prompt plus TriWiki/current-code defaults; do not surface a prequestion sheet. Credentials are runtime-only; never save secrets. Web/browser/webapp UI-level E2E must run the Codex Chrome Extension readiness gate first; if the extension is missing or disabled, rapidly halt and ask the user to set it up, then resume only after the user confirms installation is complete. Codex Computer Use is reserved for native Mac/non-web surfaces and must not satisfy web UI evidence. Playwright, Selenium, Puppeteer, Browser Use, Chrome MCP, screenshots fabricated from code, and prose-only checks do not satisfy web UI/browser verification. ${CODEX_WEB_VERIFICATION_POLICY} Deployed targets are read-only; destructive removal is forbidden. After answer/run, dogfood real flows, apply safe contract-allowed code/test/docs fixes, recheck, and do not pass qa-gate.json with unresolved findings or without post_fix_verification_complete. Finish qa-ledger, date/version report, gate, completion summary, and Honest Mode.\n`,
    'ppt': `---\nname: ppt\ndescription: $PPT information-first HTML/PDF presentation pipeline with inferred STP, audience, pain-point, format, research, design-system, and verification contract.\n---\n\nUse only when the user invokes $PPT or asks to create a presentation, deck, slides, pitch deck, proposal deck, HTML presentation, or PDF presentation artifact. Before artifact work, auto-seal presentation-specific answers from prompt, TriWiki/current-code defaults, and conservative policy: delivery context, target audience profile including role/average age/job/industry/topic familiarity/decision power, STP strategy, decision context and objections, and 3+ pain-point to solution mappings with expected aha moments. Do not surface a prequestion sheet. Presentation design must be simple, restrained, and information-first: avoid over-designed decoration, ornamental gradients, nested cards, and effects that compete with the message. Design detail should be embedded through typography hierarchy, spacing, alignment, thin rules, source clarity, and subtle accents. ${pptPipelineAllowlistPolicyText()} Use Product Design plugin first for context, ideation, prototype direction, audit, design QA, and share handoff. Use design.md only as an existing project-local cache or fallback SSOT when Product Design is unavailable; if fallback creation is needed, use docs/Design-Sys-Prompt.md plus getdesign-reference and curated DESIGN.md examples from ${AWESOME_DESIGN_MD_REFERENCE.url} only as source inputs, then fuse them into route-local PPT style tokens with a recorded design_ssot instead of treating references as parallel authorities. The $PPT route always loads imagegen as a required skill, checks Codex App imagegen at route start, and runs SKS auto-repair once before any image-dependent build/review work. If repair fails, stop with codex_imagegen_unavailable and do not continue with image-free or API-substituted evidence. When the sealed contract needs a generated raster asset or generated slide visual critique, immediately invoke Codex App \`$imagegen\` with gpt-image-2, move/copy the selected output into the mission assets or review evidence path, and record the real file path in ppt-image-asset-ledger.json or ppt-review-ledger.json before building or passing the gate. Direct API fallback, placeholder files, HTML/CSS stand-ins, and prose-only substitutes do not satisfy the route gate. ${productDesignPluginPolicyText()} ${CODEX_IMAGEGEN_REQUIRED_POLICY} Use web or Context7 evidence only when external facts/libraries/current docs are required by the PPT contract, record verified claims in ppt-fact-ledger.json, record generated image asset plans/results/blockers in ppt-image-asset-ledger.json, then create the PDF plus editable source HTML under source-html/, keep independent strategy/render/file-write phases parallel where inputs allow, record ppt-parallel-report.json, run the bounded ppt-review-policy/ppt-review-ledger/ppt-iteration-report loop, and verify readability, overlap, format fit, source coverage, export state, unsupported-claim status, image-asset completion, review-loop termination, and temporary build files cleanup. Finish with reflection and Honest Mode.\n`,
    'computer-use-fast': `---\nname: computer-use-fast\ndescription: Alias for the maximum-speed $Computer-Use/$CU native Codex Computer Use lane.\n---\n\nUse the same rules as computer-use: skip Naruto delegation, QA-LOOP clarification, upfront TriWiki refresh, Context7, subagents, and reflection unless explicitly requested. Use Codex Computer Use directly only for native macOS, desktop-app, OS-settings, or non-web visual tasks. Browser, localhost, website, webapp, and web-based app verification must use the Codex Chrome Extension path first and must halt if that extension is not installed/enabled. At the end only, refresh/pack TriWiki, validate it, then provide a concise completion summary that separates what was verified from what was not. ${CODEX_WEB_VERIFICATION_POLICY} ${CODEX_COMPUTER_USE_ONLY_POLICY}\n`,
    'cu': `---\nname: cu\ndescription: Short alias for the maximum-speed native $Computer-Use Codex Computer Use lane.\n---\n\nUse the same rules as computer-use. This is a speed lane for native macOS, desktop-app, OS-settings, and non-web visual tasks requiring Codex Computer Use evidence, with TriWiki refresh/validate and Honest Mode deferred to final closeout. Web/browser/webapp verification must use Codex Chrome Extension first and stop if the extension is not installed/enabled. ${CODEX_WEB_VERIFICATION_POLICY} ${CODEX_COMPUTER_USE_ONLY_POLICY}\n`,
    'goal': `---\nname: goal\ndescription: Codex-native $Goal/$goal control with detailed completion criteria and no SKS-owned Goal state.\n---\n\nUse when the user invokes $Goal/$goal or asks to create, edit, view, pause, resume, or clear a persisted goal. Use only Codex native Goal controls or the callable native goal tool. Do not run sks goal, create an SKS mission, write bridge artifacts, compile a compatibility loop, create fallback Goal state, refresh TriWiki, or open subagents for the Goal control turn. Before create or edit, expand the request into explicit Outcome, Scope, Constraints, Verification, Done when, Stop conditions, and Non-goals. Completion criteria must be measurable and must stop work once satisfied; forbid unrelated refactors, speculative expansion, and open-ended polishing. If native Goal is unavailable, report that limitation instead of substituting an SKS implementation.\n`,
    'release-review': `---\nname: release-review\ndescription: Review release readiness through official Codex subagents.\n---\n\nUse only when the user invokes $Release-Review or asks for a release-readiness review. Run it through \`sks naruto run \"$Release-Review release audit\" --agents <n> --read-only --json\` or the current Codex parent session. The parent owns decomposition, waits for every official worker/expert thread, integrates one structured outcome per thread, and records subagent-plan.json, subagent-events.jsonl, subagent-parent-summary.json, and subagent-evidence.json. No alternate Release-Review runtime is supported. Finish with release-readiness verification and Honest Mode.\n`,
    'commit': `---\nname: commit\ndescription: Simple git-only route for $Commit requests that stage current changes and create one commit without the full SKS pipeline.\n---\n\nUse only when the user invokes $Commit or explicitly asks to commit the current repository changes without pushing. Keep this route lightweight: inspect git status and the relevant diff summary, avoid Naruto/pipeline/TriWiki route work unless separately requested, stage the intended current changes, and create one git commit. The commit message must summarize the actual work and include exactly one trailer: Co-authored-by: Codex <noreply@openai.com>. Do not push. If there are no changes, report that no commit was created. Finish with a concise result and a one-line Honest Mode covering the commit hash and any unverified items.\n`,
    'commit-and-push': `---\nname: commit-and-push\ndescription: Simple git-only route for $Commit-And-Push requests that stage current changes, create one commit, and push without the full SKS pipeline.\n---\n\nUse only when the user invokes $Commit-And-Push or explicitly asks to commit and push the current repository changes. Keep this route lightweight: inspect git status and the relevant diff summary, avoid Naruto/pipeline/TriWiki route work unless separately requested, stage the intended current changes, create one git commit, then push the current branch. The commit message must summarize the actual work and include exactly one trailer: Co-authored-by: Codex <noreply@openai.com>. If there are no changes, do not create an empty commit unless the user explicitly asks for one. Finish with a concise result and a one-line Honest Mode covering the commit hash, pushed branch, and any unverified items.\n`,
    'research': `---\nname: research\ndescription: Dollar-command route for $Research or $research frontier discovery workflows.\n---\n\nUse when the user invokes $Research/$research or asks for research, hypotheses, new mechanisms, falsification, or testable predictions. Prefer sks research prepare and sks research run. Research is not an implementation route: do not edit repository source, docs, package metadata, generated skills, or harness files; write only route-local mission artifacts under .sneakoscope/missions/<mission-id>/. Frame the research criteria and map assumptions before retrieval. First run layered Super Search across current papers, primary/official sources, standards, public discourse, practitioner evidence, background sources, and explicit counterevidence; only verified-content source rows may support real-run reviewer claims. Then run three independent official Codex subagent threads using the project custom agent research_reviewer, covering evidence integrity, method validity, and falsification or replication. Do not launch a custom debate scheduler, worker pool, or synthetic model fanout. Each reviewer must return a structured adversarial outcome with source ids, falsifiers, and cheap probes. Critical, major, or required revisions trigger a mission-local research_synthesizer revision and a fresh three-thread review cycle within the bounded cycle cap; minor concerns remain advisory. agent-ledger.json and debate-ledger.json are compatibility projections from official reviewer outcomes, not independent runtime proof. Record research-source-skill.md, source-ledger.json, claim-evidence-matrix.json, novelty-ledger.json, falsification-ledger.json, research-report.md, the dated research paper, research-adversarial-review.json, research-revision-ledger.json, research-adversarial-convergence.json, research-honest-mode.json, and research-gate.json. Context7 is required only when the topic depends on current package/API/framework docs. Do not use --mock except for selftests; if live source execution is unavailable, record a blocker and keep the gate unpassed. Do not overclaim novelty, breakthrough, publication acceptance, or experimental support beyond the recorded evidence. Do not use for ordinary code edits.\n`,
    'autoresearch': `---\nname: autoresearch\ndescription: Dollar-command route for $AutoResearch or $autoresearch iterative experiment loops.\n---\n\nUse for $AutoResearch, iterative improvement, ranking, workflow, benchmark, or experiments. Define program, hypothesis, experiment, metric, keep/discard, falsification, next step, and Honest Mode. Do not become the parent identity for SEO/GEO; $SEO-GEO-OPTIMIZER may call research as a child stage for query, market, or competitor discovery while keeping the parent mission, gate, and Completion Proof on $SEO-GEO-OPTIMIZER.\n`,
    'db': `---\nname: db\ndescription: Dollar-command route for $DB or $db database and Supabase safety checks.\n---\n\nUse when the user invokes $DB/$db or the task touches SQL, Supabase, Postgres, migrations, Prisma, Drizzle, Knex, MCP database tools, or production data. The route automatically materializes db-safety-scan.json and db-review.json plus db-access-candidates.json, db-access-review.json, code-structure-report.json, and engineering-sanity-review.json; there is no public CLI database subcommand. Inspect existing DB entry points and real callers first, then bind db-access-review.json to the generated candidate scan. Reuse the canonical adapter/query helper and prove one owned pool/client lifecycle, bounded acquire/release/shutdown/reconnect behavior, N+1/repeated-I/O review, and transaction/rollback/error propagation/idempotency/post-commit invariants for sensitive, payment, ledger, or multi-step mutations. Outside MAD-SKS, never mutate a live database: if a migration is needed, finish with exactly one mission-local manual-migration.sql containing active forward SQL and a complete rollback section that stays commented out, record its SHA-256, and tell the user to apply it manually and run rollback separately only if needed. When $MAD-SKS is explicitly combined with $DB, route directly to the bound capability-v2 SQL-plane MCP instead of generating a manual file; use \`sks mad-sks plan|sql|apply-migration\` for the explicit SQL-plane lifecycle and require independent read-back, capability close, and read-only restoration.\n`,
    'mad-sks': `---\nname: mad-sks\ndescription: Explicit high-risk authorization modifier plus SQL-plane executor for $MAD-SKS.\n---\n\nUse only when the user explicitly invokes $MAD-SKS, top-level sks --mad, or \`sks mad-sks plan|run|apply|sql|apply-migration|status|close|rollback-apply\`. MAD-SKS is the single high-risk route for scoped permission widening and bound SQL-plane execution. It can be combined with another route, such as $MAD-SKS $Naruto or $DB ... $MAD-SKS; in that case the other command remains the primary workflow and MAD-SKS is the temporary permission grant or SQL-plane executor. The widened permission applies only while the active mission gate is open, must be deactivated when the task ends, and can open approved scopes such as target-project file writes, shell commands, package installs, local service control, network operations, browser/Computer Use workflows, generated assets, file permissions, migrations, Supabase MCP database writes, column/schema cleanup, direct execute SQL, and normal targeted DB writes.\n\nSQL-plane policy:\n${canonicalMadSksSqlPlanePolicy}\n\nCatastrophic SQL boundary: TRUNCATE, all-row UPDATE/DELETE, table/schema/database DROP, and equivalent reset operations are allowed only through the SQL-plane executor and only when the user's prompt or CLI SQL statement literally names that operation. Other MAD-SKS executors, including db-write, keep those catastrophic categories blocked. Whole database/schema/table removal outside SQL-plane, dangerous project/branch management, credential exfiltration, persistent security weakening, destructive delete without explicit confirmation, and unrequested fallback implementation remain blocked. Do not carry MAD-SKS permission into later prompts or routes. The permission profile source is centralized in src/core/permission-gates.ts and emitted as dist/core/permission-gates.js so skill/hook/MCP-style gates share one decision function.\n`,
    'gx': `---\nname: gx\ndescription: Dollar-command route for $GX or $gx deterministic GX visual context cartridges.\n---\n\nUse when the user invokes $GX/$gx or asks for architecture/context visualization through SKS. Prefer sks gx init, render, validate, drift, and snapshot. vgraph.json remains the source of truth.\n`,
    'help': `---\nname: help\ndescription: Dollar-command route for $Help or $help explaining installed SKS commands and workflows.\n---\n\nUse when the user invokes $Help/$help or asks what commands exist. Prefer concise output from sks commands, sks usage <topic>, sks quickstart, sks aliases, and sks codex-app.\n`,
    'prompt-pipeline': `---\nname: prompt-pipeline\ndescription: Default SKS prompt routing for execution requests; Answer and DFix remain lightweight.\n---\n\nClassify only the route and the constraints that change execution. Answer handles real information requests; DFix handles tiny copy/config/docs/labels/spacing/translation/mechanical edits; general work stays parent-owned and uses Naruto only for explicit parallel work or concrete independent slices. Preserve the literal user request; TriWiki may enrich it but never replace an explicit requirement. ${coreEngineeringDirectiveReferenceText()} For code work, identify the requested outcome, actual code/data flow, exact write scope, acceptance criteria, and the smallest meaningful verification. Load route-specific Design, PPT, image, browser, research, DB, release, or Context7 rules only when that route or external contract requires them. Materialize pipeline-plan.json with route, scopes, verification, and blockers, then finish the requested work instead of stopping at the plan.\n`,
    [SOLUTION_SCOUT_SKILL_NAME]: `---\nname: ${SOLUTION_SCOUT_SKILL_NAME}\ndescription: Optional source scout for fixes that materially depend on external precedent.\n---\n\nUse only when the user asks for similar cases or when a package, API, platform, or externally documented behavior makes outside precedent materially useful. Search with the concrete symptom and current stack, prefer primary sources, and keep the local code path authoritative. Do not add this step to ordinary local bugfixes. If external evidence is unavailable, record that gap instead of inventing a workaround.\n`,
    'reasoning-router': `---\nname: reasoning-router\ndescription: Inspect task reasoning hints while preserving the user's selected Codex settings.\n---\n\nUse the active Codex model catalog for supported reasoning efforts. GPT-6 Astra does not support none/minimal; use low when migrating those efforts, and preserve other supported choices. Task hints are advisory: do not override the selected model, effort, or service tier or persist profile changes without a request. Inspect with sks reasoning and sks pipeline status. Keep the Luna/Astra child role defaults when the parent uses Astra.\n`,
    'pipeline-runner': `---\nname: pipeline-runner\ndescription: Execute SKS routes with bounded state and evidence.\n---\n\nEvery $ command selects a route. Use current.json, mission artifacts, and pipeline-plan.json as bounded execution state; load only the selected route skill. ${coreEngineeringDirectiveReferenceText()} Codex native /goal is the only persisted goal owner. Use official Codex subagents only when the route requires independent slices, keep parent-owned integration, use bounded TriWiki context, fetch current external docs only when relevant, record real blockers, and finish with a completion summary that states what was verified and what remains. Reflection and Honest Mode sections are strict-profile requirements only.\n`,
    'context7-docs': `---\nname: context7-docs\ndescription: Enforce Context7 MCP documentation evidence for SKS routes that depend on external libraries, frameworks, APIs, MCPs, package managers, DB SDKs, or generated docs.\n---\n\nWhen required, resolve-library-id, then query-docs for the resolved id. Legacy get-library-docs evidence is accepted. Prefer sks context7 tools/resolve/docs/evidence and finish only after both evidence stages exist. Check setup with sks context7 check.\n`,
    'super-search': `---\nname: super-search\ndescription: Dollar-command route for $Super-Search provider-independent source intelligence.\n---\n\nUse when the user invokes $Super-Search or asks for Super-Search source intelligence, source acquisition, X-search-style collection, URL acquisition, source normalization, claim ledgers, or citation proof. Prefer \`sks super-search doctor --json\` for readiness and \`sks super-search run "<query>" --mode balanced --json\` for provider-independent source proof; use \`sks super-search x "<query>" --json\` for X-search intent and \`sks super-search fetch "<url>" --json\` for URL acquisition. Context7 is required only when the query depends on current package/API/framework/MCP/generated documentation behavior. Provider-specific credentials are optional and must not be required for route readiness. Evidence/artifacts remain under \`.sneakoscope/missions/<super-search-* or route mission>/super-search/\`: intent.json, axes.json, query-variants.json, provider-plan.json, source-ledger.json, lead-ledger.json, claim-ledger.json, attempt-ledger.json, synthesis.md, super-search-proof.json, super-search-gate.json, and super-search-result.json. Do not turn weak discovery into supported claims; finish with an Honest Mode summary of verified sources, blockers, and unverified external coverage.\n`,
    'search-visibility-core': `---\nname: search-visibility-core\ndescription: Shared kernel for seo-geo-optimizer audit, plan, explicit apply, rollback, verification, gates, and Completion Proof.\n---\n\nPurpose: keep Search Engine Optimization and Generative Engine Optimization on one typed search-visibility kernel instead of duplicate implementations. Use when $SEO-GEO-OPTIMIZER or \`sks seo-geo-optimizer\` is selected. Workflow: doctor detects package/static/Next evidence; audit writes source-backed inventory and findings; plan compiles safe mutation operations; apply requires explicit \`--apply\`; verify separates source, build, HTTP, browser, production, and measured outcome; rollback only reverses mission-owned operations. Safety: default read-only, never overwrite unmanaged robots.txt, sitemap, llms.txt, metadata, or structured data; do not hard-code customer routes; do not invent prices, reviews, availability, rankings, traffic, or AI citation outcomes. Evidence/artifacts: search-visibility/intake.json, adapter-detection.json, site-inventory.json, route-graph.json, robots-policy.json, structured-data-ledger.json, mutation-plan.json, mutation-journal.jsonl, rollback-manifest.json, verification-report.json, route gate, and completion-proof.json. Failure/recovery: unsupported frameworks stay audit/plan-only; missing production/browser/Search Console evidence remains unverified, not fabricated. CLI entrypoint: \`sks seo-geo-optimizer ... --mode seo|geo\`.\n`,
    'seo-geo-optimizer': `---\nname: seo-geo-optimizer\ndescription: Unified $SEO-GEO-OPTIMIZER route for Search Engine Optimization and Generative Engine Optimization.\n---\n\nPurpose: use one route name for SEO and GEO work while keeping the internal search-visibility mode explicit. Use when: the user asks for SEO audit/fix/verification, package/npm/GitHub search visibility, canonical, sitemap, robots.txt, hreflang, metadata, structured data, AI answer visibility, LLM citation readiness, answerability, entity/claim provenance, crawler policy, OAI-SearchBot/GPTBot/ChatGPT-User, Claude-SearchBot/ClaudeBot/Claude-User, or optional llms.txt planning. GEO means Generative Engine Optimization, not geolocation, GeoIP, maps, CDN geography, location permission, or regional redirect bugs. Workflow: run \`sks seo-geo-optimizer doctor --mode seo|geo\`, then audit, plan, explicit apply, verify, status, and rollback. Use \`--mode seo\` for technical/package search optimization and \`--mode geo\` for entity facts, claim evidence, answerability, crawler policy, and optional llms.txt. Safety: audit and plan must not mutate source; apply checks base hashes, ownership, scope, protected paths, rollback manifest, and post-verify. AI crawler policy must split search, training, user-directed retrieval, and ads/other; never use one allow_ai toggle and never auto-allow training crawlers. Evidence/artifacts: site-inventory.json, route-graph.json, seo-findings.json or geo-findings.json, entity-facts.json, claim-evidence-ledger.json, answerability-report.json, ai-crawler-policy.json, llms-txt-plan.json, mutation-plan.json, verification-report.json, seo-gate.json or geo-gate.json, completion-proof.json. Failure/recovery: unsupported frameworks stay plan-only; browser/production/Search Console/analytics outcomes are marked unverified when not actually run. Forbidden claims: no ranking, indexing, traffic lift, rich-result, answer inclusion, or AI citation guarantee; no keyword stuffing, doorway pages, fake reviews, fake prices, fake availability, fake shipping, fake awards, hidden AI-only text, or scaled spam. CLI entrypoint: \`sks seo-geo-optimizer doctor|audit|plan|apply|verify|status|rollback|fixture --mode seo|geo\`.\n`,
    'reflection': `---\nname: reflection\ndescription: Post-route self-review for full SKS routes that records real misses, gaps, and corrective lessons into TriWiki memory.\n---\n\nUse when explicitly requested or required by the strict profile, after work/tests and before final. Do not invent faults. Write reflection.md; append real lessons to ${REFLECTION_MEMORY_PATH}; refresh/pack, validate context-pack.json, pass reflection-gate.json.\n\n${reflectionInstructionText()}\n`,
    'honest-mode': `---\nname: honest-mode\ndescription: Optional explicit self-audit before a completion claim; run it when asked for $Honest-Mode, or when the strict verification profile requires it.\n---\n\nWhen invoked: restate the goal, compare the result to the evidence actually produced, list the tests/commands/inspections that ran, and state uncertainty or blockers plainly. Do not claim completion beyond evidence. In the essential profile this is a tool the user reaches for, not a gate every finish must pass; in the strict profile full routes still pass reflection-gate.json first and end with a concise SKS Honest Mode (솔직모드) section.\n`,
    'autoresearch-loop': `---\nname: autoresearch-loop\ndescription: Iterative AutoResearch-style loop for open-ended improvement, discovery, prompt, ranking, SEO/GEO, and workflow-quality tasks.\n---\n\nUse for research, ranking, prompt/workflow improvement, benchmark gains, or repeated refinement. Loop: program, hypothesis, smallest falsifying experiment, metric, keep/discard, falsify, next step. Keep a ledger and do not claim improvement without evidence.\n`,
    'hproof-claim-ledger': `---\nname: hproof-claim-ledger\ndescription: Extract atomic claims and classify support status.\n---\n\nEvery factual statement must become an atomic claim. Unsupported critical claims cannot be used for implementation or final answer. Database claims require DB safety evidence.\n`,
    'hproof-evidence-bind': `---\nname: hproof-evidence-bind\ndescription: Bind claims to code, tests, decision contract, vgraph, beta, wiki, or GX render evidence.\n---\n\nEvidence priority: current code/tests, decision-contract.json, vgraph.json, beta.json, GX snapshot/render metadata, LLM Wiki coordinate index, user prompt. Database claims must respect .sneakoscope/db-safety.json. Wiki claims should carry id, hash, source path, and RGBA/trig coordinate anchors so they can be hydrated instead of treated as unsupported summaries.\n`,
    'db-safety-guard': `${dbSafetyGuardSkillText()}\n`,
    'gx-visual-generate': `---\nname: gx-visual-generate\ndescription: Render a deterministic SVG/HTML visual sheet from vgraph.json and beta.json.\n---\n\nUse sks gx render. vgraph.json is source of truth; renders embed source hash and RGBA wiki anchors.\n`,
    'gx-visual-read': `---\nname: gx-visual-read\ndescription: Read a Sneakoscope Codex deterministic visual sheet and produce context notes.\n---\n\nExtract nodes, edges, invariants, tests, risks, uncertainties, and RGBA anchors from source/render/snapshot. Do not infer hidden nodes.\n`,
    'gx-visual-validate': `---\nname: gx-visual-validate\ndescription: Validate render metadata against vgraph.json and beta.json.\n---\n\nRun sks gx validate and drift; fail stale or incomplete hashes, nodes, edges, invariants, or anchors.\n`,
    'turbo-context-pack': `---\nname: turbo-context-pack\ndescription: Build ultra-low-token context packet with Q4 bits, Q3 tags, top-K claims, and minimal evidence.\n---\n\nDefault to Q4/Q3 plus TriWiki RGBA anchors and attention.use_first. Add Q2/Q1 only when needed or when attention.hydrate_first says source hydration is required. Keep id, hash, path, and coordinate tuple for hydration.\n`,
    'performance-evaluator': `---\nname: performance-evaluator\ndescription: Evaluate SKS performance, evidence-backed token usage, serialized-size proxies, accuracy-proxy, context-compression, or workflow improvements.\n---\n\nUse sks eval run/compare before claims. Treat serialized_size_bytes as a deterministic non-token proxy. Claim token savings only when actual baseline and candidate token counts include an evidence source; otherwise report token savings as not measured. Report accuracy_delta/proxy, required_recall, support, and meaningful_improvement without substituting proxy size for token evidence.\n`,
    'imagegen': `---\nname: imagegen\ndescription: Required bridge to Codex App built-in image generation for logos, image assets, raster visuals, and image edits.\n---\n\nUse for generated or edited image assets: logo, product image, illustration, sprite, mockup, texture, cutout, or bitmap. Prefer the official Codex App built-in image generation feature documented at ${CODEX_APP_IMAGE_GENERATION_DOC_URL}: ask naturally or invoke \`$imagegen\`. SKS route code checks capability before image-dependent routes, attempts doctor imagegen repair once, and reports codex_imagegen_unavailable if Codex App $imagegen still is not ready. For newest-model requests, make the prompt explicit: "Use ChatGPT Images 2.0 / GPT Image 2.0 with gpt-image-2." Useful official references are ${OPENAI_CHATGPT_IMAGES_2_DOC_URL}, ${OPENAI_GPT_IMAGE_2_MODEL_DOC_URL}, and ${OPENAI_IMAGE_GENERATION_DOC_URL}. Codex App image generation counts against Codex usage limits. Capability detection is not output proof; full SKS evidence requires a real selected raster output path or generated review image artifact. Direct OpenAI API fallback is non-Codex evidence and does not satisfy SKS route evidence unless a separate non-Codex API task is explicitly requested. ${IMAGEGEN_SOCIAL_SOURCE_POLICY} ${CODEX_IMAGEGEN_REQUIRED_POLICY} Do not substitute placeholder SVG/HTML/CSS for requested raster assets; follow design.md when relevant.\n`,
    'imagegen-source-scout': `---\nname: imagegen-source-scout\ndescription: Source scout for current GPT Image 2.0/gpt-image-2 prompt guidance, official docs, and X/social workflow signals.\n---\n\nUse when the user asks for the latest imagegen docs, ChatGPT Images 2.0 / GPT Image 2.0 / gpt-image-2 behavior, X/social reactions, prompt examples, or community workflow hints before creating an image prompt or SKS imagegen policy. Source order: official OpenAI announcement (${OPENAI_CHATGPT_IMAGES_2_DOC_URL}), Codex App image generation docs (${CODEX_APP_IMAGE_GENERATION_DOC_URL}), gpt-image-2 model docs (${OPENAI_GPT_IMAGE_2_MODEL_DOC_URL}), OpenAI Image Generation API docs (${OPENAI_IMAGE_GENERATION_DOC_URL}), then public X/social/community search for prompt-quality heuristics only. ${IMAGEGEN_SOCIAL_SOURCE_POLICY} If social or web search is unavailable, record that social coverage is unverified and continue from official docs. Output a compact evidence split: official capability/evidence rules, prompt heuristics, social/workflow signals, and blockers. Do not generate images itself; pair this with the imagegen skill for actual raster output.\n`,
    'getdesign-reference': `---\nname: getdesign-reference\ndescription: Use getdesign.md official design reference as an input to the design.md SSOT for UI/UX, presentation, and HTML/PDF systems.\n---\n\nUse when creating or improving design.md, UI/UX design systems, deck-like HTML artifacts, presentation PDFs, or brand-inspired visual systems. design.md is the only design decision SSOT; reference ${GETDESIGN_REFERENCE.url}, ${GETDESIGN_REFERENCE.docs_url}, and ${AWESOME_DESIGN_MD_REFERENCE.url} only as source inputs to synthesize or update that SSOT or a route-local style-token artifact. Prefer the official Codex skill if available with \`${GETDESIGN_REFERENCE.codex_skill_install}\`. If the skill CLI is unavailable, use this generated skill plus official docs/API/CLI/SDK references and curated DESIGN.md examples as inputs. Do not claim getdesign MCP is configured unless a current official MCP surface is actually installed.\n`,
    'design-system-builder': `---\nname: design-system-builder\ndescription: Create design.md only when Product Design is unavailable.\n---\n\nUse Product Design plugin first. Only when the plugin is unavailable or the route explicitly needs a local fallback SSOT, read docs/Design-Sys-Prompt.md as the builder prompt, inspect product/UI context, and use getdesign-reference, official getdesign.md docs, and curated DESIGN.md examples from ${AWESOME_DESIGN_MD_REFERENCE.url} only as source inputs. Fuse those inputs into one design.md fallback/cache with tokens, components, states, imagery, accessibility, and verification rules; do not leave multiple design files or references as competing authorities. Use the plan tool only for real ambiguity plus default font recommendation. Use imagegen for assets. ${productDesignPluginPolicyText()} ${CODEX_IMAGEGEN_REQUIRED_POLICY}\n`,
    'design-ui-editor': `---\nname: design-ui-editor\ndescription: Edit design.md UI/UX only when Product Design is unavailable.\n---\n\nUse Product Design plugin first. When falling back, read \`design.md\`, inspect relevant UI/assets/tests, consult getdesign-reference when improving the design system, apply the smallest design-system-conformant change, use imagegen for image/logo/raster assets, and verify render quality. ${productDesignPluginPolicyText()} ${CODEX_IMAGEGEN_REQUIRED_POLICY} If design.md is missing and Product Design is unavailable, use design-system-builder as fallback.\n`,
    'design-artifact-expert': `---\nname: design-artifact-expert\ndescription: Build UI prototypes only when Product Design is unavailable.\n---\n\nUse Product Design plugin first for design/UI/prototype work. When falling back, read design.md when present, consult getdesign-reference for design-system grounding, build the usable artifact first, preserve state, verify overlap/readability/responsiveness, and use imagegen for required assets. ${productDesignPluginPolicyText()} ${CODEX_IMAGEGEN_REQUIRED_POLICY}\n`
  };
  const nonCoreSkillNames = Array.from(new Set(Object.keys(skills)
    .map(currentSksInstalledSkillName)
    .filter((name) => !isCoreSkillName(name))));
  for (const [legacyName, content] of Object.entries(skills)) {
    const name = currentSksInstalledSkillName(legacyName);
    if (isCoreSkillName(name)) continue;
    const dir = path.join(root, '.agents', 'skills', name);
    const skillContent = markManagedSkill(name, currentSurfaceSkillText(enrichSkillContent(legacyName, content), name));
    const existing = await readConfinedOfficialSkillText(root, dir, name);
    if (existing.quarantined) quarantinedUserCollisions.push(name);
    if (typeof existing.text === 'string' && !isSksManagedOfficialSkill(existing.text)) {
      await quarantineSkillDir(root, dir, name, 'global-official-name-user-collision');
      quarantinedUserCollisions.push(name);
    }
    await ensureConfinedDirectory(root, dir);
    await writeTextAtomic(path.join(dir, 'SKILL.md'), `${skillContent.trim()}\n`);
    await writeSkillMetadata(root, dir, name, skillContent);
  }
  const coreManifest = buildSksCoreSkillManifest();
  for (const skill of coreManifest.skills) {
    const dir = path.join(root, '.agents', 'skills', skill.canonical_name);
    const existing = await readConfinedOfficialSkillText(root, dir, skill.canonical_name);
    if (existing.quarantined) quarantinedUserCollisions.push(skill.canonical_name);
    if (typeof existing.text === 'string' && !isSksManagedOfficialSkill(existing.text)) {
      await quarantineSkillDir(root, dir, skill.canonical_name, 'global-official-core-name-user-collision');
      quarantinedUserCollisions.push(skill.canonical_name);
    }
  }
  const coreByName = new Map(coreManifest.skills.map((skill) => [skill.canonical_name, skill.content_sha256]));
  const coreIntegrity = await syncCoreSkillsIntegrity({
    root,
    apply: true,
    skillsRoot: path.join(root, '.agents', 'skills'),
    reportPath: path.join(root, '.sneakoscope', 'reports', 'core-skill-integrity.json')
  });
  const managedCoreSkillNames = coreIntegrity.rows
    .filter((row) => row.after_sha256 === coreByName.get(row.canonical_name) && row.action !== 'skip-user-authored')
    .map((row) => row.canonical_name);
  for (const name of managedCoreSkillNames) {
    const dir = path.join(root, '.agents', 'skills', name);
    const skillContent = await readText(path.join(dir, 'SKILL.md'), '');
    await writeSkillMetadata(root, dir, name, skillContent);
  }
  const skillNames = [...nonCoreSkillNames, ...managedCoreSkillNames];
  const staleGeneratedSkills = await removeStaleGeneratedSkillsFromManifest(root, skillNames);
  quarantinedUserCollisions.push(...staleGeneratedSkills.quarantined);
  const removedPluginSkillCollisions = await removeGeneratedPluginSkillCollisions(root);
  quarantinedUserCollisions.push(...removedPluginSkillCollisions.quarantined);
  await writeGeneratedSkillManifest(root, skillNames);
  const removedAgentSkillAliases = await removeGeneratedAgentSkillAliases(root, skillNames);
  quarantinedUserCollisions.push(...removedAgentSkillAliases.quarantined);
  const removedCodexSkillMirrors = await removeGeneratedCodexSkillMirrors(root, skillNames);
  quarantinedUserCollisions.push(...removedCodexSkillMirrors.quarantined);
  return {
    installed_skills: skillNames,
    generated_files: generatedSkillFiles(skillNames),
    core_skill_integrity: {
      ok: coreIntegrity.ok,
      template_version: coreIntegrity.template_version,
      installed_count: coreIntegrity.installed_count,
      restored_count: coreIntegrity.restored_count,
      user_collision_count: coreIntegrity.user_collision_count,
      report: '.sneakoscope/reports/core-skill-integrity.json'
    },
    removed_stale_generated_skills: [...staleGeneratedSkills.removed, ...removedPluginSkillCollisions.removed].sort(),
    removed_agent_skill_aliases: removedAgentSkillAliases.removed,
    removed_codex_skill_mirrors: removedCodexSkillMirrors.removed,
    quarantined_user_collisions: [...new Set(quarantinedUserCollisions)].sort(),
    quarantined_manifest_collisions: [...new Set(quarantinedManifestCollisions)].sort()
  };
}

async function readConfinedOfficialSkillText(
  root: string,
  dir: string,
  name: string
): Promise<{ text: string | null; quarantined: boolean }> {
  const dirInspection = await inspectConfinedPath(root, dir);
  if (!dirInspection.exists) return { text: null, quarantined: false };
  if (dirInspection.leafSymlink || !dirInspection.stat?.isDirectory()) {
    await quarantineSkillDir(root, dir, name, 'global-official-path-collision');
    return { text: null, quarantined: true };
  }
  const expected = [
    { target: path.join(dir, 'SKILL.md'), kind: 'file' },
    { target: path.join(dir, 'agents'), kind: 'directory' },
    { target: path.join(dir, 'agents', 'openai.yaml'), kind: 'file' }
  ] as const;
  for (const row of expected) {
    const inspected = await inspectConfinedPath(root, row.target);
    if (!inspected.exists) continue;
    const wrongType = row.kind === 'file' ? !inspected.stat?.isFile() : !inspected.stat?.isDirectory();
    if (inspected.leafSymlink || wrongType) {
      await quarantineSkillDir(root, dir, name, 'global-official-nested-path-collision');
      return { text: null, quarantined: true };
    }
  }
  const skillPath = path.join(dir, 'SKILL.md');
  const skillInspection = await inspectConfinedPath(root, skillPath);
  if (!skillInspection.exists) {
    const entries = await fsp.readdir(dir);
    if (entries.length > 0) {
      await quarantineSkillDir(root, dir, name, 'global-official-missing-skill-user-collision');
      return { text: null, quarantined: true };
    }
  }
  return {
    text: skillInspection.exists ? await fsp.readFile(skillPath, 'utf8') : null,
    quarantined: false
  };
}

function currentSksInstalledSkillName(value: unknown): string {
  const canonical = canonicalSkillNameFromValue(value);
  return sksPrefixedSkillName(canonical);
}

function currentSurfaceSkillText(content: unknown, installedName?: string): string {
  const prefixed = prefixKnownSksDollarReferences(content, [
    ...LEGACY_DOLLAR_SKILL_NAMES,
    ...legacyCoreSkillNames(),
    ...LEGACY_SKS_SUPPORT_SKILL_NAMES.filter((name) => name !== 'imagegen')
  ]);
  const named = installedName
    ? prefixed.replace(/^name:\s*.+$/m, `name: ${installedName}`)
    : prefixed;
  const description = skillFrontmatterDescription(named);
  if (!description) return named;
  return named.replace(
    /^description:\s*.*$/m,
    `description: ${JSON.stringify(compactSkillDiscoveryDescription(description))}`
  );
}

export interface SkillReconcileReport {
  schema: 'sks.skill-reconcile.v1';
  ok: boolean;
  scope: 'global' | 'project';
  target_dir: string;
  fix: boolean;
  installed: string[];
  updated: string[];
  removed: string[];
  preserved_forge: string[];
  preserved_user: string[];
  quarantined_user_collisions: string[];
  quarantined_manifest_collisions?: string[];
  warnings: string[];
  installed_skills?: string[];
  generated_files?: string[];
  core_skill_integrity: {
    ok: boolean;
    template_version?: string;
    installed_count: number;
    restored_count: number;
    user_collision_count?: number;
    report?: string;
  };
  removed_stale_generated_skills?: string[];
  removed_agent_skill_aliases?: string[];
  removed_codex_skill_mirrors?: string[];
  retired_residue?: {
    detected_count: number;
    removed_count: number;
    quarantined_user_collision_count: number;
    rewritten_manifest_count?: number;
    quarantined_manifest_collision_count?: number;
    remaining_count: number;
    error_count: number;
  };
}

export interface RemovedSksSkillResidueReport {
  schema: 'sks.removed-skill-residue.v1';
  ok: boolean;
  fix: boolean;
  detected: Array<{ scope: string; name: string; path: string; ownership: 'sks_managed' | 'user_authored' }>;
  removed: string[];
  quarantined_user_collisions: string[];
  rewritten_manifests?: string[];
  quarantined_manifest_collisions?: string[];
  remaining: string[];
  errors: string[];
}

export async function installGlobalSkills(home: string): Promise<SkillReconcileReport> {
  return reconcileSkills({ targetDir: path.join(home, '.agents', 'skills'), scope: 'global', fix: true });
}

export async function installProjectSkills(root: string): Promise<SkillReconcileReport> {
  return reconcileSkills({ targetDir: path.join(root, '.agents', 'skills'), scope: 'project', fix: true });
}

export async function installSkills(root: any) {
  return installGlobalSkills(root);
}

type RemovedSkillCleanupTarget = {
  scope: 'global' | 'global-codex' | 'project' | 'project-codex' | 'global-runtime' | 'global-runtime-codex' | 'global-host-extra';
  ownerRoot: string;
  targetDir: string;
  /** Host extra dirs (Cursor/Claude) may hold user skills. Only SKS-owned retired names are removed. */
  managedOnly?: boolean;
};

function hostExtraRemovedSkillTargets(home: string): RemovedSkillCleanupTarget[] {
  return [
    { scope: 'global-host-extra', ownerRoot: home, targetDir: path.join(home, '.cursor', 'skills'), managedOnly: true },
    { scope: 'global-host-extra', ownerRoot: home, targetDir: path.join(home, '.claude', 'skills'), managedOnly: true },
  ];
}

export async function cleanupRemovedSksSkillResidue(opts: {
  root: string;
  home?: string;
  globalRuntimeRoot?: string;
  fix: boolean;
}): Promise<RemovedSksSkillResidueReport> {
  const projectRoot = path.resolve(opts.root);
  const home = path.resolve(opts.home || os.homedir());
  const globalRuntimeRoot = path.resolve(opts.globalRuntimeRoot || process.env.SKS_GLOBAL_ROOT || path.join(home, '.sneakoscope-global'));
  const targets: RemovedSkillCleanupTarget[] = [
    { scope: 'global', ownerRoot: home, targetDir: path.join(home, '.agents', 'skills') },
    { scope: 'global-codex', ownerRoot: home, targetDir: path.join(home, '.codex', 'skills') },
    { scope: 'project', ownerRoot: projectRoot, targetDir: path.join(projectRoot, '.agents', 'skills') },
    { scope: 'project-codex', ownerRoot: projectRoot, targetDir: path.join(projectRoot, '.codex', 'skills') },
    { scope: 'global-runtime', ownerRoot: globalRuntimeRoot, targetDir: path.join(globalRuntimeRoot, '.agents', 'skills') },
    { scope: 'global-runtime-codex', ownerRoot: globalRuntimeRoot, targetDir: path.join(globalRuntimeRoot, '.codex', 'skills') },
    ...hostExtraRemovedSkillTargets(home),
  ];
  if (projectRoot !== home && projectRoot !== globalRuntimeRoot) {
    const scan = await collectNestedProjectRoots(projectRoot, new Set([home, globalRuntimeRoot]));
    for (const root of scan.roots) targets.push(
      { scope: 'project', ownerRoot: projectRoot, targetDir: path.join(root, '.agents', 'skills') },
      { scope: 'project-codex', ownerRoot: projectRoot, targetDir: path.join(root, '.codex', 'skills') }
    );
  }
  if (opts.fix) {
    const lockOwners = new Map<string, { ownerRoot: string; scope: 'global' | 'project' }>();
    for (const target of targets) {
      const scope = target.scope.startsWith('project') ? 'project' as const : 'global' as const;
      const key = managedSkillGenerationLockPath(target.ownerRoot, scope);
      lockOwners.set(key, { ownerRoot: target.ownerRoot, scope });
    }
    const orderedLocks = [...lockOwners.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => value);
    return withManagedSkillCleanupLocks(
      orderedLocks,
      0,
      () => reconcileRemovedSkillTargets(targets, true)
    );
  }
  return reconcileRemovedSkillTargets(targets, opts.fix);
}

async function withManagedSkillCleanupLocks<T>(
  locks: Array<{ ownerRoot: string; scope: 'global' | 'project' }>,
  index: number,
  run: () => Promise<T>
): Promise<T> {
  const lock = locks[index];
  if (!lock) return run();
  return withManagedSkillGenerationLock(
    lock.ownerRoot,
    lock.scope,
    () => withManagedSkillCleanupLocks(locks, index + 1, run)
  );
}

async function reconcileRemovedSkillTargets(
  targets: RemovedSkillCleanupTarget[],
  fix: boolean
): Promise<RemovedSksSkillResidueReport> {
  const detected: RemovedSksSkillResidueReport['detected'] = [];
  const removed: string[] = [];
  const quarantinedUserCollisions: string[] = [];
  const rewrittenManifests: string[] = [];
  const quarantinedManifestCollisions: string[] = [];
  const remaining: string[] = [];
  const errors: string[] = [];
  const uniqueTargets = new Map<string, RemovedSkillCleanupTarget>();
  for (const target of targets) {
    const key = path.resolve(target.targetDir);
    if (!uniqueTargets.has(key)) uniqueTargets.set(key, target);
  }

  for (const target of uniqueTargets.values()) {
    const ownerRoot = path.resolve(target.ownerRoot);
    const targetDir = path.resolve(target.targetDir);
    let ownerStat;
    try {
      ownerStat = await fsp.lstat(ownerRoot);
    } catch (error: unknown) {
      if (nodeErrorCode(error) === 'ENOENT') continue;
      errors.push(`${displayRemovedSkillPath(target, targetDir)}:${publicPathError(error, ownerRoot)}`);
      remaining.push(displayRemovedSkillPath(target, targetDir));
      continue;
    }
    if (ownerStat.isSymbolicLink() || !ownerStat.isDirectory()) {
      const code = ownerStat.isSymbolicLink() ? 'managed_path_boundary_symlink_refused' : 'managed_path_boundary_not_directory';
      errors.push(`${displayRemovedSkillPath(target, targetDir)}:${code}:${ownerRoot}`);
      remaining.push(displayRemovedSkillPath(target, targetDir));
      continue;
    }

    let targetInspection;
    try {
      targetInspection = await inspectConfinedPath(ownerRoot, targetDir);
    } catch (error: unknown) {
      errors.push(`${displayRemovedSkillPath(target, targetDir)}:${publicPathError(error, targetDir)}`);
      remaining.push(displayRemovedSkillPath(target, targetDir));
      continue;
    }
    if (!targetInspection.exists) continue;
    if (targetInspection.leafSymlink) {
      const displayPath = displayRemovedSkillPath(target, targetDir);
      detected.push({
        scope: target.scope,
        name: '@skills-root',
        path: displayPath,
        ownership: 'user_authored'
      });
      if (fix) {
        try {
          await quarantineSkillDir(ownerRoot, targetDir, 'skills-root', 'skills-root-symlink-collision');
          quarantinedUserCollisions.push(displayPath);
        } catch (error: unknown) {
          errors.push(`${displayPath}:${publicPathError(error, targetDir)}`);
        }
      }
      if (await confinedPathStillExists(ownerRoot, targetDir, errors, displayPath)) remaining.push(displayPath);
      if (fix) await removeEmptySkillParents(target, errors);
      continue;
    }
    if (!targetInspection.stat?.isDirectory()) {
      const displayPath = displayRemovedSkillPath(target, targetDir);
      errors.push(`${displayPath}:managed_path_directory_not_directory:${targetDir}`);
      remaining.push(displayPath);
      continue;
    }

    let rows: Dirent[];
    try {
      rows = await fsp.readdir(targetDir, { withFileTypes: true, encoding: 'utf8' });
    } catch (error: unknown) {
      const displayPath = displayRemovedSkillPath(target, targetDir);
      errors.push(`${displayPath}:${publicPathError(error, targetDir)}`);
      remaining.push(displayPath);
      continue;
    }
    const rowByName = new Map(rows.map((row) => [row.name, row]));

    for (const row of rows) {
      const name = canonicalSkillNameFromValue(row.name);
      if (!REMOVED_SKS_SKILL_NAME_SET.has(name)) continue;
      const dir = path.join(targetDir, row.name);
      const displayPath = displayRemovedSkillPath(target, dir);
      let managed = false;
      try {
        managed = await isManagedRemovedSkillPath(ownerRoot, dir);
      } catch (error: unknown) {
        errors.push(`${displayPath}:${publicPathError(error, dir)}`);
        remaining.push(displayPath);
        continue;
      }
      if (!managed && target.managedOnly) continue;
      detected.push({
        scope: target.scope,
        name,
        path: displayPath,
        ownership: managed ? 'sks_managed' : 'user_authored'
      });
      if (fix) {
        try {
          if (managed) {
            await removeManagedPathVerified(ownerRoot, dir);
            removed.push(displayPath);
          } else {
            await quarantineSkillDir(ownerRoot, dir, row.name, 'removed-skill-name-user-collision');
            quarantinedUserCollisions.push(displayPath);
          }
        } catch (error: unknown) {
          errors.push(`${displayPath}:${publicPathError(error, dir)}`);
        }
      }
      if (await confinedPathStillExists(ownerRoot, dir, errors, displayPath)) remaining.push(displayPath);
    }

    await reconcileRemovedSkillManifests(target, rowByName, fix, {
      rewrittenManifests,
      quarantinedManifestCollisions,
      remaining,
      errors
    }, { managedOnly: target.managedOnly === true });
    if (fix) await removeEmptySkillParents(target, errors);
  }

  return {
    schema: 'sks.removed-skill-residue.v1',
    ok: remaining.length === 0 && errors.length === 0,
    fix,
    detected,
    removed: Array.from(new Set(removed)).sort(),
    quarantined_user_collisions: Array.from(new Set(quarantinedUserCollisions)).sort(),
    rewritten_manifests: Array.from(new Set(rewrittenManifests)).sort(),
    quarantined_manifest_collisions: Array.from(new Set(quarantinedManifestCollisions)).sort(),
    remaining: Array.from(new Set(remaining)).sort(),
    errors: Array.from(new Set(errors)).sort()
  };
}

function displayRemovedSkillPath(target: RemovedSkillCleanupTarget, dir: string) {
  const rel = path.relative(target.ownerRoot, dir).split(path.sep).join('/');
  if (target.scope.startsWith('global-runtime')) return `$SKS_GLOBAL_ROOT/${rel}`;
  return target.scope.startsWith('global') ? `~/${rel}` : rel;
}

async function isManagedRemovedSkillPath(ownerRoot: string, dir: string): Promise<boolean> {
  const dirInspection = await inspectConfinedPath(ownerRoot, dir);
  if (!dirInspection.exists || dirInspection.leafSymlink || !dirInspection.stat?.isDirectory()) return false;
  const skillPath = path.join(dir, 'SKILL.md');
  const skillInspection = await inspectConfinedPath(ownerRoot, skillPath);
  if (!skillInspection.exists || skillInspection.leafSymlink || !skillInspection.stat?.isFile()) return false;
  const text = await fsp.readFile(skillPath, 'utf8');
  return MANAGED_SKILL_MARKER_RE.test(text)
    && await managedSkillDirectoryContainsOnlyOwnedFiles(ownerRoot, dir);
}

async function confinedPathStillExists(
  ownerRoot: string,
  targetPath: string,
  errors: string[],
  displayPath: string
): Promise<boolean> {
  try {
    return (await inspectConfinedPath(ownerRoot, targetPath)).exists;
  } catch (error: unknown) {
    errors.push(`${displayPath}:${publicPathError(error, targetPath)}`);
    return true;
  }
}

async function removeEmptySkillParents(target: RemovedSkillCleanupTarget, errors: string[]): Promise<void> {
  for (const directory of [target.targetDir, path.dirname(target.targetDir)]) {
    try {
      await removeConfinedDirectoryIfEmpty(target.ownerRoot, directory);
    } catch (error: unknown) {
      errors.push(`${displayRemovedSkillPath(target, directory)}:${publicPathError(error, directory)}`);
    }
  }
}

async function reconcileRemovedSkillManifests(
  target: RemovedSkillCleanupTarget,
  rowByName: Map<string, Dirent>,
  fix: boolean,
  report: {
    rewrittenManifests: string[];
    quarantinedManifestCollisions: string[];
    remaining: string[];
    errors: string[];
  },
  opts: { managedOnly?: boolean } = {},
): Promise<void> {
  for (const fileName of [SKS_SKILL_MANIFEST_FILE, 'skills-manifest.json']) {
    if (!rowByName.has(fileName)) continue;
    const manifestPath = path.join(target.targetDir, fileName);
    const displayPath = displayRemovedSkillPath(target, manifestPath);
    let inspection;
    try {
      inspection = await inspectConfinedPath(target.ownerRoot, manifestPath);
    } catch (error: unknown) {
      report.errors.push(`${displayPath}:${publicPathError(error, manifestPath)}`);
      report.remaining.push(displayPath);
      continue;
    }
    if (!inspection.exists) continue;
    if (inspection.leafSymlink || !inspection.stat?.isFile()) {
      if (opts.managedOnly) continue;
      if (fix) {
        try {
          await quarantineSkillDir(target.ownerRoot, manifestPath, fileName, 'removed-skill-manifest-collision');
          report.quarantinedManifestCollisions.push(displayPath);
        } catch (error: unknown) {
          report.errors.push(`${displayPath}:${publicPathError(error, manifestPath)}`);
        }
      }
      if (await confinedPathStillExists(target.ownerRoot, manifestPath, report.errors, displayPath)) {
        report.remaining.push(displayPath);
      }
      continue;
    }

    let text: string;
    try {
      text = await fsp.readFile(manifestPath, 'utf8');
    } catch (error: unknown) {
      report.errors.push(`${displayPath}:${publicPathError(error, manifestPath)}`);
      report.remaining.push(displayPath);
      continue;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      if (!manifestTextContainsRetiredJsonValue(text)) continue;
      if (opts.managedOnly) continue;
      if (fix) {
        try {
          await quarantineSkillDir(target.ownerRoot, manifestPath, fileName, 'unparseable-removed-skill-manifest-collision');
          report.quarantinedManifestCollisions.push(displayPath);
        } catch (error: unknown) {
          report.errors.push(`${displayPath}:${publicPathError(error, manifestPath)}`);
        }
      }
      if (await confinedPathStillExists(target.ownerRoot, manifestPath, report.errors, displayPath)) {
        report.remaining.push(displayPath);
      }
      continue;
    }

    const scrubbed = scrubRemovedSkillManifest(fileName, parsed);
    if (!scrubbed.valid) {
      if (!scrubbed.hasRetiredResidue) continue;
      if (opts.managedOnly) continue;
      if (fix) {
        try {
          await quarantineSkillDir(target.ownerRoot, manifestPath, fileName, 'unmanaged-removed-skill-manifest-collision');
          report.quarantinedManifestCollisions.push(displayPath);
        } catch (error: unknown) {
          report.errors.push(`${displayPath}:${publicPathError(error, manifestPath)}`);
        }
      }
      if (await confinedPathStillExists(target.ownerRoot, manifestPath, report.errors, displayPath)) {
        report.remaining.push(displayPath);
      }
      continue;
    }
    if (!scrubbed.changed) continue;
    if (!fix) {
      report.remaining.push(displayPath);
      continue;
    }
    try {
      await writeJsonAtomic(manifestPath, scrubbed.next);
      const verified = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      if (manifestHasRetiredResidue(fileName, verified)) {
        throw new Error('removed_skill_manifest_verification_failed');
      }
      report.rewrittenManifests.push(displayPath);
    } catch (error: unknown) {
      report.errors.push(`${displayPath}:${publicPathError(error, manifestPath)}`);
      report.remaining.push(displayPath);
    }
  }
}

function scrubRemovedSkillManifest(fileName: string, parsed: any): {
  valid: boolean;
  changed: boolean;
  hasRetiredResidue: boolean;
  next: any;
} {
  const hasRetiredResidue = manifestHasRetiredResidue(fileName, parsed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, changed: false, hasRetiredResidue, next: parsed };
  }
  if (fileName === SKS_SKILL_MANIFEST_FILE) {
    if (!isSksOwnedReservedSkillManifest(fileName, parsed)) {
      return { valid: false, changed: false, hasRetiredResidue, next: parsed };
    }
    const next = {
      ...parsed,
      skills: parsed.skills.filter((name: unknown) => !isRemovedSkillName(name)),
      files: parsed.files.filter((file: unknown) => !generatedFileReferencesRemovedSkill(file))
    };
    return {
      valid: true,
      changed: JSON.stringify(next) !== JSON.stringify(parsed),
      hasRetiredResidue,
      next
    };
  }
  if (!isSksOwnedReservedSkillManifest(fileName, parsed)) {
    return { valid: false, changed: false, hasRetiredResidue, next: parsed };
  }
  const next = normalizeSkillsManifest(parsed);
  return {
    valid: true,
    changed: JSON.stringify(next) !== JSON.stringify(parsed),
    hasRetiredResidue,
    next
  };
}

function manifestHasRetiredResidue(fileName: string, parsed: any): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  if (fileName === SKS_SKILL_MANIFEST_FILE) {
    return (Array.isArray(parsed.skills) && parsed.skills.some(isRemovedSkillName))
      || (Array.isArray(parsed.files) && parsed.files.some(generatedFileReferencesRemovedSkill));
  }
  return Object.hasOwn(parsed, 'removed_skills')
    || (Array.isArray(parsed.skills) && parsed.skills.some((skill: any) => (
      isRemovedSkillName(skill?.canonical_name)
      || (Array.isArray(skill?.deprecated_aliases) && skill.deprecated_aliases.some(isRemovedSkillName))
    )));
}

function manifestTextContainsRetiredJsonValue(text: string): boolean {
  return SKS_SKILL_NAMES_TO_CLEAN_UP.some((name) => new RegExp(`"${escapeRegExp(name)}"`, 'i').test(text));
}

function isRemovedSkillName(value: unknown): boolean {
  return REMOVED_SKS_SKILL_NAME_SET.has(canonicalSkillNameFromValue(value));
}

function generatedFileReferencesRemovedSkill(value: unknown): boolean {
  const parts = String(value || '').replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.some((part, index) => canonicalSkillNameFromValue(part) === 'skills'
    && isRemovedSkillName(parts[index + 1]));
}

function nodeErrorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}

export interface ReconcileSkillsOptions {
  targetDir: string;
  scope: 'global' | 'project';
  fix: boolean;
  globalRuntimeRoot?: string;
}

export async function reconcileSkills(opts: ReconcileSkillsOptions): Promise<SkillReconcileReport> {
  const result = await reconcileSkillsAfterLockedPrecondition(opts, async () => true);
  if (!result.report) throw new Error('managed_skill_reconcile_precondition_unexpectedly_failed');
  return result.report;
}

export async function reconcileSkillsAfterLockedPrecondition(
  opts: ReconcileSkillsOptions,
  precondition: () => Promise<boolean>
): Promise<{ precondition_met: boolean; report: SkillReconcileReport | null }> {
  const targetDir = path.resolve(opts.targetDir);
  const root = rootFromSkillsDir(targetDir);
  return withManagedSkillGenerationLock(root, opts.scope, async () => {
    if (!await precondition()) {
      return { precondition_met: false, report: null };
    }
    return {
      precondition_met: true,
      report: await reconcileSkillsUnlocked({
        ...opts,
        targetDir
      })
    };
  });
}

async function reconcileSkillsUnlocked(opts: ReconcileSkillsOptions): Promise<SkillReconcileReport> {
  const targetDir = path.resolve(opts.targetDir);
  const root = rootFromSkillsDir(targetDir);
  const manifest = await loadSkillsManifest();
  const officialNames = new Set<string>(manifest.skills.map((skill: any) => canonicalSkillNameFromValue(skill.canonical_name)));
  const aliasNames = new Set<string>(manifest.skills.flatMap((skill: any) => (skill.deprecated_aliases || []).map((name: any) => canonicalSkillNameFromValue(name))));
  const removedNames = new Set<string>(SKS_SKILL_NAMES_TO_CLEAN_UP.map((name: any) => canonicalSkillNameFromValue(name)));
  const report: SkillReconcileReport = {
    schema: 'sks.skill-reconcile.v1',
    ok: true,
    scope: opts.scope,
    target_dir: targetDir,
    fix: opts.fix === true,
    installed: [],
    updated: [],
    removed: [],
    preserved_forge: [],
    preserved_user: [],
    quarantined_user_collisions: [],
    warnings: [],
    core_skill_integrity: { ok: true, installed_count: 0, restored_count: 0, user_collision_count: 0 }
  };
  let generatedManifest: any = null;
  if (opts.scope === 'global' && opts.fix) {
    generatedManifest = await generatePackagedSkillsManifest();
    const bundledManifest = await loadBundledSkillsManifest();
    const generatedFingerprint = skillManifestGenerationSha256(generatedManifest);
    const bundledFingerprint = skillManifestGenerationSha256(bundledManifest);
    if (bundledManifest && (
      !generatedFingerprint
      || !bundledFingerprint
      || generatedFingerprint !== bundledFingerprint
    )) {
      report.ok = false;
      report.warnings.push('packaged_authoritative_content_inconsistent');
      return report;
    }
    generatedManifest = mergePackagedSkillsManifestHashHistory(
      generatedManifest,
      bundledManifest
    );

    const installedMarker: any = await readJson(
      path.join(targetDir, SKS_SKILL_MANIFEST_FILE),
      null
    );
    if (installedMarker?.generated_by === 'sneakoscope') {
      const installedVersion = String(installedMarker?.version || '').trim();
      const versionOrder = compareSemVer(installedVersion, PACKAGE_VERSION);
      if (versionOrder === 1) {
        report.ok = false;
        report.warnings.push(
          `managed_skill_generation_downgrade_refused:${installedVersion}:runtime_${PACKAGE_VERSION}`
        );
        return report;
      }
      const installedBuildTime = Number(installedMarker?.runtime_build_source_time);
      const currentBuildTime = await runtimeBuildSourceTime();
      const installedGeneration = String(installedMarker?.skill_generation_sha256 || '');
      if (versionOrder === 0
        && generatedFingerprint
        && installedGeneration
        && installedGeneration !== generatedFingerprint
        && Number.isFinite(installedBuildTime)
        && installedBuildTime > 0
        && currentBuildTime !== null
        && installedBuildTime > currentBuildTime) {
        report.ok = false;
        report.warnings.push(
          `managed_skill_same_version_older_build_refused:${currentBuildTime}:installed_${installedBuildTime}`
        );
        return report;
      }
    }
  }
  const removedResidueTargets: RemovedSkillCleanupTarget[] = [
    {
      scope: opts.scope === 'global' ? 'global' : 'project',
      ownerRoot: root,
      targetDir
    },
    {
      scope: opts.scope === 'global' ? 'global-codex' : 'project-codex',
      ownerRoot: root,
      targetDir: path.join(root, '.codex', 'skills')
    }
  ];
  if (opts.scope === 'global' && opts.fix) {
    let quarantined: string[];
    try {
      quarantined = await quarantineUntrustedGlobalManagedSkills(
        root,
        targetDir,
        manifest
      );
    } catch (error: unknown) {
      report.ok = false;
      report.warnings.push(`skill_target_prepare_failed:${publicPathError(error, targetDir)}`);
      return report;
    }
    report.quarantined_user_collisions.push(...quarantined);
    report.warnings.push(...quarantined.map(
      (name) => `untrusted_managed_skill_quarantined:${name}`
    ));
  }
  if (opts.scope === 'global') {
    const globalRuntimeRoot = path.resolve(
      opts.globalRuntimeRoot
      || process.env.SKS_GLOBAL_ROOT
      || path.join(root, '.sneakoscope-global')
    );
    removedResidueTargets.push(
      {
        scope: 'global-runtime',
        ownerRoot: globalRuntimeRoot,
        targetDir: path.join(globalRuntimeRoot, '.agents', 'skills')
      },
      {
        scope: 'global-runtime-codex',
        ownerRoot: globalRuntimeRoot,
        targetDir: path.join(globalRuntimeRoot, '.codex', 'skills')
      },
      ...hostExtraRemovedSkillTargets(root),
    );
  }
  const removedResidue = await reconcileRemovedSkillTargets(removedResidueTargets, opts.fix);
  report.retired_residue = {
    detected_count: removedResidue.detected.length,
    removed_count: removedResidue.removed.length,
    quarantined_user_collision_count: removedResidue.quarantined_user_collisions.length,
    rewritten_manifest_count: removedResidue.rewritten_manifests?.length || 0,
    quarantined_manifest_collision_count: removedResidue.quarantined_manifest_collisions?.length || 0,
    remaining_count: removedResidue.remaining.length,
    error_count: removedResidue.errors.length
  };
  if (removedResidue.errors.length) report.warnings.push(`retired_skill_cleanup_failed:${removedResidue.errors.length}`);
  report.ok = removedResidue.errors.length === 0 && (!opts.fix || removedResidue.remaining.length === 0);
  if (!report.ok && opts.fix) return report;
  try {
    await ensureConfinedDirectory(root, targetDir);
  } catch (error: unknown) {
    report.ok = false;
    report.retired_residue.error_count += 1;
    report.retired_residue.remaining_count += 1;
    report.warnings.push(`skill_target_prepare_failed:${publicPathError(error, targetDir)}`);
    return report;
  }
  const existing = await listSkillDirs(targetDir, { includeUnsafeEntries: opts.scope === 'project' });

  if (opts.scope === 'project') {
    await reconcileProjectSkillEntries(root, targetDir, existing, officialNames, aliasNames, removedNames, report, opts.fix);
    const legacyCodexSkillsDir = path.join(root, '.codex', 'skills');
    if (path.resolve(legacyCodexSkillsDir) !== targetDir) {
      const legacyEntries = await listSkillDirs(legacyCodexSkillsDir, { includeUnsafeEntries: true });
      if (legacyEntries.length) await reconcileProjectSkillEntries(root, legacyCodexSkillsDir, legacyEntries, officialNames, aliasNames, removedNames, report, opts.fix);
      await removeDirIfEmpty(legacyCodexSkillsDir);
    }
    if (opts.fix) await pruneProjectGeneratedManifest(targetDir);
    report.installed_skills = [];
    report.generated_files = [];
    report.removed = currentSurfaceSkillPaths(report.removed);
    report.quarantined_user_collisions = currentSurfaceSkillPaths(report.quarantined_user_collisions);
    report.removed_stale_generated_skills = [...report.removed];
    report.removed_agent_skill_aliases = [];
    report.removed_codex_skill_mirrors = [];
    report.core_skill_integrity = { ok: true, installed_count: 0, restored_count: 0, user_collision_count: 0 };
    await removeDirIfEmpty(targetDir);
    await removeDirIfEmpty(path.dirname(targetDir));
    report.ok = report.ok && report.retired_residue.error_count === 0 && report.retired_residue.remaining_count === 0;
    return report;
  }

  const before = new Map(existing.map((entry) => [entry.canonical, entry.hash]));
  let install: any = null;
  if (opts.fix) {
    install = await installOfficialSkills(root);
    report.installed.push(...(install.installed_skills || []));
    report.removed.push(...currentSurfaceSkillPaths(install.removed_stale_generated_skills || []));
  } else {
    for (const skill of manifest.skills) {
      if (!before.has(canonicalSkillNameFromValue(skill.canonical_name))) report.installed.push(skill.canonical_name);
    }
  }
  const after = await listSkillDirs(targetDir);
  for (const entry of after) {
    const oldHash = before.get(entry.canonical);
    if (oldHash && oldHash !== entry.hash) report.updated.push(entry.name);
  }
  if (opts.fix) {
    await writePackagedSkillManifest(
      targetDir,
      generatedManifest || await generatePackagedSkillsManifest()
    );
  }
  report.installed_skills = install?.installed_skills || [...report.installed];
  report.generated_files = install?.generated_files || generatedSkillFiles(report.installed_skills);
  report.core_skill_integrity = install?.core_skill_integrity || { ok: true, installed_count: 0, restored_count: 0, user_collision_count: 0 };
  report.quarantined_user_collisions.push(...(install?.quarantined_user_collisions || []));
  report.quarantined_manifest_collisions = [...new Set<string>(install?.quarantined_manifest_collisions || [])].sort();
  report.removed_stale_generated_skills = currentSurfaceSkillPaths(install?.removed_stale_generated_skills || report.removed);
  report.removed_agent_skill_aliases = currentSurfaceSkillPaths(install?.removed_agent_skill_aliases || []);
  report.removed_codex_skill_mirrors = currentSurfaceSkillPaths(install?.removed_codex_skill_mirrors || []);
  report.removed = currentSurfaceSkillPaths(report.removed);
  report.quarantined_user_collisions = currentSurfaceSkillPaths(report.quarantined_user_collisions);
  report.ok = report.ok && report.core_skill_integrity.ok && report.retired_residue.error_count === 0 && report.retired_residue.remaining_count === 0;
  return report;
}

function currentSurfaceSkillPaths(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((value) => {
    const segments = String(value || '').split(/[\\/]/).map((segment) => canonicalSkillNameFromValue(segment));
    return !segments.some((segment) => REMOVED_SKS_SKILL_NAME_SET.has(segment));
  }))).sort();
}

function isSksManagedOfficialSkill(text: string) {
  return MANAGED_SKILL_MARKER_RE.test(String(text || ''));
}

async function reconcileProjectSkillEntries(
  root: string,
  targetDir: string,
  entries: any[],
  officialNames: Set<string>,
  aliasNames: Set<string>,
  removedNames: Set<string>,
  report: SkillReconcileReport,
  fix: boolean
) {
  for (const entry of entries) {
    const directoryCanonical = canonicalSkillNameFromValue(entry.directoryCanonical || entry.name);
    const declaredCanonical = canonicalSkillNameFromValue(entry.declaredCanonical || entry.canonical);
    const candidateNames = [...new Set([directoryCanonical, declaredCanonical].filter(Boolean))];
    const isOfficialName = (name: string) => (
      officialNames.has(name) || aliasNames.has(name) || removedNames.has(name)
    );
    const official = candidateNames.some(isOfficialName);
    const forge = FORGE_SKILL_MARKER_RE.test(entry.text);
    // Project-local skills can contain historical SKS wording as ordinary user prose.
    // Only an explicit ownership marker is strong enough evidence to delete the directory;
    // markerless official-name collisions are quarantined below so user content is preserved.
    const managed = MANAGED_SKILL_MARKER_RE.test(entry.text);
    if (forge) {
      report.preserved_forge.push(entry.name);
      continue;
    }
    if (official && !managed) {
      if (fix) await quarantineSkillDir(root, entry.dir, entry.name, 'project-official-name-user-collision');
      report.quarantined_user_collisions.push(entry.name);
      report.warnings.push(`official_name_user_collision_quarantined:${entry.name}`);
      continue;
    }
    if (managed) {
      if (await managedSkillDirectoryContainsOnlyOwnedFiles(root, entry.dir)) {
        if (fix) await removeManagedPathVerified(root, entry.dir);
        report.removed.push(path.relative(root, entry.dir).split(path.sep).join('/'));
      } else {
        if (fix) await quarantineSkillDir(root, entry.dir, entry.name, 'project-managed-skill-user-content-collision');
        report.quarantined_user_collisions.push(entry.name);
        report.warnings.push(`managed_skill_user_content_quarantined:${entry.name}`);
      }
      continue;
    }
    report.preserved_user.push(entry.name);
  }
  await removeDirIfEmpty(targetDir);
}

async function quarantineSkillDir(root: string, sourceDir: string, name: string, reason: string) {
  const stamp = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const boundary = path.resolve(root);
  const base = path.join(boundary, '.sneakoscope', 'quarantine', 'skills', canonicalSkillNameFromValue(name), stamp);
  const container = await uniqueConfinedPath(boundary, base);
  const target = path.join(container, path.basename(sourceDir));
  await ensureConfinedDirectory(boundary, container);
  const recordPath = path.join(container, 'quarantine-record.json');
  await writeJsonAtomic(recordPath, {
    schema: 'sks.skill-quarantine-record.v1',
    generated_at: nowIso(),
    source_path: sourceDir,
    quarantine_path: target,
    canonical_name: canonicalSkillNameFromValue(name),
    reason
  });
  try {
    await moveConfinedPath(boundary, sourceDir, target);
  } catch (error: unknown) {
    await removeManagedPathVerified(boundary, recordPath).catch(() => undefined);
    await removeConfinedDirectoryIfEmpty(boundary, container).catch(() => undefined);
    throw error;
  }
  return target;
}

async function quarantineUntrustedGlobalManagedSkills(
  root: string,
  targetDir: string,
  manifest: any
): Promise<string[]> {
  const trusted = new Map<string, Set<string>>();
  for (const row of Array.isArray(manifest?.skills) ? manifest.skills : []) {
    const canonicalName = canonicalSkillNameFromValue(row?.canonical_name);
    if (!canonicalName) continue;
    const digests = new Set<string>();
    for (const value of [row?.content_sha256, ...(Array.isArray(row?.hash_history) ? row.hash_history : [])]) {
      const digest = String(value || '').trim().toLowerCase();
      if (/^[a-f0-9]{64}$/.test(digest)) digests.add(digest);
    }
    trusted.set(canonicalName, digests);
  }
  const quarantined: string[] = [];
  for (const entry of await listSkillDirs(targetDir, { includeUnsafeEntries: true })) {
    if (!entry.text || !MANAGED_SKILL_MARKER_RE.test(entry.text)) continue;
    const canonicalName = canonicalSkillNameFromValue(entry.directoryCanonical || entry.name);
    // Current official names are the generation writer's replacement surface.
    // Retired or otherwise stale generated names remain owned by the existing
    // residue/manifest cleanup, which distinguishes removable generated bytes
    // from directories containing user-authored additions.
    if (!trusted.has(canonicalName)) continue;
    const contentTrusted = trusted.get(canonicalName)?.has(sha256(entry.text)) === true;
    const directoryOwned = contentTrusted
      && await managedSkillDirectoryContainsOnlyOwnedFiles(root, entry.dir);
    if (contentTrusted && directoryOwned) continue;
    await quarantineSkillDir(
      root,
      entry.dir,
      canonicalName || entry.name,
      contentTrusted
        ? 'global-managed-skill-user-content-collision'
        : 'global-managed-skill-untrusted-content'
    );
    quarantined.push(canonicalName || entry.name);
  }
  return [...new Set(quarantined)].sort();
}

export async function generatePackagedSkillsManifest(): Promise<any> {
  return withScratchDir('skills-manifest-', async (dir) => {
    await installOfficialSkills(dir);
    const skillRoot = path.join(dir, '.agents', 'skills');
    const entries = await listSkillDirs(skillRoot);
    const skills = entries
      .filter((entry) => entry.name !== 'quarantine')
      .map((entry) => ({
        canonical_name: entry.canonical,
        type: isCoreSkillName(entry.canonical) ? 'core' : 'official',
        content_sha256: entry.hash,
        hash_history: [],
        deprecated_aliases: SKILL_ALIASES[entry.canonical] || []
      }))
      .sort((a, b) => a.canonical_name.localeCompare(b.canonical_name));
    return {
      schema: PACKAGED_SKILLS_MANIFEST_SCHEMA,
      package_version: PACKAGE_VERSION,
      skills
    };
  });
}

export async function writePackagedSkillManifest(targetDir: string, manifest: any): Promise<string> {
  const file = path.join(targetDir, 'skills-manifest.json');
  await prepareReservedSkillManifestForWrite(rootFromSkillsDir(targetDir), file, 'skills-manifest.json');
  await writeJsonAtomic(file, manifest);
  return file;
}

function generatedSkillFiles(skillNames: any) {
  return skillNames.flatMap((name: any) => [
    `.agents/skills/${name}/SKILL.md`,
    `.agents/skills/${name}/agents/openai.yaml`
  ]).sort();
}

function markManagedSkill(name: any, content: any) {
  const text = String(content || '').trim();
  if (MANAGED_SKILL_MARKER_RE.test(text)) return `${text}\n`;
  return `${text}\n\n<!-- BEGIN SKS MANAGED SKILL v${MANAGED_SKILL_MARKER_VERSION} name=${name} -->\n`;
}

function generatedSkillManifestPath(root: any) {
  return path.join(root, '.agents', 'skills', SKS_SKILL_MANIFEST_FILE);
}

async function writeGeneratedSkillManifest(root: any, skillNames: any) {
  const manifestPath = generatedSkillManifestPath(root);
  await prepareReservedSkillManifestForWrite(root, manifestPath, SKS_SKILL_MANIFEST_FILE);
  const installedRows = await listSkillDirs(path.join(root, '.agents', 'skills'));
  const currentNames = new Set((skillNames || []).map((name: unknown) => canonicalSkillNameFromValue(name)));
  const skillGenerationSha256 = sha256(JSON.stringify(
    installedRows
      .filter((row) => currentNames.has(canonicalSkillNameFromValue(row.canonical)))
      .map((row) => ({
        canonical_name: canonicalSkillNameFromValue(row.canonical),
        content_sha256: row.hash
      }))
      .sort((left, right) => left.canonical_name.localeCompare(right.canonical_name))
  ));
  await writeJsonAtomic(manifestPath, {
    schema_version: 1,
    generated_by: 'sneakoscope',
    version: PACKAGE_VERSION,
    skill_generation_sha256: skillGenerationSha256,
    runtime_build_source_time: await runtimeBuildSourceTime(),
    prune_policy: GENERATED_PRUNE_POLICY,
    skills: [...skillNames].sort(),
    files: generatedSkillFiles(skillNames)
  });
}

async function removeStaleGeneratedSkillsFromManifest(
  root: string,
  skillNames: readonly string[]
): Promise<{ removed: string[]; quarantined: string[] }> {
  const previous = await readJson(generatedSkillManifestPath(root), null);
  const previousSkills = Array.isArray(previous?.skills) ? previous.skills : [];
  if (!previousSkills.length) return { removed: [], quarantined: [] };
  const current = new Set(skillNames);
  const removed: string[] = [];
  const quarantined: string[] = [];
  for (const name of previousSkills) {
    const skillName = String(name || '').trim();
    if (!skillName || current.has(skillName) || !/^[a-z0-9-]+$/.test(skillName)) continue;
    if (isCoreSkillName(skillName)) continue;
    const dir = path.join(root, '.agents', 'skills', skillName);
    if (!(await exists(dir))) continue;
    const text = await readText(path.join(dir, 'SKILL.md'), null);
    if (!isSksManagedOfficialSkill(String(text || ''))) continue;
    if (!(await managedSkillDirectoryContainsOnlyOwnedFiles(root, dir))) {
      await quarantineSkillDir(root, dir, skillName, 'stale-generated-skill-user-content-collision');
      quarantined.push(skillName);
      continue;
    }
    await removeManagedPathVerified(root, dir);
    removed.push(path.relative(root, dir));
  }
  return { removed: removed.sort(), quarantined: quarantined.sort() };
}

async function managedSkillDirectoryContainsOnlyOwnedFiles(root: string, dir: string): Promise<boolean> {
  const dirInspection = await inspectConfinedPath(root, dir);
  if (!dirInspection.exists || dirInspection.leafSymlink || !dirInspection.stat?.isDirectory()) return false;
  const rootEntries = await fsp.readdir(dir, { withFileTypes: true });
  if (rootEntries.some((entry) => !['SKILL.md', 'agents'].includes(entry.name))) return false;
  const skillEntry = rootEntries.find((entry) => entry.name === 'SKILL.md');
  const agentsEntry = rootEntries.find((entry) => entry.name === 'agents');
  if (!skillEntry?.isFile()) return false;
  if (!agentsEntry) return true;
  if (!agentsEntry.isDirectory()) return false;
  const agentsDir = path.join(dir, 'agents');
  const agentsInspection = await inspectConfinedPath(root, agentsDir);
  if (!agentsInspection.exists || agentsInspection.leafSymlink || !agentsInspection.stat?.isDirectory()) return false;
  const agentEntries = await fsp.readdir(agentsDir, { withFileTypes: true });
  if (agentEntries.length === 0) return true;
  if (agentEntries.length !== 1
    || agentEntries[0]?.name !== 'openai.yaml'
    || !agentEntries[0].isFile()) return false;
  const skillContent = await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8');
  const name = canonicalSkillNameFromValue(/^name:\s*(.+)\s*$/m.exec(skillContent)?.[1]);
  const description = skillFrontmatterDescription(skillContent);
  if (!name || !description) return false;
  const expectedMetadata = renderSkillAgentMetadata({
    skillName: name,
    shortDescription: description
  });
  const actualMetadata = await fsp.readFile(path.join(agentsDir, 'openai.yaml'), 'utf8');
  return actualMetadata === expectedMetadata;
}

async function prepareReservedSkillManifestsForWrite(root: string): Promise<string[]> {
  const skillRoot = path.join(root, '.agents', 'skills');
  const quarantined: string[] = [];
  for (const fileName of [SKS_SKILL_MANIFEST_FILE, 'skills-manifest.json']) {
    if (await prepareReservedSkillManifestForWrite(root, path.join(skillRoot, fileName), fileName)) {
      quarantined.push(fileName);
    }
  }
  return quarantined;
}

async function prepareReservedSkillManifestForWrite(
  root: string,
  manifestPath: string,
  fileName: string
): Promise<boolean> {
  const inspection = await inspectConfinedPath(root, manifestPath);
  if (!inspection.exists) return false;
  if (!inspection.leafSymlink && inspection.stat?.isFile()) {
    try {
      const parsed = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      if (isSksOwnedReservedSkillManifest(fileName, parsed)) return false;
    } catch {
      // Invalid JSON at a reserved path is user-owned until proven otherwise.
    }
  }
  await quarantineSkillDir(root, manifestPath, fileName, 'reserved-skill-manifest-user-collision');
  return true;
}

function isSksOwnedReservedSkillManifest(fileName: string, parsed: any): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (fileName === SKS_SKILL_MANIFEST_FILE) {
    return parsed.schema_version === 1
      && parsed.generated_by === 'sneakoscope'
      && parsed.prune_policy === GENERATED_PRUNE_POLICY
      && Array.isArray(parsed.skills)
      && Array.isArray(parsed.files);
  }
  return fileName === 'skills-manifest.json'
    && parsed.schema === PACKAGED_SKILLS_MANIFEST_SCHEMA
    && typeof parsed.package_version === 'string'
    && Array.isArray(parsed.skills)
    && parsed.skills.every((skill: any) => (
      skill
      && typeof skill === 'object'
      && !Array.isArray(skill)
      && typeof skill.canonical_name === 'string'
      && ['core', 'official'].includes(skill.type)
      && typeof skill.content_sha256 === 'string'
      && Array.isArray(skill.hash_history)
      && Array.isArray(skill.deprecated_aliases)
    ));
}

type GeneratedSkillResidueCleanup = { removed: string[]; quarantined: string[] };

async function removeGeneratedPluginSkillCollisions(root: string): Promise<GeneratedSkillResidueCleanup> {
  const removed: string[] = [];
  const quarantined: string[] = [];
  for (const name of RESERVED_CODEX_PLUGIN_SKILL_NAMES) {
    const dir = path.join(root, '.agents', 'skills', name);
    const action = await cleanupGeneratedSkillResidue(
      root,
      dir,
      name,
      (text) => isGeneratedSksPluginCollisionSkill(text, name),
      'generated-plugin-skill-user-content-collision'
    );
    if (action === 'removed') removed.push(path.relative(root, dir));
    if (action === 'quarantined') quarantined.push(name);
  }
  return { removed: removed.sort(), quarantined: quarantined.sort() };
}

function isGeneratedSksPluginCollisionSkill(text: any, name: any) {
  if (typeof text !== 'string') return false;
  const s = String(text);
  if (!new RegExp(`^name:\\s*${escapeRegExp(name)}\\s*$`, 'm').test(s)) return false;
  if (/\bnot generated by SKS\b/i.test(s)) return false;
  return /Maximum-speed \$Computer-Use\/\$CU lane|Codex App pipeline activation:|Sneakoscope generated|Dollar-command route generated by SKS/i.test(s);
}

function enrichSkillContent(name: any, content: any) {
  if (!['sks', 'answer', 'wiki', 'qa-loop', 'ppt', 'image-ux-review', 'computer-use-fast', 'cu', 'goal', 'research', 'autoresearch', 'db', 'gx', 'reflection', 'prompt-pipeline', 'pipeline-runner', 'context7-docs', 'turbo-context-pack', 'hproof-evidence-bind'].includes(name)) return content;
  const text = String(content || '').trimEnd();
  const activation = pipelineActivationText(name);
  if (text.includes('TriWiki context-tracking SSOT')) {
    return activation && !text.includes('Codex App pipeline activation:') ? `${text}\n\n${activation}` : text;
  }
  return `${text}${activation ? `\n\n${activation}` : ''}

Context: follow AGENTS.md; use bounded .sneakoscope/wiki/context-pack.json coordinate+voxel recall, hydrate stale or uncertain claims from current source, refresh after material changes, and validate before handoff/final. Consult current vendor docs when an external contract matters. User instructions take precedence over skill guidance; infer routine details and continue authorized work.
`;
}

function pipelineActivationText(name: any) {
  // The coordinator is loaded once. Repeating activation in every selected
  // skill bloats context and lets support skills accidentally restart a route.
  if (name !== 'pipeline-runner') return '';
  return `Codex App pipeline activation:
- Follow the current hook route context when present.
- Otherwise invoke \`sks hook user-prompt-submit\` once with JSON containing the literal prompt and cwd; use its returned route context.
- Keep existing mission state current through \`sks pipeline status\` and \`sks pipeline plan\` when that route creates artifacts. Do not claim an artifact exists without checking it.`;
}

async function writeSkillMetadata(root: string, dir: string, name: string, skillContent: string) {
  const description = skillFrontmatterDescription(skillContent);
  if (!description) throw new Error(`generated_skill_frontmatter_description_missing:${name}`);
  await ensureConfinedDirectory(root, path.join(dir, 'agents'));
  await writeTextAtomic(
    path.join(dir, 'agents', 'openai.yaml'),
    renderSkillAgentMetadata({ skillName: name, shortDescription: description })
  );
}

async function removeGeneratedCodexSkillMirrors(root: string, skillNames: readonly string[]): Promise<GeneratedSkillResidueCleanup> {
  const legacyRoot = path.join(root, '.codex', 'skills');
  if (!(await exists(legacyRoot))) return { removed: [], quarantined: [] };
  const removed: string[] = [];
  const quarantined: string[] = [];
  const names = Array.from(new Set([
    ...skillNames,
    ...DOLLAR_COMMANDS.map((c: any) => c.command.slice(1)),
    ...SKS_SKILL_NAMES_TO_CLEAN_UP,
    'ralph',
    'Ralph',
    'ralph-supervisor',
    'ralph-resolver'
  ]));
  for (const name of names) {
    const dir = path.join(legacyRoot, name);
    const action = await cleanupGeneratedSkillResidue(
      root,
      dir,
      String(name),
      (text) => isGeneratedSksLegacySkill(text, name),
      'generated-codex-skill-user-content-collision'
    );
    if (action === 'removed') removed.push(path.relative(root, dir));
    if (action === 'quarantined') quarantined.push(String(name));
  }
  await removeDirIfEmpty(legacyRoot);
  await removeDirIfEmpty(path.join(root, '.agents'));
  return { removed: removed.sort(), quarantined: quarantined.sort() };
}

async function removeGeneratedAgentSkillAliases(root: string, skillNames: readonly string[]): Promise<GeneratedSkillResidueCleanup> {
  const current = new Set(skillNames);
  const obsolete = [
    ...SKS_SKILL_NAMES_TO_CLEAN_UP,
    ...RETIRED_PUBLIC_IMAGE_UX_REVIEW_SKILL_ALIASES,
    'qaloop',
    'wiki-refresh',
    'wikirefresh',
    'ralph',
    'ralph-supervisor',
    'ralph-resolver'
  ];
  const removed: string[] = [];
  const quarantined: string[] = [];
  for (const name of obsolete) {
    if (current.has(name)) continue;
    const dir = path.join(root, '.agents', 'skills', name);
    const action = await cleanupGeneratedSkillResidue(
      root,
      dir,
      name,
      (text) => isGeneratedSksAgentSkill(text, name) || isRetiredGeneratedImageUxReviewAlias(text, name),
      'generated-agent-skill-user-content-collision'
    );
    if (action === 'removed') removed.push(path.relative(root, dir));
    if (action === 'quarantined') quarantined.push(name);
  }
  return { removed: removed.sort(), quarantined: quarantined.sort() };
}

async function cleanupGeneratedSkillResidue(
  root: string,
  dir: string,
  name: string,
  isOwnedText: (text: string) => boolean,
  quarantineReason: string
): Promise<'removed' | 'quarantined' | 'preserved'> {
  const dirInspection = await inspectConfinedPath(root, dir);
  if (!dirInspection.exists || dirInspection.leafSymlink || !dirInspection.stat?.isDirectory()) return 'preserved';
  const skillPath = path.join(dir, 'SKILL.md');
  const skillInspection = await inspectConfinedPath(root, skillPath);
  if (!skillInspection.exists || skillInspection.leafSymlink || !skillInspection.stat?.isFile()) return 'preserved';
  const text = await fsp.readFile(skillPath, 'utf8');
  if (!isOwnedText(text)) return 'preserved';
  if (!MANAGED_SKILL_MARKER_RE.test(text)) {
    await quarantineSkillDir(root, dir, name, quarantineReason);
    return 'quarantined';
  }
  if (!(await managedSkillDirectoryContainsOnlyOwnedFiles(root, dir))) {
    await quarantineSkillDir(root, dir, name, quarantineReason);
    return 'quarantined';
  }
  await removeManagedPathVerified(root, dir);
  return 'removed';
}

function isGeneratedSksAgentSkill(text: any, name: any) {
  if (!text) return false;
  const s = String(text);
  if (!new RegExp(`name:\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(s)) return false;
  if (/\bnot generated by SKS\b/i.test(s)) return false;
  return /Sneakoscope generated|Fallback Codex App picker alias|Codex App picker alias for|Dollar-command route generated by SKS/i.test(s);
}

function isRetiredGeneratedImageUxReviewAlias(text: any, name: any) {
  if (!RETIRED_PUBLIC_IMAGE_UX_REVIEW_SKILL_ALIAS_SET.has(String(name))) return false;
  const s = String(text || '');
  return MANAGED_SKILL_MARKER_RE.test(s)
    && new RegExp(`^name:\\s*${escapeRegExp(name)}\\s*$`, 'm').test(s)
    && /imagegen\/gpt-image-2 annotated UI\/UX review loop/i.test(s);
}

function isGeneratedSksLegacySkill(text: any, name: any) {
  if (typeof text !== 'string') return false;
  if (!text.startsWith('---') || !new RegExp(`^name:\\s*${escapeRegExp(name)}\\s*$`, 'm').test(text)) return false;
  if (/\bnot generated by SKS\b/i.test(text)) return false;
  return MANAGED_SKILL_MARKER_RE.test(text)
    || /Sneakoscope generated|Fallback Codex App picker alias|Codex App picker alias for|Dollar-command route generated by SKS|Deprecated \$?(?:Team|MAD-DB|Swarm|ShadowClone|Kagebunshin) compatibility alias|Codex App pipeline activation:/i.test(text);
}

async function removeDirIfEmpty(dir: any) {
  try {
    const entries = await fsp.readdir(dir);
    if (!entries.length) await fsp.rmdir(dir);
  } catch {}
}

export async function installCodexAgents(root: any) {
  const retiredRoleCleanup = await reconcileRetiredAgentRoleResidue({ root, fix: true });
  const installed = await installOfficialSubagentAgentConfigs(root, { apply: true });
  return { ...installed, retired_role_cleanup: retiredRoleCleanup };
}

export function currentGeneratedFileInventory(skillInstall: any = {}, agentInstall: any = {}, opts: any = {}) {
  return Array.from(new Set([
    ...(opts.includeCodexConfig === false ? [] : ['.codex/config.toml']),
    '.codex/SNEAKOSCOPE.md',
    '.codex/hooks.json',
    '.sneakoscope/harness-guard.json',
    '.sneakoscope/db-safety.json',
    '.sneakoscope/policy.json',
    ...(opts.includeSkillFiles === false ? [] : [
      '.agents/skills/.sks-generated.json',
      ...(Array.isArray(skillInstall.generated_files) ? skillInstall.generated_files : [])
    ]),
    ...(Array.isArray(agentInstall.generated_files) ? agentInstall.generated_files : [])
  ])).sort();
}

export async function pruneStaleGeneratedFiles(root: any, previousManifest: any, currentFiles: any) {
  const previousFiles = Array.isArray(previousManifest?.generated_files?.files) ? previousManifest.generated_files.files : [];
  if (!previousFiles.length) return { pruned: [] };
  const current = new Set(currentFiles);
  const pruned: any[] = [];
  const already_absent: any[] = [];
  for (const rel of previousFiles) {
    const relPath = normalizeGeneratedRelPath(rel);
    if (!relPath || current.has(relPath) || !isPrunableGeneratedPath(relPath)) continue;
    const removed = await removeGeneratedRelPath(root, relPath);
    if (removed) pruned.push(removed);
    else already_absent.push(relPath);
  }
  return { pruned: pruned.sort(), already_absent: already_absent.sort() };
}

function normalizeGeneratedRelPath(value: any) {
  const rel = String(value || '').trim().replaceAll('\\', '/');
  if (!rel || rel.startsWith('/') || rel.includes('\0')) return null;
  if (rel.split('/').some((part: any) => part === '..')) return null;
  return rel;
}

function isPrunableGeneratedPath(rel: any) {
  // Skill migration is ownership-aware and handled by reconcileSkills(). A
  // prior generated-files manifest is not authority to delete content that a
  // user may have since replaced or adopted.
  if (rel.startsWith('.agents/skills/')) return false;
  if (rel.startsWith('.codex/agents/')) return false;
  if (rel.startsWith('.codex/skills/')) return false;
  return new Set([
    '.codex/SNEAKOSCOPE.md',
    '.codex/hooks.json',
    '.sneakoscope/harness-guard.json',
    '.sneakoscope/db-safety.json',
    '.sneakoscope/policy.json'
  ]).has(rel);
}

async function removeGeneratedRelPath(root: any, rel: any) {
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, rel);
  if (abs !== absRoot && !abs.startsWith(`${absRoot}${path.sep}`)) return null;
  if (!(await exists(abs))) return null;
  await fsp.rm(abs, { recursive: true, force: true });
  await removeEmptyGeneratedParents(root, rel);
  return rel;
}

async function removeEmptyGeneratedParents(root: any, rel: any) {
  const parts = rel.split('/');
  if (parts.length <= 1) return;
  const stopDirs = new Set([
    path.resolve(root, '.agents', 'skills'),
    path.resolve(root, '.codex', 'agents'),
    path.resolve(root, '.codex', 'skills'),
    path.resolve(root, '.codex'),
    path.resolve(root, '.sneakoscope')
  ]);
  let dir = path.resolve(root, ...parts.slice(0, -1));
  while (!stopDirs.has(dir) && dir.startsWith(path.resolve(root))) {
    await removeDirIfEmpty(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (rel.startsWith('.codex/skills/')) await removeDirIfEmpty(path.join(root, '.codex', 'skills'));
}
