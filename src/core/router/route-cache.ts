import { sha256 } from '../fsx.js'
import type { CodexTaskInput } from '../codex-control/codex-control-plane.js'

const cache = new Map<string, unknown>()

export function codexRouteCacheKey(input: CodexTaskInput) {
  return sha256(JSON.stringify({
    route: input.route,
    tier: input.tier || null,
    prompt: String(input.prompt || '').slice(0, 4000),
    files: input.inputFiles || [],
    images: (input.inputImages || []).length,
    sandbox: input.sandboxPolicy,
    backend_preference: input.backendPreference || [],
    write_paths: input.requestedScopeContract?.write_paths || [],
    allowed_paths: input.requestedScopeContract?.allowed_paths || []
  }))
}

export function readRouteCache<T>(key: string): T | null {
  return cache.has(key) ? cache.get(key) as T : null
}

export function writeRouteCache<T>(key: string, value: T) {
  cache.set(key, value)
  return value
}

export function clearRouteCache() {
  cache.clear()
}
