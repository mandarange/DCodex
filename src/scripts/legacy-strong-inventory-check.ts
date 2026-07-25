import { assertGate, emitGate, importDist, readJson, readText, root } from './gate-lib.js';

const impactMod = await importDist('core/triwiki/triwiki-gate-impact-map.js');
const map = impactMod.buildTriWikiGateImpactMap(root);
const migration = readText('docs/sks-4-migration.md');
const currentVersion = String(readJson('package.json').version || '');
assertGate(/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(currentVersion), 'package version must be valid before evaluating legacy allowlist expiry', { currentVersion });
const allowlist = parseAllowlist(migration, currentVersion);
const gates = ((readJson('release-gates.v2.json').gates || []) as Array<{ id: string; command: string; preset?: string[] }>);
const legacyOrphans = map.impacts.filter((impact: { orphan: boolean; gate_id: string }) => impact.orphan && removableLegacy(impact.gate_id, ''));
const legacyPresent = gates.filter((gate) => gate.preset?.includes('release') && removableLegacy(gate.id, gate.command) && !isAllowed(gate.id, allowlist));
assertGate(legacyOrphans.length === 0 && legacyPresent.length === 0, 'removable legacy gates must not remain unless covered by a non-expired structured allowlist', { legacyOrphans, legacyPresent: legacyPresent.slice(0, 30), allowlist });
emitGate('legacy:strong-inventory', { legacy_orphans: legacyOrphans.length, legacy_present: legacyPresent.length, allowlist: allowlist.length });

function removableLegacy(id: string, command: string): boolean {
  const surface = `${id} ${command}`;
  return /^team:/.test(id)
    || /^legacy:upgrade-zero-break$/.test(id)
    || /(^|:)tmux($|:|-)/.test(surface)
    || /^codex:0\.135/.test(id)
    || /^codex:0\.136/.test(id)
    || /codex[:.-]?0139/.test(id)
    || /codex-0139/.test(command);
}

function parseAllowlist(text: string, currentVersion: string): Array<{ id: string; reason: string; owner: string; expires: string }> {
  return [...text.matchAll(/<!--\s*sks-legacy-allowlist\s*([\s\S]*?)-->/g)].map((match) => {
    const body = match[1] || '';
    return { id: field(body, 'id'), reason: field(body, 'reason'), owner: field(body, 'owner'), expires: field(body, 'expires') };
  }).filter((row) => row.id && row.reason && row.owner && compareVersion(row.expires, currentVersion) > 0);
}

function isAllowed(id: string, allowlist: Array<{ id: string }>): boolean {
  return allowlist.some((row) => row.id.endsWith('*') ? id.startsWith(row.id.slice(0, -1)) : row.id === id);
}

function field(body: string, name: string): string {
  return body.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim() || '';
}

function compareVersion(a: string, b: string): number {
  const left = (a.split(/[+-]/, 1)[0] || '').split('.').map(Number);
  const right = (b.split(/[+-]/, 1)[0] || '').split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const delta = (left[i] || 0) - (right[i] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}
