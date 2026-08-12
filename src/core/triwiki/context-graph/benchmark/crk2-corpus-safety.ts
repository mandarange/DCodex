/**
 * Protected gates and write-scope conflicts — the two equality floors.
 *
 * `protectedGateRecall = 1.0` and `conflictRecall = 1.0` are not thresholds,
 * so a single case in this file that comes back short fails the whole run. The
 * gate cases and the conflict cases are deliberately linked: a protected gate is
 * paired with the collision it exists to prevent, so a run cannot satisfy one
 * floor by quietly dropping the other.
 *
 * A high-risk review that omits its protected gate is worse than no answer,
 * because it reads as an all-clear.
 */
import type { Crk2Case } from './crk2-types.js';
import {
  CRK2_DEFAULT_K,
  EMPTY_GOLD,
  KERNEL,
  KO_CLAIM,
  LEGACY_CLAIM,
  file,
  gate
} from './crk2-corpus-workspace.js';

/** Protected-gate and conflict cases, in their authored order. */
export const CRK2_SAFETY_CASES: readonly Crk2Case[] = [
  {
    id: 'protected-gate-release-proof',
    title: 'protected gate lookup by name',
    query: 'release proof integrity gate',
    category: 'protected_gate',
    workspace: 'crk2-retrieval',
    profile: 'review',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 8000,
    risk: 'high',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [gate('release-proof-integrity')],
      gateIds: ['release-proof-integrity'],
      protectedGateIds: ['release-proof-integrity'],
      relevantNodeIds: [file('release-gates.v2.json'), file('.sneakoscope/wiki/proof-index.json')]
    },
    rationale: 'Gate ids are anchors; a gate reachable only through its manifest file is a gate that ranking can lose.'
  },
  {
    id: 'protected-gate-write-scope',
    title: 'protected gate covering parallel writes',
    query: 'which gate stops two slices writing the same file',
    category: 'protected_gate',
    workspace: 'crk2-retrieval',
    profile: 'review',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 8000,
    risk: 'high',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [gate('write-scope-isolation')],
      gateIds: ['write-scope-isolation'],
      protectedGateIds: ['write-scope-isolation'],
      relevantNodeIds: [file('.sneakoscope/naruto/slice-plan.json')]
    },
    rationale: 'Links a protected gate to the conflict it exists to prevent, so a run cannot pass one floor by dropping the other.'
  },
  {
    id: 'protected-gate-budget-squeeze',
    title: 'protected gate under a budget too small to hold it',
    query: 'review the redaction change',
    category: 'protected_gate',
    workspace: 'crk2-retrieval',
    profile: 'review',
    changedPaths: ['src/core/security/redaction-guard.ts'],
    focusPaths: [],
    tokenBudget: 400,
    risk: 'high',
    k: 3,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [gate('secret-redaction')],
      gateIds: ['secret-redaction'],
      protectedGateIds: ['secret-redaction'],
      maxTokenCost: 400
    },
    rationale: 'Work order §12.3: a protected gate squeezed out by a budget needs an explicit warning, never a silent omission.'
  },
  {
    id: 'conflict-parallel-write-registry',
    title: 'two slices writing one file',
    query: 'do any planned slices collide on a write',
    category: 'conflict',
    workspace: 'crk2-retrieval',
    profile: 'review',
    changedPaths: ['src/core/naruto/slice-writer-a.ts', 'src/core/naruto/slice-writer-b.ts'],
    focusPaths: [],
    tokenBudget: 8000,
    risk: 'high',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file('src/core/shared/registry.ts')],
      relevantNodeIds: [file('src/core/naruto/slice-writer-a.ts'), file('src/core/naruto/slice-writer-b.ts')],
      conflicts: [{ path: 'src/core/shared/registry.ts', slices: ['slice-writer-a', 'slice-writer-b'] }],
      gateIds: ['write-scope-isolation'],
      protectedGateIds: ['write-scope-isolation']
    },
    rationale: 'The canonical write-scope collision. Conflict recall is an equality floor, so one missed pair fails the run.'
  },
  {
    id: 'conflict-three-way-barrel-write',
    title: 'three slices writing one barrel file',
    query: 'which slices all need to edit the query barrel',
    category: 'conflict',
    workspace: 'crk2-retrieval',
    profile: 'review',
    changedPaths: ['src/core/naruto/slice-writer-a.ts', 'src/core/naruto/slice-writer-b.ts', 'src/core/naruto/slice-writer-c.ts'],
    focusPaths: [],
    tokenBudget: 8000,
    risk: 'high',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file('src/core/triwiki/context-graph/query/index.ts')],
      relevantNodeIds: [file('src/core/naruto/slice-writer-c.ts')],
      conflicts: [
        {
          path: 'src/core/triwiki/context-graph/query/index.ts',
          slices: ['slice-writer-a', 'slice-writer-b', 'slice-writer-c']
        }
      ],
      gateIds: ['write-scope-isolation'],
      protectedGateIds: ['write-scope-isolation']
    },
    rationale: 'An n-way collision is not three pairwise ones; a detector built on pairs reports this as two conflicts or none.'
  },
  {
    id: 'conflict-contradicting-wiki-claim',
    title: 'two wiki claims that contradict each other',
    query: 'what is the current context retrieval budget claim',
    category: 'conflict',
    workspace: 'crk2-retrieval',
    profile: 'answer',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 8000,
    risk: 'high',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(KO_CLAIM)],
      forbiddenNodeIds: [file(LEGACY_CLAIM)],
      relevantNodeIds: [file('config/context-graph.json')]
    },
    rationale: 'A superseded claim returned beside the live one is a contradiction handed to the caller as if it were evidence.'
  },
  {
    id: 'conflict-invalidated-proof',
    title: 'a proof invalidated by a later change',
    query: 'is the context retrieval baseline proof still valid',
    category: 'conflict',
    workspace: 'crk2-retrieval',
    profile: 'answer',
    changedPaths: [KERNEL],
    focusPaths: [],
    tokenBudget: 8000,
    risk: 'high',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: ['proof:context-retrieval-baseline', file('.sneakoscope/wiki/proof-index.json')],
      gateIds: ['release-proof-integrity'],
      protectedGateIds: ['release-proof-integrity']
    },
    rationale: 'An invalidated proof must surface with its gate; answering only the proof lets a stale attestation look current.'
  }
];
