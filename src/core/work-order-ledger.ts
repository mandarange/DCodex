import path from 'node:path';
import { exists, nowIso, readJson, writeJsonAtomic } from './fsx.js';
import { ARTIFACT_FILES, validateWorkOrderLedger } from './artifact-schemas.js';
import { promptRequirementItems } from './questions.js';

export function createWorkOrderLedger({ missionId = 'unassigned', route = 'Naruto', requests = [], sourcesComplete = false }: any = {}) {
  const items = requests.map((request: any, index: any) => ({
    id: `WO-${String(index + 1).padStart(3, '0')}`,
    source: {
      type: request.type || 'chat_text',
      verbatim: String(request.verbatim || request.text || '').trim(),
      location: request.location || `request:${index + 1}`
    },
    normalized_requirement: String(request.normalized_requirement || request.text || request.verbatim || '').trim(),
    acceptance_criteria: request.acceptance_criteria || [],
    implementation_tasks: request.implementation_tasks || [],
    owner: request.owner || 'parent_orchestrator',
    status: request.status || 'pending',
    implementation_evidence: request.implementation_evidence || [],
    verification_evidence: request.verification_evidence || [],
    unresolved_risks: request.unresolved_risks || [],
    blocker: request.blocker || { blocked: false, reason: null, needed_to_unblock: null }
  }));
  return {
    schema_version: 1,
    mission_id: missionId,
    route,
    created_at: nowIso(),
    source_inventory_complete: Boolean(sourcesComplete),
    all_customer_requests_preserved: items.every((item: any) => Boolean(item.source.verbatim)),
    all_customer_requests_mapped: items.every((item: any) => item.implementation_tasks.length > 0 || item.blocker.blocked === true),
    all_work_items_verified: items.length > 0 && items.every(workOrderItemVerified),
    all_work_items_resolved: items.length > 0 && items.every(workOrderItemResolved),
    items
  };
}

export async function writeWorkOrderLedger(dir: any, ledger: any) {
  await writeJsonAtomic(path.join(dir, ARTIFACT_FILES.work_order_ledger), ledger);
  return validateWorkOrderLedger(ledger);
}

export async function readWorkOrderLedger(dir: any) {
  return readJson(path.join(dir, ARTIFACT_FILES.work_order_ledger), null);
}

export function evaluateWorkOrderCoverage(ledger: any): { ok: boolean; blockers: string[]; uncovered_count: number } {
  if (!ledger) return { ok: true, blockers: [], uncovered_count: 0 };
  const blockers: string[] = [];
  if (!ledger.source_inventory_complete) blockers.push('work_order_inventory_truncated');
  if (!ledger.all_customer_requests_mapped) blockers.push('work_order_requests_not_mapped');
  const allResolved = ledger.all_work_items_resolved === true
    || (ledger.all_work_items_resolved === undefined && (ledger.items || []).every(workOrderItemResolved));
  if (!allResolved) blockers.push('work_order_items_not_resolved');
  let uncovered_count = 0;
  for (const item of (ledger.items || [])) {
    const isVerified = item.status === 'verified'
      && Array.isArray(item.implementation_evidence) && item.implementation_evidence.length > 0
      && Array.isArray(item.verification_evidence) && item.verification_evidence.length > 0;
    const isBlockedWithEvidence = item.status === 'blocked' && item.blocker?.blocked === true;
    if (!isVerified && !isBlockedWithEvidence) {
      uncovered_count += 1;
      if (item.status === 'verified' && (!Array.isArray(item.implementation_evidence) || item.implementation_evidence.length === 0)) {
        blockers.push(`work_order_implementation_evidence_missing:${item.id}`);
      }
      if (item.status === 'verified' && (!Array.isArray(item.verification_evidence) || item.verification_evidence.length === 0)) {
        blockers.push(`work_order_verification_evidence_missing:${item.id}`);
      }
      if (item.status !== 'verified') blockers.push(`work_order_uncovered:${item.id}:"${item.source?.verbatim?.slice(0, 40) || ''}"`);
    }
  }
  return { ok: blockers.length === 0, blockers, uncovered_count };
}

export function updateWorkOrderItem(ledger: any, id: any, patch: any = {}) {
  return {
    ...ledger,
    items: (ledger.items || []).map((item: any) => item.id === id ? { ...item, ...patch } : item),
    all_customer_requests_mapped: (ledger.items || []).every((item: any) => item.id === id
      ? ((patch.implementation_tasks || item.implementation_tasks || []).length > 0 || (patch.blocker || item.blocker || {}).blocked === true)
      : ((item.implementation_tasks || []).length > 0 || item.blocker?.blocked === true)),
    all_work_items_verified: (ledger.items || []).every((item: any) => {
      const next = item.id === id ? { ...item, ...patch } : item;
      return workOrderItemVerified(next);
    }),
    all_work_items_resolved: (ledger.items || []).every((item: any) => {
      const next = item.id === id ? { ...item, ...patch } : item;
      return workOrderItemResolved(next);
    })
  };
}

/**
 * Parses a free-form work-order prompt into WO-001..N ledger items (via
 * promptRequirementItems) and persists the ledger at mission creation time,
 * so every item is registered verbatim before any execution starts.
 */
export async function createAndWriteWorkOrderLedgerForPrompt(dir: any, { missionId, route, prompt }: any = {}) {
  const parsed = semanticSliceRequirementItems(String(prompt || '')) || promptRequirementItems(String(prompt || ''));
  const { items, truncated } = parsed;
  const requests = items.map((item: any) => ({
    type: 'chat_text',
    verbatim: item.text,
    normalized_requirement: item.context ? `${item.context}: ${item.text}` : item.text,
    acceptance_criteria: item.acceptance_context ? [item.acceptance_context] : [],
    location: `prompt:${item.id}`
  }));
  const candidate = createWorkOrderLedger({ missionId, route, requests, sourcesComplete: !truncated });
  const existing = await readWorkOrderLedger(dir);
  const ledger = mergeWorkOrderLedger(existing, candidate);
  await writeWorkOrderLedger(dir, ledger);
  return ledger;
}

export function mergeWorkOrderLedger(existing: any, candidate: any) {
  if (!existing || !Array.isArray(existing.items)) return candidate;
  const seen = new Set(existing.items.map(workOrderRequirementKey).filter(Boolean));
  const appended = (candidate?.items || [])
    .filter((item: any) => {
      const key = workOrderRequirementKey(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((item: any, index: number) => ({
      ...item,
      id: `WO-${String(existing.items.length + index + 1).padStart(3, '0')}`
    }));
  if (appended.length === 0) {
    const items = existing.items;
    return {
      ...existing,
      all_work_items_verified: items.length > 0 && items.every(workOrderItemVerified),
      all_work_items_resolved: items.length > 0 && items.every(workOrderItemResolved)
    };
  }
  const items = [...existing.items, ...appended];
  return {
    ...existing,
    mission_id: existing.mission_id || candidate.mission_id,
    route: existing.route || candidate.route,
    source_inventory_complete: Boolean(existing.source_inventory_complete && candidate.source_inventory_complete),
    all_customer_requests_preserved: items.every((item: any) => Boolean(item.source?.verbatim)),
    all_customer_requests_mapped: items.every((item: any) => (item.implementation_tasks || []).length > 0 || item.blocker?.blocked === true),
    all_work_items_verified: items.length > 0 && items.every(workOrderItemVerified),
    all_work_items_resolved: items.length > 0 && items.every(workOrderItemResolved),
    items
  };
}

function workOrderRequirementKey(item: any) {
  return String(item?.source?.verbatim || item?.normalized_requirement || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const SEMANTIC_SLICE_ITEM_CEILING = 128;

function semanticSliceRequirementItems(prompt: string) {
  const text = String(prompt || '').replace(/(?:^|\s)\$[A-Za-z0-9_-]+(?:\s|$)/g, ' ').trim();
  const repeatedScopes = repeatedNamedSliceParts(text);
  if (repeatedScopes) return repeatedScopes;
  const marker = /\bslices?\s*:\s*|(?:슬라이스|영역|항목)\s*:\s*/i.exec(text);
  if (!marker) return null;
  const context = text.slice(0, marker.index).replace(/\s+/g, ' ').trim();
  const body = text.slice(marker.index + marker[0].length).trim();
  if (!body) return null;

  const semicolonParts = body.split(/[;；]/).map((part) => part.trim()).filter(Boolean);
  let parts = semicolonParts.length > 1 ? semicolonParts : numberedSliceParts(body);
  let instructionTail = '';
  if (parts.length <= 1) {
    const sentenceSplit = sentenceSliceParts(body);
    parts = sentenceSplit.parts;
    instructionTail = sentenceSplit.tail;
  }
  if (parts.length <= 1) return null;

  const last = splitSliceInstructionTail(parts.at(-1) || '');
  parts[parts.length - 1] = last.topic;
  instructionTail ||= last.tail;
  const topics = parts.map(stripSliceMarker).filter(Boolean);
  if (topics.length <= 1) return null;
  const truncated = topics.length > SEMANTIC_SLICE_ITEM_CEILING;
  const kept = topics.slice(0, SEMANTIC_SLICE_ITEM_CEILING);
  return {
    items: kept.map((topic, index) => ({
      id: `REQ-${String(index + 1).padStart(3, '0')}`,
      text: topic,
      context,
      acceptance_context: instructionTail,
      required: true,
      confidence: 1
    })),
    truncated,
    truncated_count: truncated ? topics.length - SEMANTIC_SLICE_ITEM_CEILING : 0
  };
}

function repeatedNamedSliceParts(text: string) {
  const matches = [...text.matchAll(/(?:^|\s)(?:scope|slice|영역|범위)\s*(\d{1,3})\s*[:：]\s*/gi)];
  if (matches.length < 2) return null;
  const context = text.slice(0, Number(matches[0]?.index || 0)).replace(/\s+/g, ' ').trim();
  const rawParts = matches.map((match, index) => {
    const start = Number(match.index || 0) + match[0].length;
    const end = index + 1 < matches.length ? Number(matches[index + 1]?.index ?? text.length) : text.length;
    return text.slice(start, end).trim();
  });
  const last = splitSliceInstructionTail(rawParts.at(-1) || '');
  rawParts[rawParts.length - 1] = last.topic;
  const topics = rawParts.map(stripSliceMarker).filter(Boolean);
  const truncated = topics.length > SEMANTIC_SLICE_ITEM_CEILING;
  return {
    items: topics.slice(0, SEMANTIC_SLICE_ITEM_CEILING).map((topic, index) => ({
      id: `REQ-${String(index + 1).padStart(3, '0')}`,
      text: topic,
      context,
      acceptance_context: last.tail,
      required: true,
      confidence: 1
    })),
    truncated,
    truncated_count: truncated ? topics.length - SEMANTIC_SLICE_ITEM_CEILING : 0
  };
}

function numberedSliceParts(text: string) {
  const matches = [...text.matchAll(/(?:^|\s)(?:\d{1,3}[.)]|[①-⑳])\s+/g)];
  if (matches.length < 2) return [text];
  return matches.map((match, index) => {
    const start = Number(match.index || 0) + match[0].length;
    const end = index + 1 < matches.length ? Number(matches[index + 1]?.index ?? text.length) : text.length;
    return text.slice(start, end).trim();
  }).filter(Boolean);
}

function sentenceSliceParts(text: string) {
  const sentences = text.split(/(?<=[.!?。！？])\s+/).map((part) => part.trim()).filter(Boolean);
  if (sentences.length < 2) return { parts: [text], tail: '' };
  const instructionIndex = sentences.findIndex((sentence) => isSliceInstruction(sentence));
  return instructionIndex > 1
    ? { parts: sentences.slice(0, instructionIndex), tail: sentences.slice(instructionIndex).join(' ') }
    : { parts: [text], tail: '' };
}

function splitSliceInstructionTail(text: string) {
  const sentences = text.split(/(?<=[.!?。！？])\s+/).map((part) => part.trim()).filter(Boolean);
  const instructionIndex = sentences.findIndex((sentence, index) => index > 0 && isSliceInstruction(sentence));
  if (instructionIndex < 0) return { topic: text.trim(), tail: '' };
  return {
    topic: sentences.slice(0, instructionIndex).join(' ').trim(),
    tail: sentences.slice(instructionIndex).join(' ').trim()
  };
}

function isSliceInstruction(text: string) {
  return /^(?:inspect|review|check|verify|use|do\s+not|never|return|report|limit|only|검사|검토|확인|검증|사용|수정하지|실행하지|반환|보고|제한)/i.test(String(text || '').trim());
}

function stripSliceMarker(text: string) {
  return String(text || '')
    .replace(/^\s*(?:\d{1,3}[.)]|[①-⑳]|[-*])\s*/, '')
    .replace(/[.!?。！？]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Closes out every item in a mission's ledger to a terminal state once the
 * route's own gate has decided ok/not-ok, so evaluateStop's coverage gate
 * (which blocks stop while any item sits in 'pending') can never wait
 * forever: an item is either verified (route succeeded) or honestly
 * blocked (route failed, real blockers recorded), never left hanging.
 * This is coarser than true per-item tracking, but it closes the loop.
 */
export async function closeWorkOrderLedgerForRouteResult(
  dir: any,
  { ok, blockers = [], allowAttachmentBulkClose = false }: { ok: boolean; blockers?: string[]; allowAttachmentBulkClose?: boolean }
) {
  const ledger = await readWorkOrderLedger(dir);
  if (!ledger || !Array.isArray(ledger.items) || ledger.items.length === 0) return null;
  // Attachment-backed ledgers can represent a release work order with many
  // independently authorized and independently verified requirements. A
  // single route gate is not evidence that every attachment slice passed (or
  // that post-main/2FA work occurred), so preserve per-item truth by default.
  if (!allowAttachmentBulkClose && ledger.items.some((item: any) => item?.source?.type === 'attachment')) {
    return ledger;
  }
  const routeEvidence = ok ? await existingRouteEvidence(dir) : [];
  const verified = ok && routeEvidence.length > 0;
  let next = ledger;
  for (const item of ledger.items) {
    const patch = verified
      ? {
          status: 'verified',
          implementation_tasks: item.implementation_tasks?.length ? item.implementation_tasks : ['route_completion'],
          implementation_evidence: item.implementation_evidence?.length ? item.implementation_evidence : routeEvidence,
          verification_evidence: item.verification_evidence?.length ? item.verification_evidence : routeEvidence,
          blocker: {
            blocked: false,
            reason: null,
            needed_to_unblock: null
          }
        }
      : {
          status: 'blocked',
          blocker: {
            blocked: true,
            reason: blockers.join(', ') || (ok ? 'route_completion_evidence_missing' : 'route_completion_blocked'),
            needed_to_unblock: ok ? 'write the route gate/proof artifact and close the work order again' : 'resolve the route blockers and re-run'
          }
        };
    next = updateWorkOrderItem(next, item.id, patch);
  }
  await writeWorkOrderLedger(dir, next);
  return next;
}

function workOrderItemResolved(item: any) {
  if (item?.status === 'blocked') return item?.blocker?.blocked === true;
  return workOrderItemVerified(item);
}

function workOrderItemVerified(item: any) {
  return item?.status === 'verified'
    && Array.isArray(item?.implementation_evidence) && item.implementation_evidence.length > 0
    && Array.isArray(item?.verification_evidence) && item.verification_evidence.length > 0;
}

async function existingRouteEvidence(dir: string): Promise<string[]> {
  const candidates = [
    'completion-proof.json',
    'trust-report.json',
    'naruto-gate.json',
    'loop-graph-proof.json',
    'run-gate.json',
    'agents/agent-proof-evidence.json',
    'agents/agent-output-validation.json'
  ];
  const found: string[] = [];
  for (const candidate of candidates) {
    if (await exists(path.join(dir, candidate))) found.push(candidate);
  }
  return found;
}
