export const RELEASE_PACK_RECEIPT_SCHEMA = 'sks.release-pack-receipt.v2'
export const RELEASE_PACK_COMPARE_SCHEMA = 'sks.release-pack-compare.v1'

export type ReleasePackKind = 'local' | 'staged'

export interface ReleasePackReceipt {
  schema: typeof RELEASE_PACK_RECEIPT_SCHEMA
  ok: boolean
  kind: ReleasePackKind
  package_name: string
  package_version: string
  source_commit: string | null
  source_tree_sha256: string | null
  source_package_sha256: string | null
  source_package_binding_sha256: string | null
  tarball_name: string
  tarball_path: string
  bytes: number
  unpacked_bytes: number
  sha256: string
  sha512_integrity: string
  file_count: number
  file_list_sha256: string
  secret_scan: {
    ok: boolean
    scanned_files: number
    scanned_bytes: number
    findings: Array<{
      file: string
      kind: string
      fingerprint: string
    }>
    blockers: string[]
  }
  retired_surface_scan: {
    ok: boolean
    scanned_files: number
    scanned_bytes: number
    allowlisted_finding_count: number
    findings: Array<{
      file: string
      kind: string
      fingerprint: string
    }>
    blockers: string[]
  }
  budget: {
    ok: boolean
    max_packed_bytes: number
    max_unpacked_bytes: number
    max_file_count: number
    blockers: string[]
  }
  npm_pack_proof: {
    proof_id: string
    info_sha256: string
    file_list_sha256: string
  } | null
  generated_at: string
  blockers: string[]
}

export interface ReleasePackCompare {
  schema: typeof RELEASE_PACK_COMPARE_SCHEMA
  ok: boolean
  package_name: string | null
  package_version: string | null
  local_sha256: string | null
  staged_sha256: string | null
  blockers: string[]
  compared_at: string
}
