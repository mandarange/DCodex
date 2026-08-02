#if SKS_STANDALONE_TESTS
import Foundation

@main
enum SingletonInstanceGuardStandaloneTests {
    static func main() {
        expect(
            .keepCandidate(terminate: [100, 200]),
            candidate: .init(processIdentifier: 300, packageVersion: "8.0.3", buildVersion: "803"),
            running: [
                .init(processIdentifier: 100, packageVersion: "7.5.0", buildVersion: "750"),
                .init(processIdentifier: 200, packageVersion: "8.0.2", buildVersion: "802")
            ]
        )
        expect(
            .exitCandidate(winner: 100, terminate: []),
            candidate: .init(
                processIdentifier: 50,
                packageVersion: "8.0.3",
                buildVersion: "803",
                startedAt: Date(timeIntervalSince1970: 20)
            ),
            running: [.init(
                processIdentifier: 100,
                packageVersion: "8.0.3",
                buildVersion: "803",
                startedAt: Date(timeIntervalSince1970: 10)
            )]
        )
        expect(
            .exitCandidate(winner: 100, terminate: [200]),
            candidate: .init(processIdentifier: 300, packageVersion: "8.0.2", buildVersion: "802"),
            running: [
                .init(processIdentifier: 100, packageVersion: "8.0.3", buildVersion: "803"),
                .init(processIdentifier: 200, packageVersion: "8.0.1", buildVersion: "801")
            ]
        )
        expect(
            .keepCandidate(terminate: [200]),
            candidate: .init(processIdentifier: 100, packageVersion: "8.0.3", buildVersion: "803"),
            running: [.init(processIdentifier: 200, packageVersion: "8.0.3", buildVersion: "803")]
        )
        expect(
            .exitCandidate(winner: 200, terminate: []),
            candidate: .init(
                processIdentifier: 100,
                packageVersion: "8.0.3",
                buildVersion: "803",
                startedAt: Date(timeIntervalSince1970: 20)
            ),
            running: [.init(processIdentifier: 200, packageVersion: "8.0.3", buildVersion: "803")]
        )
        let legacy = SingletonInstanceGuard.identity(
            processIdentifier: 400,
            runtimeState: nil,
            expectedBundleIdentifier: "com.sneakoscope.menubar"
        )
        precondition(legacy.packageVersion == nil && legacy.buildVersion == nil && legacy.startedAt == nil)
        expect(
            .keepCandidate(terminate: [400]),
            candidate: .init(processIdentifier: 500, packageVersion: "8.0.3", buildVersion: "803"),
            running: [legacy]
        )
        precondition(SingletonInstanceGuard.compareVersions("8.0.3-beta.2", "8.0.3") == .orderedAscending)
        precondition(SingletonInstanceGuard.compareVersions("8.0.10", "8.0.3") == .orderedDescending)
        print("SingletonInstanceGuardTests: 7 passed")
    }

    private static func expect(
        _ expected: MenuBarInstanceArbitration,
        candidate: MenuBarInstanceIdentity,
        running: [MenuBarInstanceIdentity]
    ) {
        precondition(SingletonInstanceGuard.arbitrate(candidate: candidate, running: running) == expected)
    }
}
#elseif canImport(XCTest)
import XCTest

final class SingletonInstanceGuardTests: XCTestCase {
    func testNewerCandidateTerminatesEveryOlderInstance() {
        let candidate = MenuBarInstanceIdentity(processIdentifier: 300, packageVersion: "8.0.3", buildVersion: "803")
        let running = [
            MenuBarInstanceIdentity(processIdentifier: 100, packageVersion: "7.5.0", buildVersion: "750"),
            MenuBarInstanceIdentity(processIdentifier: 200, packageVersion: "8.0.2", buildVersion: "802")
        ]
        XCTAssertEqual(
            SingletonInstanceGuard.arbitrate(candidate: candidate, running: running),
            .keepCandidate(terminate: [100, 200])
        )
    }

    func testLaterSameVersionCandidateExits() {
        let candidate = MenuBarInstanceIdentity(
            processIdentifier: 50,
            packageVersion: "8.0.3",
            buildVersion: "803",
            startedAt: Date(timeIntervalSince1970: 20)
        )
        let running = [MenuBarInstanceIdentity(
            processIdentifier: 100,
            packageVersion: "8.0.3",
            buildVersion: "803",
            startedAt: Date(timeIntervalSince1970: 10)
        )]
        XCTAssertEqual(
            SingletonInstanceGuard.arbitrate(candidate: candidate, running: running),
            .exitCandidate(winner: 100, terminate: [])
        )
    }

    func testLosingCandidateStillCollapsesOlderExtraInstances() {
        let candidate = MenuBarInstanceIdentity(processIdentifier: 300, packageVersion: "8.0.2", buildVersion: "802")
        let running = [
            MenuBarInstanceIdentity(processIdentifier: 100, packageVersion: "8.0.3", buildVersion: "803"),
            MenuBarInstanceIdentity(processIdentifier: 200, packageVersion: "8.0.1", buildVersion: "801")
        ]
        XCTAssertEqual(
            SingletonInstanceGuard.arbitrate(candidate: candidate, running: running),
            .exitCandidate(winner: 100, terminate: [200])
        )
    }

    func testSimultaneousSameBuildUsesPidAsDeterministicTieBreak() {
        let candidate = MenuBarInstanceIdentity(processIdentifier: 100, packageVersion: "8.0.3", buildVersion: "803")
        let running = [MenuBarInstanceIdentity(processIdentifier: 200, packageVersion: "8.0.3", buildVersion: "803")]
        XCTAssertEqual(
            SingletonInstanceGuard.arbitrate(candidate: candidate, running: running),
            .keepCandidate(terminate: [200])
        )
    }

    func testSameVersionIncumbentWithoutStartTimeIsKept() {
        let candidate = MenuBarInstanceIdentity(
            processIdentifier: 100,
            packageVersion: "8.0.3",
            buildVersion: "803",
            startedAt: Date(timeIntervalSince1970: 20)
        )
        let incumbent = SingletonInstanceGuard.identity(
            processIdentifier: 200,
            runtimeState: MenuBarRuntimeState(
                schema: "sks.menubar-runtime-state.v1",
                pid: 200,
                package_version: "8.0.3",
                build_version: "803",
                bundle_identifier: "com.sneakoscope.menubar",
                executable_path: "/tmp/SKS Menu Bar",
                started_at: nil
            ),
            expectedBundleIdentifier: "com.sneakoscope.menubar"
        )
        XCTAssertEqual(
            SingletonInstanceGuard.arbitrate(candidate: candidate, running: [incumbent]),
            .exitCandidate(winner: 200, terminate: [])
        )
    }

    func testMissingRuntimeStateIsUnversionedAndLosesToVersionedCandidate() {
        let legacy = SingletonInstanceGuard.identity(
            processIdentifier: 400,
            runtimeState: nil,
            expectedBundleIdentifier: "com.sneakoscope.menubar"
        )
        XCTAssertNil(legacy.packageVersion)
        XCTAssertNil(legacy.buildVersion)
        XCTAssertNil(legacy.startedAt)
        XCTAssertEqual(
            SingletonInstanceGuard.arbitrate(
                candidate: .init(processIdentifier: 500, packageVersion: "8.0.3", buildVersion: "803"),
                running: [legacy]
            ),
            .keepCandidate(terminate: [400])
        )
    }

    func testPrereleaseSortsBeforeRelease() {
        XCTAssertEqual(SingletonInstanceGuard.compareVersions("8.0.3-beta.2", "8.0.3"), .orderedAscending)
        XCTAssertEqual(SingletonInstanceGuard.compareVersions("8.0.10", "8.0.3"), .orderedDescending)
    }
}

#endif
