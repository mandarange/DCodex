import Foundation
import LocalAuthentication
import Security

enum SKSKeychainEnvironment: String {
    case production
    case development

    var serviceSuffix: String {
        switch self {
        case .production: return ""
        case .development: return ".development"
        }
    }
}

/// Credentials owned by SKS Center. The official ChatGPT OAuth refresh token is
/// intentionally not copied: Codex remains its native owner and SKS only reports
/// the auth state returned by Codex.
enum SKSKeychainCredential: String, CaseIterable {
    case codexLbApiKey
    case openRouterApiKey

    var service: String {
        service(in: .production)
    }

    func service(in environment: SKSKeychainEnvironment) -> String {
        let base: String
        switch self {
        case .codexLbApiKey: base = "com.sneakoscope.codex-lb.api-key.v3"
        case .openRouterApiKey: base = "com.sneakoscope.openrouter.api-key.v1"
        }
        return base + environment.serviceSuffix
    }

    /// Accounts never depend on the login name, machine name, install path, or
    /// process id. This prevents a reinstall on another Mac from silently looking
    /// under a different identity.
    var account: String { "api-key" }

    /// A stable logical access-scope marker stored with the item. The actual
    /// Keychain access group remains the app's signing-default group because an
    /// explicit shared group is invalid without a provisioned entitlement.
    var accessScopeMarker: String { "com.sneakoscope.sks-menubar.credentials.v1" }
}

enum SKSKeychainCredentialState: Equatable {
    case available
    case authenticationRequired(reason: String)
    case unavailable(reason: String)
}

enum SKSKeychainReadiness: String, Equatable {
    case ready
    case notFound = "not_found"
    case locked
    case accessDenied = "access_denied"
    case signingMismatch = "signing_mismatch"
    case damaged
    case duplicate
    case unavailable
}

extension SKSKeychainCredentialState {
    var readiness: SKSKeychainReadiness {
        switch self {
        case .available:
            return .ready
        case .authenticationRequired(let reason):
            if reason.contains("deleted") || reason.contains("not been registered") { return .notFound }
            if reason.contains("locked") { return .locked }
            if reason.contains("signing") || reason.contains("access group") { return .signingMismatch }
            if reason.contains("damaged") { return .damaged }
            if reason.contains("duplicate") { return .duplicate }
            return .accessDenied
        case .unavailable:
            return .unavailable
        }
    }
}

struct SKSKeychainReadResult {
    let state: SKSKeychainCredentialState
    let secret: Data?
}

struct SKSKeychainWriteResult {
    let state: SKSKeychainCredentialState
    let stored: Bool
}

struct SKSKeychainMigrationResult {
    let state: SKSKeychainCredentialState
    let migrated: Bool
    let legacyItemsFound: Int
}

/// Small injectable boundary so tests can prove that restarts and background
/// refreshes use non-interactive reads without touching the user's Keychain.
protocol SKSKeychainClient {
    func copyMatching(_ query: [String: Any]) -> (status: OSStatus, value: Any?)
    func add(_ attributes: [String: Any]) -> OSStatus
    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus
    func delete(_ query: [String: Any]) -> OSStatus
}

final class SKSSecurityKeychainClient: SKSKeychainClient {
    func copyMatching(_ query: [String: Any]) -> (status: OSStatus, value: Any?) {
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        return (status, result)
    }

    func add(_ attributes: [String: Any]) -> OSStatus {
        SecItemAdd(attributes as CFDictionary, nil)
    }

    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        SecItemDelete(query as CFDictionary)
    }
}

final class SKSKeychainStore {
    private let client: SKSKeychainClient
    private let environment: SKSKeychainEnvironment

    init(
        client: SKSKeychainClient = SKSSecurityKeychainClient(),
        environment: SKSKeychainEnvironment = .production
    ) {
        self.client = client
        self.environment = environment
    }

    /// Background state checks and normal runtime reads always fail closed when
    /// Keychain would need UI. They never display an authentication dialog.
    func readNonInteractive(_ credential: SKSKeychainCredential) -> SKSKeychainReadResult {
        let result = client.copyMatching(readQuery(for: credential))
        guard result.status == errSecSuccess else {
            return SKSKeychainReadResult(state: state(for: result.status), secret: nil)
        }
        guard let data = result.value as? Data, !data.isEmpty else {
            return SKSKeychainReadResult(
                state: .authenticationRequired(reason: "credential data is damaged"),
                secret: nil
            )
        }
        return SKSKeychainReadResult(state: .available, secret: data)
    }

    func statusNonInteractive(_ credential: SKSKeychainCredential) -> SKSKeychainCredentialState {
        readNonInteractive(credential).state
    }

    /// Writing is permitted only after an explicit Center action. Callers cannot
    /// accidentally turn startup, restart, network recovery, or catalog refresh
    /// into an authentication prompt.
    func store(
        _ secret: String,
        credential: SKSKeychainCredential,
        explicitUserAction: Bool
    ) -> SKSKeychainWriteResult {
        guard explicitUserAction else {
            return SKSKeychainWriteResult(
                state: .authenticationRequired(reason: "explicit reconnect action required"),
                stored: false
            )
        }
        let trimmed = secret.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else {
            return SKSKeychainWriteResult(
                state: .authenticationRequired(reason: "credential is empty"),
                stored: false
            )
        }

        let query = identityQuery(for: credential)
        let updateStatus = client.update(query, attributes: [
            kSecValueData as String: data,
            kSecAttrGeneric as String: Data(credential.accessScopeMarker.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ])
        if updateStatus == errSecSuccess {
            return SKSKeychainWriteResult(state: .available, stored: true)
        }
        guard updateStatus == errSecItemNotFound else {
            return SKSKeychainWriteResult(state: state(for: updateStatus), stored: false)
        }

        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrGeneric as String] = Data(credential.accessScopeMarker.utf8)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = client.add(attributes)
        return SKSKeychainWriteResult(
            state: addStatus == errSecSuccess ? .available : state(for: addStatus),
            stored: addStatus == errSecSuccess
        )
    }

    /// Deletion is also explicit-only. Missing items are idempotently considered
    /// removed; no user interface is invoked.
    func delete(
        _ credential: SKSKeychainCredential,
        explicitUserAction: Bool
    ) -> SKSKeychainWriteResult {
        guard explicitUserAction else {
            return SKSKeychainWriteResult(
                state: .authenticationRequired(reason: "explicit disconnect action required"),
                stored: false
            )
        }
        let status = client.delete(identityQuery(for: credential))
        if status == errSecSuccess || status == errSecItemNotFound {
            return SKSKeychainWriteResult(
                state: .authenticationRequired(reason: "credential not stored"),
                stored: false
            )
        }
        return SKSKeychainWriteResult(state: state(for: status), stored: false)
    }

    /// Legacy items are inspected without interaction. Moving or deleting one is
    /// permitted only from the explicit reconnect action. Ambiguous duplicates
    /// are never guessed or removed.
    func migrateLegacyIfNeeded(
        _ credential: SKSKeychainCredential,
        legacyServices: [String],
        explicitUserAction: Bool
    ) -> SKSKeychainMigrationResult {
        let uniqueServices = Array(Set(legacyServices.map {
            $0.trimmingCharacters(in: .whitespacesAndNewlines)
        }.filter { !$0.isEmpty && $0 != credential.service(in: environment) })).sorted()
        var candidates: [(service: String, data: Data)] = []
        for service in uniqueServices {
            let result = client.copyMatching(readQuery(service: service, account: credential.account))
            if result.status == errSecItemNotFound { continue }
            guard result.status == errSecSuccess, let data = result.value as? Data, !data.isEmpty else {
                return SKSKeychainMigrationResult(
                    state: state(for: result.status == errSecSuccess ? errSecDecode : result.status),
                    migrated: false,
                    legacyItemsFound: candidates.count
                )
            }
            candidates.append((service, data))
        }
        if candidates.count > 1 {
            return SKSKeychainMigrationResult(
                state: .authenticationRequired(reason: "duplicate legacy credentials require explicit conflict resolution"),
                migrated: false,
                legacyItemsFound: candidates.count
            )
        }
        guard let candidate = candidates.first else {
            return SKSKeychainMigrationResult(
                state: .authenticationRequired(reason: "credential was deleted or has not been registered"),
                migrated: false,
                legacyItemsFound: 0
            )
        }
        guard explicitUserAction else {
            return SKSKeychainMigrationResult(
                state: .authenticationRequired(reason: "explicit reconnect action required for legacy migration"),
                migrated: false,
                legacyItemsFound: 1
            )
        }
        guard let secret = String(data: candidate.data, encoding: .utf8) else {
            return SKSKeychainMigrationResult(
                state: .authenticationRequired(reason: "credential data is damaged"),
                migrated: false,
                legacyItemsFound: 1
            )
        }
        let stored = store(secret, credential: credential, explicitUserAction: true)
        guard stored.stored else {
            return SKSKeychainMigrationResult(state: stored.state, migrated: false, legacyItemsFound: 1)
        }
        let deleted = client.delete(identityQuery(service: candidate.service, account: credential.account))
        guard deleted == errSecSuccess || deleted == errSecItemNotFound else {
            return SKSKeychainMigrationResult(state: state(for: deleted), migrated: false, legacyItemsFound: 1)
        }
        return SKSKeychainMigrationResult(state: .available, migrated: true, legacyItemsFound: 1)
    }

    private func identityQuery(for credential: SKSKeychainCredential) -> [String: Any] {
        identityQuery(service: credential.service(in: environment), account: credential.account)
    }

    private func identityQuery(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false
        ]
    }

    private func readQuery(for credential: SKSKeychainCredential) -> [String: Any] {
        var query = identityQuery(for: credential)
        let authenticationContext = LAContext()
        authenticationContext.interactionNotAllowed = true
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecUseAuthenticationContext as String] = authenticationContext
        return query
    }

    private func readQuery(service: String, account: String) -> [String: Any] {
        var query = identityQuery(service: service, account: account)
        let authenticationContext = LAContext()
        authenticationContext.interactionNotAllowed = true
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecUseAuthenticationContext as String] = authenticationContext
        return query
    }

    private func state(for status: OSStatus) -> SKSKeychainCredentialState {
        switch status {
        case errSecItemNotFound:
            return .authenticationRequired(reason: "credential was deleted or has not been registered")
        case errSecInteractionNotAllowed:
            return .authenticationRequired(reason: "Keychain is locked or access requires explicit reconnection")
        case errSecAuthFailed:
            return .authenticationRequired(reason: "Keychain access control rejected this app identity")
        case errSecMissingEntitlement:
            return .authenticationRequired(reason: "app signing or Keychain access group does not match")
        case errSecDecode:
            return .authenticationRequired(reason: "credential data is damaged")
        case errSecDuplicateItem:
            return .authenticationRequired(reason: "duplicate credentials require explicit conflict resolution")
        case errSecNotAvailable:
            return .unavailable(reason: "Keychain service is unavailable")
        default:
            return .unavailable(reason: "Keychain error \(status)")
        }
    }
}
