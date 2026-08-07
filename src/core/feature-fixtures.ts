import { PACKAGE_VERSION } from './fsx.js';

export { runFeatureFixture } from './feature-fixture-executor.js';

export const FEATURE_FIXTURE_SCHEMA = 'sks.feature-fixtures.v1';
export const FEATURE_QUALITY_LEVELS = Object.freeze([
  'runtime_verified',
  'wiring_only',
  'integration_optional',
  'static_contract',
  'missing'
]);

const FIXTURES = Object.freeze({
  'cli-help': fixture('execute', 'sks help', [], 'pass'),
  'cli-version': fixture('execute', 'sks --version', [], 'pass'),
  'cli-root': fixture('execute', 'sks root --json', [], 'pass'),
  'cli-doctor': fixture('execute', 'sks doctor --json', [], 'pass', {
    reason: 'doctor without --fix is a read-only runtime readiness command, so the release fixture can execute it directly instead of counting it as optional integration evidence.'
  }),
  'doctor:imagegen-repair': fixture('execute_and_validate_artifacts', 'sks doctor --json', [{ path: '.sneakoscope/reports/feature-fixtures/doctor-imagegen-repair.json', schema: 'sks.doctor-imagegen-repair.v1', optional: true }], 'pass', {
    quality: 'runtime_verified',
    validates_json_fields: ['imagegen_repair', 'repair.imagegen']
  }),
  'cli-paths': fixture('execute_and_validate_artifacts', 'sks paths managed --json', ['.sneakoscope/managed-paths.json'], 'pass'),
  'cli-rollback': fixture('execute', 'sks rollback list --json', [], 'pass'),
  'cli-config': fixture('execute', 'sks config --help', [], 'pass', {
    quality: 'wiring_only',
    reason: 'The non-mutating help path proves the installed config command is wired; config-adopt mutation and dry-run behavior are covered by focused config-adopt tests.'
  }),
  'cli-setup': fixture('real_optional', 'sks setup --json --local-only', [], 'pass'),
  'cli-codex': fixture('execute', 'sks codex compatibility --json', [], 'pass'),
  'cli-codex-app': fixture('real_optional', 'sks codex-app check --json', [], 'pass'),
  'cli-bridge': fixture('execute', 'sks bridge status --json', [], 'pass', {
    expected_stdout_fields: {
      schema: 'sks.desktop-bridge-status.v3',
      execution_ok: true,
      'routing.fallback': 'none'
    },
    reason: 'The read-only status command proves the installed Desktop Bridge JSON facade and fail-closed no-fallback routing contract without configuring a provider, starting a service, or reading a plaintext credential.'
  }),
  'cli-mcp': fixture('execute', 'sks mcp config list --scope project --trusted-project --json', [], 'pass', {
    reason: 'Project-scoped MCP inventory is a read-only, hermetic runtime probe when the trusted-project boundary is explicit; mutation, health, auth, and merge behavior remain covered by dedicated tests.'
  }),
  'cli-remote': fixture('real_optional', 'sks remote readiness --json', [], 'pass', {
    reason: 'Remote readiness is environment-dependent on the official Codex host and local project capabilities; SSH worker behavior is covered by dedicated hermetic protocol and policy tests.'
  }),
  'cli-hooks': fixture('execute', 'sks hooks trust-report --json', [], 'pass'),
  'cli-features': fixture('execute', 'sks features check --json', [], 'pass'),
  'cli-commands': fixture('execute', 'sks commands --json', [], 'pass'),
  'cli-check': fixture('execute', 'sks check --tier confidence --sla 5m --plan --json', [], 'pass'),
  'cli-plan': fixture('execute', 'sks plan "fixture" --json', [], 'pass'),
  'cli-review': fixture('execute', 'sks review --diff HEAD --json', [], 'pass'),
  'cli-run': fixture('execute_and_validate_artifacts', 'sks run "fixture" --mock --json', ['run-classification.json', 'completion-proof.json', 'evidence-index.json', 'route-completion-contract.json', 'trust-report.json', 'work-order-ledger.json'], 'blocked', { reason: 'finalizeMockRun() in run-command.ts intentionally hardcodes gate.passed=false for every --mock invocation so a mock run can never claim a real completion; it does write all declared artifacts, including a work-order-ledger honestly closed to blocked (18차).' }),
  'cli-status': fixture('execute', 'sks status --json', [], 'pass'),
  'cli-usage': fixture('execute', 'sks usage overview', [], 'pass'),
  'cli-quickstart': fixture('execute', 'sks quickstart', [], 'pass'),
  'cli-install': fixture('static', 'npm exec --yes --package=sneakoscope@latest -- sneakoscope install --yes', [], 'pass', {
    quality: 'wiring_only',
    reason: 'The installer performs a real npm-global mutation and Doctor repair, so the feature registry records its explicit public surface without executing it. Cached-installer rejection, exact-package identity, PATH shadow detection, and rollback guidance are covered by focused hermetic tests.'
  }),
  'cli-update': fixture('execute', 'sks update now --dry-run --json', [], 'pass'),
  'cli-update-check': fixture('static', 'sks update-check --json', [], 'pass'),
  'cli-guard': fixture('execute', 'sks guard check --json', [], 'pass'),
  'cli-conflicts': fixture('execute', 'sks conflicts check --json', [], 'pass'),
  'cli-versioning': fixture('execute', 'sks versioning status --json', [], 'pass'),
  'cli-aliases': fixture('execute', 'sks aliases', [], 'pass'),
  'cli-fix-path': fixture('execute', 'sks fix-path --json', [], 'pass'),
  // selftest --real executes this fixture directly against this real repo (no
  // hermetic isolation for execute/execute_and_validate_artifacts fixtures - see
  // feature-fixture-executor.ts), so a real full scan (~79 modules) needs a
  // realistic budget; the 8000 default is sized for smaller/typical repos, not
  // this one, so pass an explicit larger budget rather than lowering the gate.
  'cli-wiki-code': fixture('execute_and_validate_artifacts', 'sks align run --token-budget 20000 --json', [{ path: '.sneakoscope/wiki/code-pack.json', schema: 'sks.code-pack.v1', optional: true }], 'pass'),
  'cli-agent-bridge': fixture('execute_and_validate_artifacts', 'sks agent-bridge setup --json', [{ path: '.sneakoscope/agent-bridge/manifest.json', schema: 'sks.agent-manifest.v2', optional: true }], 'pass'),
  'cli-mcp-server': fixture('execute', 'sks mcp-server --probe', [], 'pass'),
  'cli-selftest': fixture('execute', 'sks selftest --mock', [], 'pass'),
  'cli-git': fixture('execute', 'sks git policy --json', [], 'pass'),
  'cli-uninstall': fixture('execute', 'sks uninstall --dry-run --json', [], 'pass'),
  'cli-goal': fixture('execute', 'sks goal create "Fixture smoke: create a minimal Node.js CLI health-check script" --json', [], 'pass', { reason: 'The compatibility command is stateless: it prints a detailed Codex native /goal request and writes no SKS mission, artifact, loop, or fallback state.' }),
  'cli-align': fixture('execute_and_validate_artifacts', 'sks align prepare "fixture modernization contract" --json', ['work-order-ledger.json', 'align-plan.json', 'align-ledger.json', 'align-gate.json'], 'pass', {
    reason: 'The CLI fixture exercises the real hermetic preparation path, including literal-request work-order registration. It intentionally leaves align-gate.json blocked because no external modernization work is fabricated.'
  }),
  'cli-seo-geo-optimizer': fixture('execute_and_validate_artifacts', 'sks seo-geo-optimizer fixture --mode seo --json', ['search-visibility/site-inventory.json', 'search-visibility/seo-findings.json', 'search-visibility/verification-report.json', 'seo-gate.json', 'completion-proof.json'], 'pass'),
  'cli-research': fixture('execute_and_validate_artifacts', 'sks research run latest --mock --json', ['research-gate.json', 'completion-proof.json'], 'blocked', { timeout_ms: 180000, reason: '"run" (not "status") is the command that actually writes research-gate.json/completion-proof.json, but research is a two-step prepare-then-run workflow gated by an active-route-not-closed check between steps that a single fixture command cannot express; on a hermetic run "latest" will not be a properly prepared+closed research mission.' }),
  'cli-qa-loop': fixture('execute_and_validate_artifacts', 'sks qa-loop run latest --mock --json', ['qa-gate.json', 'completion-proof.json'], 'pass', { timeout_ms: 180000 }),
  'cli-ppt': fixture('mock', 'sks ppt fixture --mock --json', ['ppt-imagegen-review-gate.json', 'completion-proof.json'], 'pass', { reason: 'mockPptFixtureGate() in ppt-command.ts hardcodes an honest blocked gate and the handler unconditionally sets process.exitCode=1 by design so a mock PPT build can never claim a real pass; it does write the declared artifacts.' }),
  'cli-image-ux-review': fixture('execute_and_validate_artifacts', 'sks image-ux-review fixture --mock --json', ['completion-proof.json', 'image-voxel-ledger.json', 'image-ux-generated-review-ledger.json'], 'blocked', { reason: 'Same as route-image-ux-review: the image-ux-review fixture command intentionally always exits 1 by design (honest mock, cannot claim a real completion), even though it does write all declared artifacts.' }),
  'cli-computer-use': fixture('real_optional', 'sks computer-use status --json', [], 'pass'),
  'cli-pipeline': fixture('execute_and_validate_artifacts', 'sks pipeline plan latest --agents 1 --json', ['pipeline-plan.json'], 'pass'),
  'cli-validate-artifacts': fixture('execute_and_validate_artifacts', 'sks validate-artifacts latest --json', ['artifact-validation.json'], 'pass'),
  'cli-hproof': fixture('execute_and_validate_artifacts', 'sks hproof check latest', ['done-gate.evaluated.json'], 'pass'),
  'cli-proof-field': fixture('execute', 'sks proof-field scan --json --intent fixture', [], 'pass'),
  'cli-recallpulse': fixture('execute_and_validate_artifacts', 'sks recallpulse run latest --json', ['mission-status-ledger.json'], 'pass'),
  'cli-gx': fixture('execute_and_validate_artifacts', 'sks gx validate fixture --mock', ['gx-validation.json'], 'blocked', { reason: 'gxValidateFixture() intentionally exits non-zero (execution_class: mock_fixture) for an honest mock/blocked result; without --mock the command crashes on a missing cartridge instead.' }),
  'cli-perf': fixture('execute', 'sks perf cold-start --json --iterations 1', [], 'pass'),
  'cli-bench': fixture('execute_and_validate_artifacts', 'sks bench core --tier npx-one-shot --json --iterations 1', ['.sneakoscope/reports/performance/core-bench.json'], 'pass'),
  'cli-code-structure': fixture('execute', 'sks code-structure scan --json', [], 'pass', { timeout_ms: 180000 }),
  'cli-rust': fixture('execute', 'sks rust smoke --json', [], 'pass'),
  'cli-skill-dream': fixture('execute', 'sks skill-dream status --json', [], 'pass'),
  'cli-gc': fixture('execute', 'sks gc --dry-run --json', [], 'pass'),
  'cli-cleanup': fixture('execute', 'sks cleanup plan --json', [], 'pass', {
    reason: 'Destructive blank-state apply stays behind explicit `sks cleanup run --apply`; the contract fixture only exercises the read-only plan surface.'
  }),
  'cli-memory': fixture('execute', 'sks memory --dry-run --json', [], 'pass', { timeout_ms: 300000 }),
  'cli-stats': fixture('execute', 'sks stats --json', [], 'pass'),
  'cli-dollar-commands': fixture('execute', 'sks dollar-commands --json', [], 'pass'),
  'cli-fast-mode': fixture('execute', 'sks fast-mode status --json', [], 'pass'),
  'cli-with-local-llm': fixture('execute', 'sks with-local-llm status --json', [], 'pass'),
  'cli-dfix': fixture('execute_and_validate_artifacts', 'sks dfix fixture --json', ['completion-proof.json', 'dfix-gate.json', 'dfix-verification.json'], 'pass'),
  'cli-wiki': fixture('execute_and_validate_artifacts', 'sks wiki image-ingest test/fixtures/images/one-by-one.png --json', [{ path: '.sneakoscope/wiki/image-voxel-ledger.json', schema: 'sks.image-voxel-ledger.v1', require_anchors: false }], 'pass'),
  'cli-wizard': fixture('execute', 'sks wizard', [], 'pass'),
  'cli-bootstrap': fixture('execute', 'sks bootstrap --dry-run', [], 'pass'),
  'cli-deps': fixture('execute', 'sks deps check --json', [], 'pass'),
  'cli-auth': fixture('execute', 'sks auth status --json', [], 'pass'),
  'cli-codex-native': fixture('execute', 'sks codex-native status --json', [], 'pass'),
  'cli-mad': fixture('execute', 'sks mad --help', [], 'pass'),
  'cli-mad-sks': fixture('static', 'sks mad-sks status --json', [], 'pass'),
  'cli-auto-review': fixture('execute', 'sks auto-review status --json', [], 'pass'),
  'cli-commit': fixture('mock', 'sks commit --dry-run', [], 'pass', {
    reason: 'simpleGitCommitCommand() in git-simple.ts performs a real `git add -A && git commit` against whatever repo cwd it runs in; it has no --dry-run implementation (argValue() only reads --message/-m/--json, so --dry-run is silently ignored) and would mutate git history if actually spawned by an automated fixture runner. Left as documented mock rather than execute a real commit or invent an unsupported --dry-run mode.'
  }),
  'cli-commit-and-push': fixture('mock', 'sks commit-and-push --dry-run', [], 'pass', {
    reason: 'Same underlying simpleGitCommitCommand() as cli-commit plus a real `git push`; genuinely destructive (commits and pushes to the remote) with no real --dry-run support. Left as documented mock rather than execute a real commit+push or invent an unsupported --dry-run mode.'
  }),
  'cli-context7': fixture('real_optional', 'sks context7 check --json', [], 'pass'),
  'cli-super-search': fixture('execute', 'sks super-search doctor --json', [], 'pass'),
  'cli-search': fixture('execute', 'sks search status --json', [], 'pass'),
  'cli-task': fixture('execute', 'sks task instant --plan --json', [], 'pass'),
  'cli-release': fixture('execute', 'sks release affected --json', [], 'blocked', { reason: '18차: the phantom requiredSections schema mismatch (five_lane_review/integration_evidence/session_cleanup, from commit d4526f84 with no producer ever wired up) has been fixed -- missing_sections is now honestly empty. The release-gate DAG still legitimately fails/blocks on other real gates (e.g. release:readiness) independent of this fix, so the command still exits non-zero and this fixture stays honestly blocked rather than claiming full green.' }),
  'cli-triwiki': fixture('execute', 'sks triwiki index --json', [], 'pass'),
  'cli-daemon': fixture('execute', 'sks daemon status --json', [], 'pass'),
  'cli-all-features': fixture('execute_and_validate_artifacts', 'sks all-features complete --json', [`.sneakoscope/reports/all-feature-completion-${PACKAGE_VERSION}.json`], 'pass'),
  'cli-init': fixture('execute', 'sks init --local-only --dry-run', [], 'pass'),
  'cli-eval': fixture('execute', 'sks eval run --mock --json', [], 'pass'),
  'cli-harness': fixture('execute', 'sks harness fixture --mock --json', [], 'pass'),
  'cli-naruto': fixture('execute_and_validate_artifacts', 'sks naruto run "fixture" --agents 4 --max-threads 4 --json', ['subagent-plan.json', 'subagent-events.jsonl', 'subagent-evidence.json', 'naruto-summary.json', 'naruto-gate.json', 'work-order-ledger.json'], 'pass', preparationFixtureContract()),
  'cli-reasoning': fixture('execute', 'sks reasoning status --json', [], 'pass'),
  'cli-profile': fixture('execute', 'sks profile status --json', [], 'pass'),
  'skill-db-safety-guard': fixture('execute', 'node --test test/unit/db-safety.test.mjs', [], 'pass', { root_mode: 'source_checkout_required' }),
  'skill-honest-mode': fixture('execute_and_validate_artifacts', 'sks proof smoke --json', ['completion-proof.json', 'trust-report.json'], 'pass'),
  'skill-imagegen': fixture('execute_and_validate_artifacts', 'sks image-ux-review fixture --mock --json', ['image-ux-generated-review-ledger.json', 'image-voxel-ledger.json'], 'pass'),
  'ux-review:run-wires-imagegen': fixture('execute_and_validate_artifacts', 'npm run ux-review:run-wires-imagegen --silent', [{ path: 'image-ux-review-gate.json', schema: 'sks.image-ux-review-gate.v2', optional: true }], 'pass', {
    validates_source_contracts: ['requireCodexImagegen', 'generateGptImage2CalloutReview', 'evidence_class', 'output_sha256']
  }),
  'ppt:real-imagegen-wiring': fixture('execute_and_validate_artifacts', 'npm run ppt:real-imagegen-wiring --silent', [{ path: 'ppt-imagegen-review-gate.json', schema: 'sks.ppt-imagegen-review-gate.v1', optional: true }], 'pass', {
    validates_source_contracts: ['generateGptImage2CalloutReview', 'buildSlideImagegenEvidence', 'imagegen_evidence']
  }),
  'skill-gx-visual-validate': fixture('execute_and_validate_artifacts', 'sks gx validate fixture --mock --json', ['gx-validation.json'], 'pass'),
  'skill-context7-docs': fixture('real_optional', 'sks context7 check --json', [], 'pass'),
  'skill-seo-geo-optimizer': fixture('execute_and_validate_artifacts', 'sks seo-geo-optimizer fixture --mode geo --json', ['search-visibility/site-inventory.json', 'search-visibility/geo-findings.json', 'geo-gate.json', 'completion-proof.json'], 'pass'),
  'cli-proof': fixture('execute_and_validate_artifacts', 'sks proof smoke --json', ['.sneakoscope/proof/latest.json'], 'pass'),
  'cli-trust': fixture('execute_and_validate_artifacts', 'sks trust report latest --json', ['trust-report.json'], 'pass'),
  'cli-wrongness': fixture('execute', 'sks wrongness validate project --json', [], 'pass', {
    reason: 'Release fixtures must not add synthetic project-wide wrongness records. The read-only validator exercises the CLI and ledger schema without contaminating trust state for later route proofs.'
  }),
  'route-naruto': fixture('execute_and_validate_artifacts', 'sks naruto run "fixture" --agents 4 --max-threads 4 --json', ['subagent-plan.json', 'subagent-events.jsonl', 'subagent-evidence.json', 'naruto-summary.json', 'naruto-gate.json', 'work-order-ledger.json'], 'pass', preparationFixtureContract({ timeout_ms: 90000 })),
  'route-work': fixture('static', '$Work compatibility alias for the Naruto Codex official subagent workflow', [], 'pass', { quality: 'wiring_only', reason: 'Pure alias of $Naruto; official workflow execution is covered by route-naruto.' }),
  'route-plan': fixture('execute', 'sks plan "fixture" --json', [], 'pass'),
  'route-review': fixture('execute', 'sks review --diff HEAD --json', [], 'pass'),
  'route-qa-loop': fixture('execute_and_validate_artifacts', 'sks qa-loop run latest --mock --json', ['completion-proof.json', 'qa-gate.json'], 'blocked', { timeout_ms: 180000, reason: 'qaLoopRun() resolves "latest" via the same globally-unscoped findLatestMission used everywhere else and qa-loop is a two-step prepare-then-run workflow gated between steps by an active-route-not-closed check a single fixture command cannot express.' }),
  'route-research': fixture('execute_and_validate_artifacts', 'sks research run latest --mock --json', ['completion-proof.json', 'research-gate.json'], 'pass', { timeout_ms: 180000 }),
  'route-ppt': fixture('mock', 'sks ppt fixture --mock --json', ['completion-proof.json', { path: 'image-voxel-ledger.json', schema: 'sks.image-voxel-ledger.v1' }, 'ppt-imagegen-review-gate.json', 'ppt-slide-issue-ledger.json'], 'pass', { reason: 'Underlying command intentionally exits non-zero and reports ok:false by honest design (mockPptFixtureGate() hardcodes a blocked mock PPT gate); it does write all four declared artifacts.' }),
  'route-image-ux-review': fixture('mock', 'sks image-ux-review fixture --mock --json', ['completion-proof.json', { path: 'image-voxel-ledger.json', schema: 'sks.image-voxel-ledger.v1' }, 'image-ux-generated-review-ledger.json'], 'pass', { reason: 'imageUxFixture() intentionally overrides the gate to passed:false/execution_class:mock_fixture and always exits non-zero for mock fixture runs so they can never claim a real pass; it does write the declared artifacts.' }),
  'route-computer-use': fixture('execute_and_validate_artifacts', 'sks computer-use import-fixture --mock --json', ['computer-use-evidence-ledger.json', { path: 'image-voxel-ledger.json', schema: 'sks.image-voxel-ledger.v1' }, 'completion-proof.json'], 'blocked', { reason: 'importFixture() unconditionally sets process.exitCode=1 by design (execution_class: mock_fixture) so a mock Computer Use import can never claim a real pass.' }),
  'route-cu': fixture('execute_and_validate_artifacts', 'sks computer-use import-fixture --mock --json', ['computer-use-evidence-ledger.json', { path: 'image-voxel-ledger.json', schema: 'sks.image-voxel-ledger.v1' }, 'completion-proof.json'], 'blocked', {
    reason: 'Same handler as route-computer-use: importFixture() unconditionally sets process.exitCode=1 by design (execution_class: mock_fixture) so a mock Computer Use import can never claim a real pass. execute_and_validate_artifacts already treats a matching claimed_status:\'blocked\' as ok (see feature-fixture-executor.ts\'s statusMatches check), so no special-casing is needed - upgraded from the previous mock registration to get real command-exit and artifact-schema verification.'
  }),
  'route-dfix': fixture('execute_and_validate_artifacts', 'sks dfix fixture --json', ['completion-proof.json', 'dfix-gate.json', 'dfix-verification.json'], 'pass'),
  'route-answer': fixture('static', '$Answer answer-only route policy', [], 'pass', {
    quality: 'wiring_only',
    reason: 'Policy-only route (answer-only conversational mode with no writes); nothing executable to run beyond static contract text.'
  }),
  'route-goal': fixture('static', '$Goal Codex-native control route', [], 'pass', {
    quality: 'wiring_only',
    reason: 'Goal lifecycle is owned entirely by Codex native /goal. The SKS surface only builds a detailed native objective and command; it creates no mission, proof artifact, compatibility loop, or fallback goal state.'
  }),
  'route-align': fixture('execute_and_validate_artifacts', 'sks align fixture --json', ['work-order-ledger.json', 'align-plan.json', 'align-ledger.json', 'align-gate.json', 'completion-proof.json'], 'blocked', {
    reason: 'The Align route fixture creates a real hermetic mission, work-order ledger, and canonical Completion Proof, then honestly closes the work item as blocked because the six modernization workstreams were not executed. This verifies route wiring and proof closure without inventing official-doc work.'
  }),
  'route-super-search': fixture('execute', 'sks run "$Super-Search doctor" --execute --json', [], 'pass'),
  'route-seo-geo-optimizer': fixture('execute_and_validate_artifacts', 'sks seo-geo-optimizer fixture --mode geo --json', ['search-visibility/site-inventory.json', 'search-visibility/geo-findings.json', 'search-visibility/verification-report.json', 'geo-gate.json', 'completion-proof.json'], 'pass'),
  'route-autoresearch': fixture('mock', '$AutoResearch fixture route', ['research-gate.json', 'completion-proof.json'], 'pass', {
    reason: 'Producing research-gate.json + completion-proof.json requires the two-step `research prepare` then `research run latest --mock --autoresearch --json` sequence (same as route-research\'s safe-args setup step), which a single spawned command cannot express; the $AutoResearch pipeline-dispatch route (`sks run "$AutoResearch ..."`) instead writes autoresearch-gate.json, a different contract. Left as documented mock pending multi-step fixture setup support.'
  }),
  'route-mad-sks': fixture('mock', '$MAD-SKS permission gate + sql_plane route', [{ path: 'mad-sks-gate.json', schema: 'sks.mad-sks-gate.v1' }, 'completion-proof.json'], 'pass', {
    reason: 'mad-sks-gate.json is written by materializeAutoSealedMadSks() inside prepareClarificationGate() in pipeline-internals/runtime-core.ts, which only runs via the real Codex App route dispatch pipeline (prepareRoute), not via `sks run "<prompt>" --json` (that CLI command only classifies the route in lightweight prepare mode and never calls prepareRoute); `sks run ... --execute` enters the Naruto execution path instead. No safe single sks CLI invocation reaches materializeAutoSealedMadSks; verified live in a hermetic run where mad-sks-gate.json was not produced. Left as documented mock.'
  }),
  'route-from-chat-img': fixture('mock', '$From-Chat-IMG visual work order route', ['from-chat-img-work-order.md', 'image-voxel-ledger.json', 'completion-proof.json'], 'pass', {
    reason: 'hasFromChatImgSignal() routes $From-Chat-IMG to the full Naruto multi-agent work-order pipeline (routes.ts routeById(\'Naruto\')), which requires real chat-screenshot attachments to produce from-chat-img-work-order.md; there is no lightweight deterministic `--mock` single-command invocation that produces this route\'s specific work-order/coverage artifacts the way route-naruto\'s generic fixture prompt does. Left as documented mock.'
  }),
  'route-ux-review': fixture('mock', 'sks image-ux-review fixture --mock --json', ['completion-proof.json', { path: 'image-voxel-ledger.json', schema: 'sks.image-voxel-ledger.v1' }, 'image-ux-generated-review-ledger.json'], 'pass', { reason: 'Alias of route-image-ux-review ($UX-Review -> $Image-UX-Review); shares the identical underlying command and the same intentional exit-1/ok:false mock-fixture hardening in imageUxFixture().' }),
  'route-db': fixture('execute', 'node ./dist/scripts/db-route-materialization-check.js', [], 'pass', { root_mode: 'source_checkout_required' }),
  'route-wiki': fixture('execute_and_validate_artifacts', 'sks wiki image-ingest test/fixtures/images/one-by-one.png --json', [{ path: 'completion-proof.json', schema: 'sks.completion-proof.v1' }, { path: 'image-voxel-ledger.json', schema: 'sks.image-voxel-ledger.v1' }], 'pass'),
  'route-cleanup': fixture('execute', 'sks cleanup plan --json', [], 'pass', {
    reason: '$Cleanup / sks cleanup destructive apply remains explicit (`run --apply`); contract coverage uses the read-only plan command.'
  }),
  'route-gx': fixture('execute_and_validate_artifacts', 'sks gx validate fixture --mock --json', ['completion-proof.json', { path: 'image-voxel-ledger.json', schema: 'sks.image-voxel-ledger.v1' }, 'gx-validation.json'], 'blocked', { reason: 'gxValidateFixture() intentionally exits non-zero (execution_class: mock_fixture) for an honest mock/blocked result; it does write all three declared artifacts.' }),
  'route-sks': fixture('static', '$SKS control-surface route', ['completion-proof.json'], 'pass', {
    quality: 'wiring_only',
    reason: 'Pure control-surface alias route with no independent behavior beyond the underlying CLI command fixtures it dispatches to.'
  }),
  'route-fast-mode': fixture('execute', 'sks fast-mode status --json', [], 'pass'),
  'route-fast-on': fixture('static', '$Fast-On covered by hermetic fast-mode blackbox toggle test', [], 'pass', {
    quality: 'wiring_only',
    reason: 'Toggle-only dollar-command alias; behavior is covered by the hermetic fast-mode blackbox toggle test suite, not a standalone CLI invocation.'
  }),
  'route-fast-off': fixture('static', '$Fast-Off covered by hermetic fast-mode blackbox toggle test', [], 'pass', {
    quality: 'wiring_only',
    reason: 'Toggle-only dollar-command alias; behavior is covered by the hermetic fast-mode blackbox toggle test suite, not a standalone CLI invocation.'
  }),
  'route-local-model': fixture('execute', 'sks with-local-llm status --json', [], 'pass'),
  'route-with-local-llm-on': fixture('static', '$with-local-llm-on covered by hermetic local-model dollar-command blackbox toggle test', [], 'pass', {
    quality: 'wiring_only',
    reason: 'Toggle-only dollar-command alias; behavior is covered by the hermetic local-model dollar-command blackbox toggle test suite, not a standalone CLI invocation.'
  }),
  'route-with-local-llm-off': fixture('static', '$with-local-llm-off covered by hermetic local-model dollar-command blackbox toggle test', [], 'pass', {
    quality: 'wiring_only',
    reason: 'Toggle-only dollar-command alias; behavior is covered by the hermetic local-model dollar-command blackbox toggle test suite, not a standalone CLI invocation.'
  }),
  'route-help': fixture('static', '$Help lightweight route', [], 'pass', {
    quality: 'wiring_only',
    reason: 'Pure alias of the cli-help command; no independent behavior to verify beyond cli-help\'s own execute fixture.'
  }),
  'route-commit': fixture('mock', '$Commit git route', ['completion-proof.json'], 'pass', {
    reason: 'Dollar-command alias of cli-commit; dispatches to the same simpleGitCommitCommand() that performs a real `git add -A && git commit` with no working --dry-run mode, so it is not safe to execute from an automated fixture runner. Left as documented mock alongside cli-commit.'
  }),
  'route-commit-and-push': fixture('mock', '$Commit-And-Push git route', ['completion-proof.json'], 'pass', {
    reason: 'Dollar-command alias of cli-commit-and-push; dispatches to the same simpleGitCommitCommand() that performs a real commit and `git push` with no working --dry-run mode. Left as documented mock alongside cli-commit-and-push.'
  }),
  'route-release-review': fixture('execute_and_validate_artifacts', 'sks naruto run "$Release-Review release audit" --agents 3 --max-threads 3 --read-only --json', ['subagent-plan.json', 'subagent-events.jsonl', 'subagent-evidence.json', 'naruto-summary.json', 'naruto-gate.json', 'work-order-ledger.json'], 'pass', preparationFixtureContract({ timeout_ms: 90000 })),
  'proof-official-subagent-evidence': fixture('execute_and_validate_artifacts', 'sks naruto run "fixture" --agents 2 --max-threads 2 --json', ['subagent-plan.json', 'subagent-events.jsonl', 'subagent-parent-summary.json', 'subagent-evidence.json', 'naruto-gate.json'], 'pass', preparationFixtureContract({ timeout_ms: 90000 }))
});

const STATIC_CONTRACT_FEATURES = new Set([
  'cli-wizard',
  'cli-bootstrap',
  'cli-deps',
  'cli-auth',
  'cli-codex-native',
  'cli-mad',
  'cli-auto-review',
  'cli-commit',
  'cli-commit-and-push',
  'cli-context7',
  'cli-all-features',
  'cli-eval',
  'cli-harness',
  'cli-naruto',
  'cli-reasoning',
  'cli-profile',
  'cli-gates',
  'cli-postinstall',
  'cli-menubar',
  'cli-stop-gate',
  'cli-route',
  'cli-loop',
  'cli-autoresearch',
  'cli-hook',
  'handler-$',
  'handler-autoresearch',
  'handler-autoreview',
  'handler-computer-use',
  'handler-cu',
  'handler-dollars',
  'handler-mad-sks',
  'handler-postinstall'
]);

export function fixtureForFeature(featureId: any) {
  const fixtures = FIXTURES as Record<string, any>;
  if (fixtures[featureId]) return fixtures[featureId];
  if (STATIC_CONTRACT_FEATURES.has(featureId)) {
    return fixture('static', `explicit static contract fixture: ${featureId}`, [], 'pass', {
      quality: 'static_contract',
      root_mode: 'source_checkout_required'
    });
  }
  if (String(featureId || '').startsWith('skill-')) {
    return fixture('static', `skill contract: ${featureId}`, [], 'pass', { quality: 'static_contract', root_mode: 'source_checkout_required' });
  }
  return fixture('not_available', null, [], 'missing', {
    quality: 'missing',
    fallback_removed: true,
    reason: 'No explicit fixture registered for this feature.'
  });
}

export function fixtureSummary(features: any = []) {
  const counts: Record<string, number> = {};
  const quality_counts: Record<string, number> = Object.fromEntries(FEATURE_QUALITY_LEVELS.map((level: any) => [level, 0]));
  const missing: any[] = [];
  for (const feature of features) {
    const status = feature.fixture?.status || 'missing';
    counts[status] = (counts[status] || 0) + 1;
    const quality = feature.fixture?.quality || 'missing';
    quality_counts[quality] = (quality_counts[quality] || 0) + 1;
    if (!feature.fixture) missing.push(feature.id);
  }
  return {
    schema: FEATURE_FIXTURE_SCHEMA,
    counts,
    quality_counts,
    missing,
    ok: missing.length === 0 && !counts.missing
  };
}

export function validateFeatureFixtures(features: any = []) {
  const blockers: any[] = [];
  for (const feature of features) {
    const fx = feature.fixture;
    if (!fx) {
      blockers.push(`${feature.id}:fixture_missing`);
      continue;
    }
    if (!['contract', 'execute', 'execute_and_validate_artifacts', 'mock', 'static', 'real_optional', 'not_available'].includes(fx.kind)) blockers.push(`${feature.id}:fixture_kind`);
    if (!FEATURE_QUALITY_LEVELS.includes(fx.quality)) blockers.push(`${feature.id}:fixture_quality`);
    if (!['pass', 'missing', 'blocked', 'not_required'].includes(fx.status)) blockers.push(`${feature.id}:fixture_status`);
    if ((fx.kind === 'mock' || fx.kind === 'static') && !fx.command && fx.status !== 'not_required') blockers.push(`${feature.id}:fixture_command`);
    if (!Array.isArray(fx.expected_artifacts)) blockers.push(`${feature.id}:fixture_expected_artifacts`);
  }
  return { ok: blockers.length === 0, blockers };
}

function fixture(kind: any, command: any, expected_artifacts: any, status: any, extra: any = {}) {
  const quality = extra.quality || qualityForKind(kind);
  const rootMode = extra.root_mode || (kind === 'execute_and_validate_artifacts' || kind === 'execute' || kind === 'mock' ? 'hermetic_temp_project' : 'source_checkout_required');
  return {
    kind,
    quality,
    root_mode: rootMode,
    command,
    expected_artifacts,
    status,
    explicit: true,
    fallback_removed: true,
    ...extra
  };
}

function preparationFixtureContract(extra: any = {}) {
  return {
    timeout_ms: 90000,
    codex_app_session: true,
    completion_semantics: 'preparation_only',
    expected_stdout_fields: {
      ok: false,
      status: 'delegation_context_ready',
      completion_evidence: false
    },
    expected_artifact_fields: {
      'naruto-gate.json': {
        passed: false
      }
    },
    reason: 'Codex App execution prepares delegation in the current parent. The fixture passes only when stdout remains ok:false/status:delegation_context_ready and naruto-gate.json remains passed:false.',
    ...extra
  };
}

function qualityForKind(kind: any) {
  if (kind === 'execute' || kind === 'execute_and_validate_artifacts') return 'runtime_verified';
  if (kind === 'mock') return 'wiring_only';
  if (kind === 'real_optional') return 'integration_optional';
  if (kind === 'not_available') return 'missing';
  return 'static_contract';
}
