import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

function run(command: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    child.on('error', (error) => resolve({ code: 1, output: error.message }))
    child.on('close', (code) => resolve({ code: code ?? 1, output }))
  })
}

test('Keychain policy keeps restart and background reads non-interactive and reconnect explicit', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Security.framework verification is macOS-only')
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-keychain-policy-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const source = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources', 'SKSKeychainStore.swift')
  const main = path.join(temp, 'main.swift')
  const executable = path.join(temp, 'keychain-policy')
  await fs.writeFile(main, String.raw`
import Foundation
import LocalAuthentication
import Security

final class FakeKeychainClient: SKSKeychainClient {
    var copyStatus: OSStatus = errSecItemNotFound
    var copyValue: Any?
    var updateStatus: OSStatus = errSecItemNotFound
    var addStatus: OSStatus = errSecSuccess
    var deleteStatus: OSStatus = errSecSuccess
    var copyQueries: [[String: Any]] = []
    var addAttributes: [[String: Any]] = []
    var updateQueries: [[String: Any]] = []
    var deleteQueries: [[String: Any]] = []

    func copyMatching(_ query: [String: Any]) -> (status: OSStatus, value: Any?) {
        copyQueries.append(query)
        return (copyStatus, copyValue)
    }
    func add(_ attributes: [String: Any]) -> OSStatus {
        addAttributes.append(attributes)
        return addStatus
    }
    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        updateQueries.append(query)
        return updateStatus
    }
    func delete(_ query: [String: Any]) -> OSStatus {
        deleteQueries.append(query)
        return deleteStatus
    }
}

let fake = FakeKeychainClient()
let store = SKSKeychainStore(client: fake)
precondition(SKSKeychainCredential.codexLbApiKey.service == "com.sneakoscope.codex-lb.api-key.v3")
precondition(SKSKeychainCredential.codexLbApiKey.account == "api-key")
precondition(SKSKeychainCredential.openRouterApiKey.service == "com.sneakoscope.openrouter.api-key.v1")
precondition(SKSKeychainCredential.openRouterApiKey.account == "api-key")
precondition(SKSKeychainCredential.codexLbApiKey.accessScopeMarker == "com.sneakoscope.sks-menubar.credentials.v1")

// Simulate multiple ordinary app/menu restarts. Reads may report that explicit
// reconnection is required, but they must never add, update, delete, or allow UI.
for _ in 0..<6 {
    let state = store.statusNonInteractive(.codexLbApiKey)
    guard case .authenticationRequired = state else { preconditionFailure("missing item must require reconnect") }
}
precondition(fake.copyQueries.count == 6)
precondition(fake.addAttributes.isEmpty)
precondition(fake.updateQueries.isEmpty)
precondition(fake.deleteQueries.isEmpty)
for query in fake.copyQueries {
    let context = query[kSecUseAuthenticationContext as String] as? LAContext
    precondition(context?.interactionNotAllowed == true)
    precondition(query[kSecUseAuthenticationUI as String] == nil)
    precondition(query[kSecAttrService as String] as? String == "com.sneakoscope.codex-lb.api-key.v3")
    precondition(query[kSecAttrAccount as String] as? String == "api-key")
}

let blockedWrite = store.store("secret-never-logged", credential: .codexLbApiKey, explicitUserAction: false)
precondition(!blockedWrite.stored)
precondition(fake.addAttributes.isEmpty)
precondition(fake.updateQueries.isEmpty)

let explicitWrite = store.store("secret-never-logged", credential: .codexLbApiKey, explicitUserAction: true)
precondition(explicitWrite.stored)
precondition(fake.updateQueries.count == 1)
precondition(fake.addAttributes.count == 1)
precondition(fake.addAttributes[0][kSecAttrService as String] as? String == "com.sneakoscope.codex-lb.api-key.v3")
precondition(fake.addAttributes[0][kSecAttrAccount as String] as? String == "api-key")
precondition(fake.addAttributes[0][kSecAttrGeneric as String] as? Data == Data("com.sneakoscope.sks-menubar.credentials.v1".utf8))

fake.copyStatus = errSecSuccess
fake.copyValue = Data("available-secret".utf8)
let available = store.readNonInteractive(.codexLbApiKey)
precondition(available.state == .available)
precondition(available.secret == Data("available-secret".utf8))

fake.copyStatus = errSecInteractionNotAllowed
guard case .authenticationRequired(let lockedReason) = store.statusNonInteractive(.openRouterApiKey) else {
    preconditionFailure("locked Keychain must require reconnect without UI")
}
precondition(lockedReason.contains("locked") || lockedReason.contains("explicit"))

fake.copyStatus = errSecMissingEntitlement
guard case .authenticationRequired(let signingReason) = store.statusNonInteractive(.openRouterApiKey) else {
    preconditionFailure("signing/access-group drift must be distinguished")
}
precondition(signingReason.contains("signing") || signingReason.contains("access group"))
`)

  const compiled = await run('swiftc', [
    '-framework', 'LocalAuthentication',
    '-framework', 'Security',
    source,
    main,
    '-o', executable
  ])
  assert.equal(compiled.code, 0, compiled.output)
  const executed = await run(executable, [])
  assert.equal(executed.code, 0, executed.output)
})

test('SKS Center recovery contract has no automatic authentication UI path', async () => {
  const sourceRoot = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources')
  const [store, providersController, providersReliability, openRouter] = await Promise.all([
    fs.readFile(path.join(sourceRoot, 'SKSKeychainStore.swift'), 'utf8'),
    fs.readFile(path.join(sourceRoot, 'ProvidersViewController.swift'), 'utf8'),
    fs.readFile(path.join(sourceRoot, 'ProvidersReliability.swift'), 'utf8'),
    fs.readFile(path.join(sourceRoot, 'ProvidersOpenRouter.swift'), 'utf8')
  ])
  const providers = `${providersController}\n${providersReliability}`
  assert.match(store, /authenticationContext\.interactionNotAllowed = true/)
  assert.match(store, /guard explicitUserAction else/)
  assert.doesNotMatch(store, /kSecUseAuthenticationUIFail/)
  assert.match(providers, /refreshCredentialHealth\(\)/)
  assert.match(providers, /no authentication UI was opened automatically/)
  assert.match(providers, /Reconnect Codex LB credential…/)
  assert.match(providers, /Reconnect OpenRouter credential…/)
  assert.match(providers, /Open Codex sign-in…/)
  assert.doesNotMatch(providers, /"--keychain"/)
  assert.match(openRouter, /catalog\["schema"\] as\? String == "sks\.catalog-sync-state\.v2"/)
  assert.match(openRouter, /ProviderSecretRedactor\.redactEndpoint/)
  assert.doesNotMatch(openRouter, /clearOpenRouterModels|model and child-agent lists were withdrawn/)
})
