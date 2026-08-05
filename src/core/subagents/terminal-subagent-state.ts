import { uniqueStrings } from '../text/strings.js'

export function officialSubagentEvidenceReady(evidence: any = {}): boolean {
  if (evidence?.ok === true) return true
  const target = Number(evidence?.target_subagents || 0)
  const blockers = uniqueStrings(Array.isArray(evidence?.blockers) ? evidence.blockers : [])
  return evidence?.status === 'blocked'
    && evidence?.parent_summary_status === 'blocked'
    && evidence?.parent_summary_present === true
    && evidence?.parent_summary_trustworthy === true
    && target > 0
    && Number(evidence?.started_threads || 0) === target
    && Number(evidence?.completed_threads || 0) === target
    && Number(evidence?.failed_threads || 0) === 0
    && arrayEmpty(evidence?.open_thread_ids)
    && arrayEmpty(evidence?.unmatched_stop_thread_ids)
    && arrayEmpty(evidence?.ambiguous_stop_thread_ids)
    && blockers.length === 1
    && blockers[0] === 'parent_summary_blocked'
}

export function terminalBlockedNarutoGate(gate: any = {}): boolean {
  const blockers = uniqueStrings(Array.isArray(gate?.blockers) ? gate.blockers : [])
  const missingFields = uniqueStrings(Array.isArray(gate?.missing_fields) ? gate.missing_fields : [])
  return gate?.status === 'blocked'
    && gate?.passed !== true
    && gate?.terminal === true
    && gate?.terminal_state === 'blocked'
    && gate?.official_subagent_evidence === true
    && gate?.subagent_evidence_ready === true
    && gate?.parent_summary_present === true
    && gate?.session_cleanup === true
    && gate?.ssot_guard === true
    && blockers.length === 1
    && blockers[0] === 'parent_summary_blocked'
    && missingFields.every((field) => field === 'parent_summary_blocked')
}

function arrayEmpty(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0
}
