/**
 * Lays the sections out and stamps the header.
 *
 * Canonical section order is the declaration order of the required list, so two
 * writers cannot disagree about layout while agreeing about content.
 */
import {
  CONTEXT_INDEX_FORMAT_REVISION,
  CONTEXT_INDEX_HEADER_BYTES,
  CONTEXT_INDEX_REQUIRED_SECTIONS,
  CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES,
  ContextIndexFormatError,
  contextIndexChecksum,
  encodeContextIndexHeader,
  encodeSectionDescriptor,
  type ContextIndexSectionKind,
  type SectionDescriptor,
} from './format.js';
import type { ContextIndexWriteResult } from './writer-types.js';

export function assemble(
  payloads: ReadonlyMap<ContextIndexSectionKind, { bytes: Uint8Array; count: number }>,
  header: {
    schemaRevision: number;
    snapshotHash: Uint8Array;
    configHash: Uint8Array;
    nodeCount: number;
    edgeCount: number;
    termCount: number;
    provenanceCount: number;
    stringCount: number;
  },
  // The lexicon summary is not the assembler's to know: it describes a build
  // that happened before the interner was sealed, and this function only lays
  // out bytes. The caller attaches it.
): Omit<ContextIndexWriteResult, 'lexicon'> {
  // Canonical section order is the declaration order of the required list, so
  // two writers cannot disagree about layout while agreeing about content.
  const kinds = CONTEXT_INDEX_REQUIRED_SECTIONS;
  const tableEnd = CONTEXT_INDEX_HEADER_BYTES + kinds.length * CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES;
  let cursor = tableEnd;
  const descriptors: SectionDescriptor[] = [];
  const sectionBytes: Record<string, number> = {};
  for (const kind of kinds) {
    const payload = payloads.get(kind);
    if (!payload) throw new ContextIndexFormatError('section_missing', { kind });
    descriptors.push({
      kind,
      count: payload.count,
      offset: BigInt(cursor),
      length: BigInt(payload.bytes.length),
      checksum: contextIndexChecksum(payload.bytes),
    });
    sectionBytes[String(kind)] = payload.bytes.length;
    cursor += payload.bytes.length;
  }

  const bytes = new Uint8Array(cursor);
  bytes.set(encodeContextIndexHeader({
    formatRevision: CONTEXT_INDEX_FORMAT_REVISION,
    schemaRevision: header.schemaRevision,
    flags: 0,
    nodeCount: header.nodeCount,
    edgeCount: header.edgeCount,
    termCount: header.termCount,
    provenanceCount: header.provenanceCount,
    snapshotHash: header.snapshotHash,
    configHash: header.configHash,
    sectionCount: kinds.length,
  }), 0);
  descriptors.forEach((descriptor, position) => {
    bytes.set(encodeSectionDescriptor(descriptor), CONTEXT_INDEX_HEADER_BYTES + position * CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES);
  });
  kinds.forEach((kind, position) => {
    bytes.set((payloads.get(kind) as { bytes: Uint8Array }).bytes, Number((descriptors[position] as SectionDescriptor).offset));
  });

  return {
    bytes,
    nodeCount: header.nodeCount,
    edgeCount: header.edgeCount,
    provenanceCount: header.provenanceCount,
    stringCount: header.stringCount,
    sectionBytes: Object.freeze(sectionBytes),
  };
}
