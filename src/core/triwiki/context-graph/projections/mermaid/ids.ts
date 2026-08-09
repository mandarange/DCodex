/**
 * Stable Mermaid node/edge ids: n_ + lowercase RFC4648 base32 digest (atlas style).
 */
import { sha256 } from '../../../../fsx.js';
import type { MermaidSafeId } from './contracts.js';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const DIGEST_CHARS = 12;

function base32Lower(bytes: Buffer): string {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET.charAt((value >>> bits) & 31);
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET.charAt((value << (5 - bits)) & 31);
  return out;
}

function digestToken(value: string, chars: number): string {
  return base32Lower(Buffer.from(sha256(value), 'hex')).slice(0, chars);
}

function joinInjective(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('');
}

export function mermaidNodeId(sourceId: string): MermaidSafeId {
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    throw new Error('mermaid_empty_source_id');
  }
  for (const length of [DIGEST_CHARS, 16, 24, 32, 64]) {
    const id = `n_${digestToken(sourceId, length)}`;
    return id as MermaidSafeId;
  }
  throw new Error('MERMAID_NODE_ID_COLLISION');
}

export function mermaidSubgraphId(sourceId: string): MermaidSafeId {
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    throw new Error('mermaid_empty_subgraph_source_id');
  }
  return `sg_${digestToken(sourceId, DIGEST_CHARS)}` as MermaidSafeId;
}

export function mermaidEdgeId(fromSourceId: string, toSourceId: string, edgeType: string): string {
  if (!fromSourceId || !toSourceId || !edgeType) throw new Error('mermaid_empty_edge_endpoint');
  return `e_${digestToken(joinInjective([fromSourceId, toSourceId, edgeType]), DIGEST_CHARS)}`;
}

export function assertInjective(sourceIds: readonly string[]): Map<string, MermaidSafeId> {
  const bySourceId = new Map<string, MermaidSafeId>();
  const owners = new Map<string, string>();
  for (const sourceId of sourceIds) {
    if (bySourceId.has(sourceId)) throw new Error(`mermaid_duplicate_source_id: ${sourceId}`);
    let assigned: MermaidSafeId | null = null;
    for (const length of [DIGEST_CHARS, 16, 24, 32, 64]) {
      const candidate = `n_${digestToken(sourceId, length)}` as MermaidSafeId;
      const owner = owners.get(candidate);
      if (owner === undefined) {
        owners.set(candidate, sourceId);
        assigned = candidate;
        break;
      }
      if (owner === sourceId) {
        assigned = candidate;
        break;
      }
    }
    if (!assigned) throw new Error(`mermaid_node_id_collision: ${sourceId}`);
    bySourceId.set(sourceId, assigned);
  }
  return bySourceId;
}
