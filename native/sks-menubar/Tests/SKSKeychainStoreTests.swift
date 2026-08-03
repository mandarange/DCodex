#if canImport(XCTest)
import Foundation
import LocalAuthentication
import Security
import XCTest

private final class ArchitectureKeychainFake: SKSKeychainClient {
    var items: [String: Data] = [:]
    var copyStatusOverride: OSStatus?
    var updateStatus: OSStatus = errSecItemNotFound
    var addStatus: OSStatus = errSecSuccess
    var deleteStatus: OSStatus = errSecSuccess
    var copyQueries: [[String: Any]] = []
    var mutations = 0

    func copyMatching(_ query: [String: Any]) -> (status: OSStatus, value: Any?) {
        copyQueries.append(query)
        if let override = copyStatusOverride { return (override, nil) }
        let service = query[kSecAttrService as String] as? String ?? ""
        guard let value = items[service] else { return (errSecItemNotFound, nil) }
        return (errSecSuccess, value)
    }

    func add(_ attributes: [String: Any]) -> OSStatus {
        mutations += 1
        guard addStatus == errSecSuccess else { return addStatus }
        let service = attributes[kSecAttrService as String] as? String ?? ""
        items[service] = attributes[kSecValueData as String] as? Data
        return errSecSuccess
    }

    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        mutations += 1
        return updateStatus
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        mutations += 1
        guard deleteStatus == errSecSuccess else { return deleteStatus }
        let service = query[kSecAttrService as String] as? String ?? ""
        items.removeValue(forKey: service)
        return errSecSuccess
    }
}

final class SKSKeychainStoreTests: XCTestCase {
    func testEnvironmentNamespacesAndRestartReadsAreStableAndNonInteractive() {
        XCTAssertEqual(SKSKeychainCredential.codexLbApiKey.service(in: .production), "com.sneakoscope.codex-lb.api-key.v3")
        XCTAssertEqual(SKSKeychainCredential.codexLbApiKey.service(in: .development), "com.sneakoscope.codex-lb.api-key.v3.development")
        let fake = ArchitectureKeychainFake()
        let store = SKSKeychainStore(client: fake, environment: .development)
        for _ in 0..<5 { XCTAssertEqual(store.statusNonInteractive(.codexLbApiKey).readiness, .notFound) }
        XCTAssertEqual(fake.mutations, 0)
        for query in fake.copyQueries {
            let context = query[kSecUseAuthenticationContext as String] as? LAContext
            XCTAssertEqual(context?.interactionNotAllowed, true)
        }
    }

    func testLockedSigningDamagedAndDuplicateStatesRemainDistinct() {
        let fake = ArchitectureKeychainFake()
        let store = SKSKeychainStore(client: fake)
        fake.copyStatusOverride = errSecInteractionNotAllowed
        XCTAssertEqual(store.statusNonInteractive(.codexLbApiKey).readiness, .locked)
        fake.copyStatusOverride = errSecMissingEntitlement
        XCTAssertEqual(store.statusNonInteractive(.codexLbApiKey).readiness, .signingMismatch)
        fake.copyStatusOverride = errSecDecode
        XCTAssertEqual(store.statusNonInteractive(.codexLbApiKey).readiness, .damaged)
        fake.copyStatusOverride = errSecDuplicateItem
        XCTAssertEqual(store.statusNonInteractive(.codexLbApiKey).readiness, .duplicate)
    }

    func testLegacyMigrationRequiresReconnectAndRefusesAmbiguousDuplicates() {
        let fake = ArchitectureKeychainFake()
        fake.items["legacy.one"] = Data("first".utf8)
        fake.items["legacy.two"] = Data("second".utf8)
        let store = SKSKeychainStore(client: fake)
        let duplicate = store.migrateLegacyIfNeeded(
            .codexLbApiKey,
            legacyServices: ["legacy.one", "legacy.two"],
            explicitUserAction: true
        )
        XCTAssertEqual(duplicate.state.readiness, .duplicate)
        XCTAssertEqual(fake.mutations, 0)

        fake.items.removeValue(forKey: "legacy.two")
        let blocked = store.migrateLegacyIfNeeded(
            .codexLbApiKey,
            legacyServices: ["legacy.one"],
            explicitUserAction: false
        )
        XCTAssertFalse(blocked.migrated)
        XCTAssertEqual(fake.mutations, 0)
    }
}
#endif
