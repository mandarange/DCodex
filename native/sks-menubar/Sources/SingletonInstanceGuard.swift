import Cocoa
import Darwin

struct MenuBarInstanceIdentity: Equatable {
    let processIdentifier: pid_t
    let packageVersion: String?
    let buildVersion: String?
    let startedAt: Date?

    init(
        processIdentifier: pid_t,
        packageVersion: String?,
        buildVersion: String?,
        startedAt: Date? = nil
    ) {
        self.processIdentifier = processIdentifier
        self.packageVersion = packageVersion
        self.buildVersion = buildVersion
        self.startedAt = startedAt
    }
}

enum MenuBarInstanceArbitration: Equatable {
    case keepCandidate(terminate: [pid_t])
    case exitCandidate(winner: pid_t, terminate: [pid_t])
}

enum MenuBarInstanceAcquisition: Equatable {
    case acquired
    case lostArbitration(winner: pid_t)
    case degraded
}

struct MenuBarRuntimeState: Codable, Equatable {
    let schema: String
    let pid: Int32
    let package_version: String
    let build_version: String
    let bundle_identifier: String
    let executable_path: String
    let started_at: String?
}

final class SingletonInstanceGuard {
    private let bundleIdentifier: String
    private let packageVersion: String
    private let buildVersion: String
    private let stateURL: URL
    private let lockURL: URL
    private let currentPID: pid_t
    private let startedAt: Date

    init(
        bundleIdentifier: String,
        packageVersion: String,
        buildVersion: String,
        buildStampPath: String,
        currentPID: pid_t = getpid(),
        startedAt: Date = Date()
    ) {
        self.bundleIdentifier = bundleIdentifier
        self.packageVersion = packageVersion
        self.buildVersion = buildVersion
        self.currentPID = currentPID
        self.startedAt = startedAt
        let installDirectory = URL(fileURLWithPath: buildStampPath).deletingLastPathComponent()
        self.stateURL = installDirectory.appendingPathComponent("runtime-state.json")
        self.lockURL = installDirectory.appendingPathComponent("singleton.lock")
    }

    /// Only `.lostArbitration` requires the caller to exit before constructing app UI.
    /// Degraded acquisition preserves availability after a bounded warning path.
    /// A short-lived filesystem lock serializes simultaneous launchd/manual/Doctor starts.
    func acquire() -> MenuBarInstanceAcquisition {
        // The holder may spend up to five seconds in terminate-and-readback.
        // Wait beyond that bounded critical section before degrading so a
        // normal contender is still arbitrated after the holder releases.
        guard let lockDescriptor = acquireLock(timeout: 6.0) else {
            fputs("SKS Menu Bar singleton: lock unavailable; continuing in degraded mode.\n", stderr)
            return .degraded
        }
        defer {
            flock(lockDescriptor, LOCK_UN)
            close(lockDescriptor)
        }

        let candidate = MenuBarInstanceIdentity(
            processIdentifier: currentPID,
            packageVersion: packageVersion,
            buildVersion: buildVersion,
            startedAt: startedAt
        )
        let applications = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
            .filter { $0.processIdentifier != currentPID && !$0.isTerminated }
        let recordedState = runtimeState()
        let identities = applications.map { application in
            Self.identity(
                processIdentifier: application.processIdentifier,
                runtimeState: recordedState,
                expectedBundleIdentifier: bundleIdentifier
            )
        }
        switch Self.arbitrate(candidate: candidate, running: identities) {
        case let .exitCandidate(winner, processes):
            let targets = applications.filter { processes.contains($0.processIdentifier) }
            if !terminateAndReadBack(targets) {
                fputs("SKS Menu Bar singleton: a losing instance did not terminate within the bounded wait.\n", stderr)
            }
            fputs("SKS Menu Bar singleton: process \(winner) already owns the newer or equal instance.\n", stderr)
            return .lostArbitration(winner: winner)
        case let .keepCandidate(processes):
            let targets = applications.filter { processes.contains($0.processIdentifier) }
            var degraded = false
            if !terminateAndReadBack(targets) {
                fputs("SKS Menu Bar singleton: an older instance did not terminate within the bounded wait.\n", stderr)
                degraded = true
            }
            if !writeRuntimeState() { degraded = true }
            return degraded ? .degraded : .acquired
        }
    }

    func releaseRuntimeStateIfOwned() {
        guard let data = try? Data(contentsOf: stateURL),
              let state = try? JSONDecoder().decode(MenuBarRuntimeState.self, from: data),
              state.pid == currentPID else { return }
        try? FileManager.default.removeItem(at: stateURL)
    }

    static func arbitrate(
        candidate: MenuBarInstanceIdentity,
        running: [MenuBarInstanceIdentity]
    ) -> MenuBarInstanceArbitration {
        let unique = Dictionary(grouping: running, by: \.processIdentifier)
            .compactMap { $0.value.first }
        guard let incumbent = preferredIncumbent(from: unique) else {
            return .keepCandidate(terminate: [])
        }
        guard candidateOutranksIncumbent(candidate, incumbent) else {
            return .exitCandidate(
                winner: incumbent.processIdentifier,
                terminate: unique
                    .filter { $0.processIdentifier != incumbent.processIdentifier }
                    .map(\.processIdentifier)
                    .sorted()
            )
        }
        return .keepCandidate(terminate: unique.map(\.processIdentifier).sorted())
    }

    static func compareVersions(_ lhs: String, _ rhs: String) -> ComparisonResult {
        let left = parsedVersion(lhs)
        let right = parsedVersion(rhs)
        let width = max(left.core.count, right.core.count)
        for index in 0..<width {
            let a = index < left.core.count ? left.core[index] : 0
            let b = index < right.core.count ? right.core[index] : 0
            if a != b { return a < b ? .orderedAscending : .orderedDescending }
        }
        if left.prerelease.isEmpty != right.prerelease.isEmpty {
            return left.prerelease.isEmpty ? .orderedDescending : .orderedAscending
        }
        for index in 0..<max(left.prerelease.count, right.prerelease.count) {
            if index >= left.prerelease.count { return .orderedAscending }
            if index >= right.prerelease.count { return .orderedDescending }
            let a = left.prerelease[index]
            let b = right.prerelease[index]
            if a == b { continue }
            if let an = Int(a), let bn = Int(b) {
                return an < bn ? .orderedAscending : .orderedDescending
            }
            if Int(a) != nil { return .orderedAscending }
            if Int(b) != nil { return .orderedDescending }
            return a.localizedStandardCompare(b)
        }
        return .orderedSame
    }

    private static func candidateOutranksIncumbent(
        _ candidate: MenuBarInstanceIdentity,
        _ incumbent: MenuBarInstanceIdentity
    ) -> Bool {
        let versionOrder = compareIdentityVersions(candidate, incumbent)
        if versionOrder != .orderedSame { return versionOrder == .orderedDescending }
        // An incumbent without a recorded start must be kept: its age cannot safely be inferred.
        guard let incumbentStart = incumbent.startedAt else {
            return candidate.startedAt == nil && candidate.processIdentifier < incumbent.processIdentifier
        }
        guard let candidateStart = candidate.startedAt else { return false }
        if candidateStart != incumbentStart { return candidateStart < incumbentStart }
        return candidate.processIdentifier < incumbent.processIdentifier
    }

    private static func preferredIncumbent(
        from running: [MenuBarInstanceIdentity]
    ) -> MenuBarInstanceIdentity? {
        running.sorted { lhs, rhs in
            let versionOrder = compareIdentityVersions(lhs, rhs)
            if versionOrder != .orderedSame { return versionOrder == .orderedDescending }
            switch (lhs.startedAt, rhs.startedAt) {
            case (nil, .some): return true
            case (.some, nil): return false
            case let (.some(left), .some(right)) where left != right: return left < right
            default: return lhs.processIdentifier < rhs.processIdentifier
            }
        }.first
    }

    private static func compareIdentityVersions(
        _ lhs: MenuBarInstanceIdentity,
        _ rhs: MenuBarInstanceIdentity
    ) -> ComparisonResult {
        switch (lhs.packageVersion, rhs.packageVersion) {
        case (nil, nil): return .orderedSame
        case (.some, nil): return .orderedDescending
        case (nil, .some): return .orderedAscending
        case let (.some(leftPackage), .some(rightPackage)):
            let packageOrder = compareVersions(leftPackage, rightPackage)
            if packageOrder != .orderedSame { return packageOrder }
            return compareVersions(
                lhs.buildVersion ?? leftPackage,
                rhs.buildVersion ?? rightPackage
            )
        }
    }

    private static func parsedVersion(_ raw: String) -> (core: [Int], prerelease: [String]) {
        let withoutMetadata = raw.split(separator: "+", maxSplits: 1).first.map(String.init) ?? raw
        let pieces = withoutMetadata.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        let core = pieces[0].split(separator: ".", omittingEmptySubsequences: false).map { Int($0) ?? 0 }
        let prerelease = pieces.count > 1 ? pieces[1].split(separator: ".").map(String.init) : []
        return (core.isEmpty ? [0] : core, prerelease)
    }

    static func identity(
        processIdentifier: pid_t,
        runtimeState: MenuBarRuntimeState?,
        expectedBundleIdentifier: String
    ) -> MenuBarInstanceIdentity {
        guard let state = runtimeState,
              state.pid == processIdentifier,
              state.bundle_identifier == expectedBundleIdentifier else {
            return MenuBarInstanceIdentity(
                processIdentifier: processIdentifier,
                packageVersion: nil,
                buildVersion: nil
            )
        }
        return MenuBarInstanceIdentity(
            processIdentifier: processIdentifier,
            packageVersion: state.package_version,
            buildVersion: state.build_version,
            startedAt: parseStartTime(state.started_at)
        )
    }

    private static func parseStartTime(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        let formatter = ISO8601DateFormatter()
        if let parsed = formatter.date(from: raw) { return parsed }
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: raw)
    }

    private func terminateAndReadBack(_ applications: [NSRunningApplication]) -> Bool {
        guard !applications.isEmpty else { return true }
        for application in applications { _ = application.terminate() }
        if waitUntilTerminated(applications, timeout: 2.0) { return true }
        for application in applications where !application.isTerminated { _ = application.forceTerminate() }
        return waitUntilTerminated(applications, timeout: 3.0)
    }

    private func waitUntilTerminated(_ applications: [NSRunningApplication], timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if applications.allSatisfy(\.isTerminated) { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        return applications.allSatisfy(\.isTerminated)
    }

    private func acquireLock(timeout: TimeInterval) -> Int32? {
        do {
            try FileManager.default.createDirectory(
                at: lockURL.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        } catch {
            return nil
        }
        let descriptor = open(lockURL.path, O_CREAT | O_RDWR | O_CLOEXEC, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { return nil }
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if flock(descriptor, LOCK_EX | LOCK_NB) == 0 { return descriptor }
            usleep(50_000)
        } while Date() < deadline
        close(descriptor)
        return nil
    }

    private func runtimeState() -> MenuBarRuntimeState? {
        guard let data = try? Data(contentsOf: stateURL) else { return nil }
        return try? JSONDecoder().decode(MenuBarRuntimeState.self, from: data)
    }

    private func writeRuntimeState() -> Bool {
        let state = MenuBarRuntimeState(
            schema: "sks.menubar-runtime-state.v1",
            pid: currentPID,
            package_version: packageVersion,
            build_version: buildVersion,
            bundle_identifier: bundleIdentifier,
            executable_path: Bundle.main.executableURL?.standardizedFileURL.path ?? CommandLine.arguments[0],
            started_at: ISO8601DateFormatter().string(from: startedAt)
        )
        do {
            let data = try JSONEncoder().encode(state)
            try data.write(to: stateURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stateURL.path)
            return true
        } catch {
            fputs("SKS Menu Bar singleton: failed to write runtime identity.\n", stderr)
            return false
        }
    }
}
