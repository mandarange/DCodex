import path from 'node:path'
import { nowIso, runProcess } from '../fsx.js'
import { type CodexControlBackend } from '../codex-control/codex-control-plane.js'
import { defaultImplementationBlueprint } from './implementation-blueprint.js'

export async function densifyImplementationBlueprint(input: {
  root: string
  dir: string
  plan: any
  claimMatrix: any
  sourceLedger: any
  existingBlueprint: any
  backend: Exclude<CodexControlBackend, 'fake'> | 'deterministic'
}): Promise<any> {
  const fileMap = await repositoryFileMap(input.root)
  const likelyFiles = likelyTargetFiles(fileMap, input.plan, input.claimMatrix)
  const base = input.existingBlueprint || defaultImplementationBlueprint(input.plan)
  const claims = Array.isArray(input.claimMatrix?.claims) ? input.claimMatrix.claims : []
  const keyClaimIds = Array.isArray(input.claimMatrix?.key_claim_ids) ? input.claimMatrix.key_claim_ids : claims.slice(0, 8).map((claim: any) => claim.id)
  const prompt = String(input.plan?.prompt || base.prompt || '')
  const repositoryScoped = likelyFiles.length >= 3 && repositoryIntent(prompt, claims)
  const evidenceArtifacts = ['research-plan.json', 'source-ledger.json', 'claim-evidence-matrix.json', 'falsification-ledger.json', 'research-report.md', String(input.plan?.artifacts?.research_paper || input.plan?.paper_artifact || 'research-paper.md')]
  if (!repositoryScoped) {
    const sections = [
      section('problem', 'Research Question And Boundary', `The validation handoff addresses “${prompt}” without converting a general scientific or strategic question into an SKS code-maintenance task. It preserves ${keyClaimIds.length} key claim ids, distinguishes facts from hypotheses, and treats missing evidence as a blocker rather than inventing a repository patch.`, keyClaimIds, evidenceArtifacts.slice(0, 4), ['The question, scope boundary, and disallowed overclaims are explicit.']),
      section('decision', 'Surviving Decision', `Carry forward only claims that remain source-linked after counterevidence and falsification. The handoff is a research-validation plan, not an implementation promise; any claim that lacks independent confirmation is downgraded or removed before the final paper is used.`, keyClaimIds, evidenceArtifacts.slice(1, 5), ['Every retained key claim has known source ids and a decisive probe.']),
      section('architecture', 'Evidence Structure', `Organize the result as a dependency chain from source ledger to semantic claim matrix, falsification cases, experiment steps, manuscript synthesis, and independent adversarial review. Each downstream conclusion must remain traceable to the upstream source and claim identifiers.`, keyClaimIds, evidenceArtifacts, ['No conclusion bypasses source, claim, and falsification artifacts.']),
      section('interfaces', 'Inputs And Outputs', `Inputs are the research question, source locators/content notes, claim-evidence links, and explicit counterevidence. Outputs are a dated paper, an experiment plan, a replication pack, and a list of unresolved limitations that another researcher can independently inspect.`, keyClaimIds, evidenceArtifacts, ['Inputs and outputs are named with reproducible artifact paths.']),
      section('data_contracts', 'Evidence Contracts', `Each source retains locator, publisher or author, date, credibility, hydrated notes or content hash, and semantic claim links. Each claim retains supporting and undermining source ids, confidence, falsifiability, and the next decisive test; context-only sources never count as support.`, keyClaimIds, ['source-ledger.json', 'claim-evidence-matrix.json'], ['High and critical claims cannot pass on titles, snippets, or duplicated identifiers alone.']),
      section('execution_plan', 'Step By Step Validation', `1. Reproduce the strongest supporting source for each key claim.\n2. Reproduce the strongest counterevidence and check source independence.\n3. Execute or specify the cheapest decisive falsification test.\n4. Compare observed results with the acceptance threshold.\n5. Downgrade, refute, or retain the claim and update the paper with remaining uncertainty.`, keyClaimIds, ['falsification-ledger.json', 'experiment-plan.json', 'replication-pack.json'], ['Every step produces evidence that can change the claim verdict.']),
      section('verification_plan', 'Independent Verification', `Use three reviewers that independently cover source integrity and claim linkage, methodology and formal validity, and falsification and replication feasibility. Verification passes only when every reviewer has a distinct completed official thread outcome and no critical, major, or required revision remains. Minor concerns remain recorded as advisory findings.`, keyClaimIds, ['research-adversarial-review.json', 'research-adversarial-convergence.json'], ['Three distinct evidence-correlated reviewer outcomes have no open material objections.']),
      section('risks_and_rollbacks', 'Risks, Retractions, And Rollback', `Primary risks are false triangulation, topic drift, publication or novelty overclaim, inaccessible evidence, and an experiment that cannot distinguish the proposed mechanism from a simpler explanation. Rollback means withdrawing the affected claim, restoring the previous manuscript snapshot, and recording the failed assumption in the ledger.`, keyClaimIds, ['research-honest-mode.json', 'research-revision-ledger.json'], ['Unsupported claims are withdrawn without weakening evidence gates.'])
    ]
    return {
      ...base,
      schema: 'sks.research-implementation-blueprint.v1',
      generated_at: nowIso(),
      prompt,
      implementation_allowed_in_research: false,
      handoff_route: 'research_validation',
      handoff_type: 'research_validation',
      repository_aware: false,
      domain_research: true,
      existing_files: evidenceArtifacts,
      possible_new_files: [],
      validation_targets: keyClaimIds.length ? keyClaimIds : ['supporting evidence', 'counterevidence', 'falsification result', 'replication feasibility'],
      api_schema_changes: [],
      test_commands: [
        'procedure: reproduce supporting evidence from source-ledger.json',
        'procedure: run the decisive falsification test from experiment-plan.json',
        'procedure: independently audit claim links and unresolved objections'
      ],
      rollback_steps: [
        'Withdraw or downgrade claims that fail reproduction or falsification.',
        'Restore the prior source-linked manuscript and record the invalidated assumption.'
      ],
      parallel_work_decomposition: [
        'Lane A supporting-evidence reproduction.',
        'Lane B counterevidence and alternative explanations.',
        'Lane C falsification and experiment design.',
        'Lane D citation, logic, and replication audit.'
      ],
      sections,
      dependencies: ['source-ledger.json', 'claim-evidence-matrix.json', 'falsification-ledger.json'],
      out_of_scope: ['Repository source mutation during $Research runs.', 'Guaranteed novelty, genius-level quality, or publication acceptance.'],
      open_questions: []
    }
  }

  const possibleNewFiles: string[] = []
  const sections = [
    section('problem', 'Problem', `The repository-scoped handoff addresses “${prompt}” and preserves ${keyClaimIds.length} source-linked key claims before implementation. It names only files whose paths match the research question or claim language and avoids substituting generic SKS Research internals.`, keyClaimIds, likelyFiles.slice(0, 8), ['Every proposed file is relevant to the stated repository problem.']),
    section('decision', 'Decision', 'Use the smallest repository change that follows from the surviving evidence, while keeping Research itself read-only. If the evidence does not justify a code change, return a blocked implementation handoff instead of inventing one.', keyClaimIds, likelyFiles.slice(0, 8), ['The decision is traceable to key claim and source ids.']),
    section('architecture', 'Architecture', `Map the proposed behavior through the relevant current modules: ${likelyFiles.slice(0, 12).join(', ')}. Preserve existing ownership boundaries, remove duplicate paths only when current references prove they are dead, and keep integration parent-owned.`, keyClaimIds, likelyFiles, ['Module ownership and dependency impact are explicit.']),
    section('interfaces', 'API And Schema Changes', 'List only interfaces, commands, schemas, or configuration fields required by the supported claim. Compatibility shims remain only when an active public caller exists; otherwise the implementation route may remove them with focused tests.', keyClaimIds, likelyFiles, ['Public and internal compatibility effects are enumerated.']),
    section('data_contracts', 'Data Contracts', 'Carry source and claim identifiers into acceptance criteria so implementation cannot pass on artifact existence alone. State failure, ambiguity, stale evidence, and rollback behavior for every changed contract.', keyClaimIds, likelyFiles, ['Success and failure schemas are both covered.']),
    section('execution_plan', 'Step By Step Implementation', implementationSteps(likelyFiles).join('\n'), keyClaimIds, likelyFiles, ['Each numbered step has bounded files and a decision-relevant check.']),
    section('verification_plan', 'Verification Plan', 'Run the smallest affected type, unit, integration, or contract checks that could change the implementation decision. Reserve release-wide checks for the release route and do not repeat clean builds inside a development loop.', keyClaimIds, likelyFiles, ['Verification is scoped, non-duplicative, and tied to changed behavior.']),
    section('risks_and_rollbacks', 'Risks And Rollbacks', 'Risks include overgeneralizing research evidence, changing unrelated files, preserving dead compatibility code, and claiming success from stale proof. Roll back the bounded implementation patch and restore the prior contract if the affected checks or read-back evidence fail.', keyClaimIds, likelyFiles, ['Rollback paths and invalidation conditions are explicit.'])
  ]
  return {
    ...base,
    schema: 'sks.research-implementation-blueprint.v1',
    generated_at: nowIso(),
    prompt: input.plan?.prompt || base.prompt || '',
    implementation_allowed_in_research: false,
    handoff_route: '$Naruto',
    handoff_type: 'repository_implementation',
    repository_aware: true,
    domain_research: false,
    existing_files: likelyFiles,
    possible_new_files: possibleNewFiles,
    validation_targets: keyClaimIds,
    api_schema_changes: [
      'Only evidence-supported public or internal contracts named in the sections above.'
    ],
    test_commands: [
      'affected typecheck for the named files',
      'focused unit or contract tests for the changed behavior',
      'one integration or read-back check that exercises the supported claim'
    ],
    rollback_steps: [
      'Revert only the files listed in the follow-up patch plan.',
      'Restore the previous public/internal contract when the affected verification fails.',
      'Record which research assumption was invalidated before retrying.'
    ],
    parallel_work_decomposition: [
      'WS-A contract and architecture review.',
      'WS-B bounded implementation in disjoint files.',
      'WS-C focused test and failure-path review.',
      'WS-D parent integration, rollback, and final verification.'
    ],
    sections,
    dependencies: ['claim-evidence-matrix.json', 'source-ledger.json', 'falsification-ledger.json'],
    out_of_scope: ['Repository source mutation during $Research runs.'],
    open_questions: []
  }
}

async function repositoryFileMap(root: string): Promise<string[]> {
  const result = await runProcess('git', ['ls-files'], { cwd: root, timeoutMs: 15000, maxOutputBytes: 2 * 1024 * 1024 }).catch(() => ({ code: 1, stdout: '' }))
  return String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

function likelyTargetFiles(files: string[], plan: any, claimMatrix: any): string[] {
  const promptTerms = new Set(String(plan?.prompt || '').toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 3))
  const guidanceTerms = new Set<string>((Array.isArray(claimMatrix?.claims) ? claimMatrix.claims : []).flatMap((claim: any) => String(claim?.claim || '').toLowerCase().split(/[^a-z0-9]+/)).filter((term: string) => term.length > 5))
  const matched = files.filter((file) => {
    const lower = file.toLowerCase()
    return [...promptTerms, ...guidanceTerms].some((term: string) => lower.includes(term))
  }).slice(0, 30)
  return [...new Set(matched)].slice(0, 40)
}

function repositoryIntent(prompt: string, claims: any[]): boolean {
  const text = `${prompt}\n${claims.map((claim: any) => String(claim?.claim || '')).join('\n')}`
  return /\b(?:code|repository|repo|package|module|function|class|api|cli|command|config|schema|test|bug|implementation|refactor|migration|release|deploy|typescript|javascript|rust|python)\b|(?:코드|저장소|리포지토리|패키지|모듈|함수|클래스|명령|설정|스키마|테스트|버그|구현|리팩터|마이그레이션|배포)/i.test(text)
}

function section(id: string, title: string, detail: string, claimIds: string[], targetPaths: string[], acceptanceChecks: string[]) {
  return {
    id,
    title,
    order: ['problem', 'decision', 'architecture', 'interfaces', 'data_contracts', 'execution_plan', 'verification_plan', 'risks_and_rollbacks'].indexOf(id) + 1,
    detail,
    evidence_claim_ids: claimIds.slice(0, 8),
    target_paths: targetPaths,
    acceptance_checks: acceptanceChecks
  }
}

function implementationSteps(existingFiles: string[]): string[] {
  return [
    `1. Inspect the current contract and references in: ${existingFiles.slice(0, 8).join(', ')}.`,
    '2. Seal one bounded change whose behavior is directly supported by the claim-evidence matrix.',
    '3. Remove or consolidate duplicate code only after current imports, commands, and generated surfaces prove it is unused.',
    '4. Run affected checks for the changed contract, including a failure-path or ambiguity case.',
    '5. Integrate parent-owned results, record rollback conditions, and leave unsupported follow-up work blocked.'
  ]
}
