/**
 * SSOT authority collision analysis (WO §9.3).
 * Uses the shared safety inventory — never duplicates domain lists into policy.
 */
import type { SsotAuthorityDomain } from '../../../safety/ssot-authority-inventory.js';
import { byCodePoint, type ArchitectureFinding } from './contracts.js';
import { makeFinding } from './finding-factory.js';
import type { ArchitectureMapPolicy } from './policy.js';

function severity(
  policy: ArchitectureMapPolicy,
  code: 'ssot_collision' | 'insufficient_graph' | 'authority_bypass'
) {
  return policy.blockingCodes.includes(code) ? ('blocking' as const) : ('warning' as const);
}

export function analyzeSsotCollisions(input: {
  policy: ArchitectureMapPolicy;
  inventory: readonly SsotAuthorityDomain[];
  requireInventory?: boolean;
}): ArchitectureFinding[] {
  if (!input.inventory.length) {
    if (!input.requireInventory) return [];
    return [
      makeFinding({
        code: 'insufficient_graph',
        severity: severity(input.policy, 'insufficient_graph'),
        subjectIds: ['ssot_inventory'],
        evidenceIds: ['ssot_inventory:empty'],
        ruleId: 'ssot-inventory-required',
        message: 'SSOT inventory is empty; collision analysis cannot pass closed'
      })
    ];
  }

  const byPath = new Map<string, string[]>();
  for (const domain of input.inventory) {
    for (const path of domain.canonicalSources) {
      const owners = byPath.get(path) ?? [];
      owners.push(domain.id);
      byPath.set(path, owners);
    }
  }

  const findings: ArchitectureFinding[] = [];
  for (const [path, owners] of [...byPath.entries()].sort(([left], [right]) => byCodePoint(left, right))) {
    const unique = [...new Set(owners)].sort(byCodePoint);
    if (unique.length > 1) {
      findings.push(
        makeFinding({
          code: 'ssot_collision',
          severity: severity(input.policy, 'ssot_collision'),
          subjectIds: unique,
          evidenceIds: [path],
          ruleId: 'ssot-path-collision',
          message: `Canonical path ${path} claimed by multiple SSOT domains: ${unique.join(', ')}`
        })
      );
    }
  }

  for (const domain of input.inventory) {
    const writers = new Set(domain.allowedWriters);
    for (const reader of domain.allowedReaders) {
      if (writers.has(reader) && domain.canonicalSources.length === 0) {
        findings.push(
          makeFinding({
            code: 'authority_bypass',
            severity: severity(input.policy, 'authority_bypass'),
            subjectIds: [domain.id, reader],
            evidenceIds: [domain.id],
            ruleId: 'ssot-authority-bypass',
            message: `SSOT domain ${domain.id} has reader/writer ${reader} without canonical sources`
          })
        );
      }
    }
  }

  return findings.sort((left, right) => byCodePoint(left.id, right.id));
}
