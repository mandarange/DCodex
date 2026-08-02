import Darwin
import Foundation

final class TelegramStateLock: @unchecked Sendable {
    private static let schema = "sks.telegram-lock.v1"
    private static let maximumOwnerBytes = 4_096
    private static let attempts = 200
    private static let retryMicroseconds: useconds_t = 25_000

    private struct Owner {
        let pid: pid_t
        let token: String
        let processStartSeconds: Int64?
    }

    private struct Identity {
        let device: dev_t
        let inode: ino_t
        let pid: pid_t
        let token: String
    }

    private struct Inspected {
        let identity: Identity
        let owner: Owner
    }

    private struct Candidate {
        let url: URL
        let identity: Identity
    }

    private struct Participant {
        let url: URL
        let identity: Identity
    }

    private let stateDirectory: URL
    private let lockFileURL: URL
    private let reclaimDirectory: URL

    init(stateDirectory: URL) {
        self.stateDirectory = stateDirectory
        self.lockFileURL = stateDirectory.appendingPathComponent(".telegram.lock")
        self.reclaimDirectory = stateDirectory.appendingPathComponent(".telegram.lock.reclaim", isDirectory: true)
    }

    func withLock<T>(_ operation: () throws -> T) throws -> T {
        let identity = try acquire()
        defer { release(identity) }
        return try operation()
    }

    private func acquire() throws -> Identity {
        let candidate = try createCandidate(prefix: ".telegram.lock")
        defer { _ = unlink(candidate.url.path) }
        for attempt in 0..<Self.attempts {
            if try reclaimBarrierExists() {
                try settleReclaimBarrier()
                retryDelay(attempt)
                continue
            }
            if Darwin.link(candidate.url.path, lockFileURL.path) == 0 {
                do {
                    let acquired = try inspectOwnerFile(lockFileURL)
                    guard sameIdentity(acquired, candidate.identity) else {
                        throw TelegramPrivateFileError.insecurePath(lockFileURL.path)
                    }
                    if try reclaimBarrierExists() {
                        release(candidate.identity)
                        try settleReclaimBarrier()
                        retryDelay(attempt)
                        continue
                    }
                    return candidate.identity
                } catch {
                    release(candidate.identity)
                    throw error
                }
            }
            let code = errno
            guard code == EEXIST else {
                throw TelegramPrivateFileError.systemCall("link_lock", code)
            }
            let existing: Inspected
            do {
                existing = try inspectOwnerFile(lockFileURL)
            } catch TelegramPrivateFileError.systemCall(let operation, let errorCode)
                where isTransientLockInspection(operation, errorCode) {
                continue
            }
            if ownerIsDead(existing.owner), try reclaimDeadLock(existing) { continue }
            guard attempt < Self.attempts - 1 else {
                throw TelegramPrivateFileError.systemCall("lock_timeout", EBUSY)
            }
            retryDelay(attempt)
        }
        throw TelegramPrivateFileError.systemCall("lock_timeout", EBUSY)
    }

    private func reclaimDeadLock(_ expected: Inspected) throws -> Bool {
        let participant = try joinReclaimBarrier()
        do {
            try cleanupDeadParticipants()
            let current: Inspected
            do {
                current = try inspectOwnerFile(lockFileURL)
            } catch TelegramPrivateFileError.systemCall(let operation, let code)
                where isTransientLockInspection(operation, code) {
                try leaveReclaimBarrier(participant)
                return false
            }
            guard sameLock(current, expected), ownerIsDead(current.owner) else {
                try leaveReclaimBarrier(participant)
                return false
            }
            let removed = unlink(lockFileURL.path) == 0
            if !removed && errno != ENOENT { throw systemCall("unlink_dead_lock") }
            try leaveReclaimBarrier(participant)
            return removed
        } catch {
            try? leaveReclaimBarrier(participant)
            throw error
        }
    }

    private func settleReclaimBarrier() throws {
        let participant = try joinReclaimBarrier()
        do {
            try cleanupDeadParticipants()
            if let current = try? inspectOwnerFile(lockFileURL), ownerIsDead(current.owner) {
                if unlink(lockFileURL.path) != 0 && errno != ENOENT {
                    throw systemCall("unlink_dead_lock")
                }
            }
            try leaveReclaimBarrier(participant)
        } catch {
            try? leaveReclaimBarrier(participant)
            throw error
        }
    }

    private func joinReclaimBarrier() throws -> Participant {
        let candidate = try createCandidate(prefix: ".telegram.reclaim")
        defer { _ = unlink(candidate.url.path) }
        let participantURL = reclaimDirectory.appendingPathComponent(
            ".owner.\(candidate.identity.pid).\(candidate.identity.token)"
        )
        for attempt in 0..<Self.attempts {
            try ensureReclaimBarrier()
            if Darwin.link(candidate.url.path, participantURL.path) == 0 {
                let inspected = try inspectOwnerFile(participantURL, operation: "participant")
                guard sameIdentity(inspected, candidate.identity) else {
                    throw TelegramPrivateFileError.insecurePath(participantURL.path)
                }
                return Participant(url: participantURL, identity: candidate.identity)
            }
            let code = errno
            guard code == ENOENT || code == EEXIST || code == EINVAL else {
                throw TelegramPrivateFileError.systemCall("link_reclaim_participant", code)
            }
            retryDelay(attempt)
        }
        throw TelegramPrivateFileError.systemCall("reclaim_barrier_timeout", EBUSY)
    }

    private func leaveReclaimBarrier(_ participant: Participant) throws {
        _ = try unlinkOwnedFile(participant.url, identity: participant.identity, operation: "participant")
        try cleanupDeadParticipants()
        if rmdir(reclaimDirectory.path) != 0 && errno != ENOENT && errno != ENOTEMPTY && errno != EEXIST {
            throw systemCall("rmdir_reclaim_barrier")
        }
    }

    private func cleanupDeadParticipants() throws {
        let names: [String]
        do {
            names = try FileManager.default.contentsOfDirectory(atPath: reclaimDirectory.path)
        } catch let error as NSError where error.domain == NSCocoaErrorDomain
            && (error.code == NSFileNoSuchFileError || error.code == NSFileReadNoSuchFileError) {
            return
        }
        for name in names {
            let url = reclaimDirectory.appendingPathComponent(name)
            let inspected: Inspected
            do {
                inspected = try inspectOwnerFile(url, operation: "participant")
            } catch TelegramPrivateFileError.systemCall(let operation, let code)
                where code == ENOENT && [
                    "lstat_participant", "open_participant", "lstat_participant_after_read"
                ].contains(operation) {
                continue
            }
            guard name == ".owner.\(inspected.owner.pid).\(inspected.owner.token)" else {
                throw TelegramPrivateFileError.insecurePath(url.path)
            }
            if ownerIsDead(inspected.owner) {
                _ = try unlinkOwnedFile(url, identity: inspected.identity, operation: "participant")
            }
        }
    }

    private func ensureReclaimBarrier() throws {
        for attempt in 0..<Self.attempts {
            if mkdir(reclaimDirectory.path, 0o700) != 0 && errno != EEXIST {
                throw systemCall("mkdir_reclaim_barrier")
            }
            if try inspectReclaimBarrier() { return }
            retryDelay(attempt)
        }
        throw TelegramPrivateFileError.systemCall("reclaim_barrier_timeout", EBUSY)
    }

    private func reclaimBarrierExists() throws -> Bool { try inspectReclaimBarrier() }

    private func inspectReclaimBarrier() throws -> Bool {
        var pathMetadata = stat()
        if lstat(reclaimDirectory.path, &pathMetadata) != 0 {
            let code = errno
            if code == ENOENT { return false }
            throw TelegramPrivateFileError.systemCall("lstat_reclaim_barrier", code)
        }
        guard (pathMetadata.st_mode & S_IFMT) == S_IFDIR,
              (pathMetadata.st_mode & 0o777) == 0o700,
              pathMetadata.st_uid == geteuid() else {
            throw TelegramPrivateFileError.insecurePath(reclaimDirectory.path)
        }
        let descriptor = open(reclaimDirectory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if descriptor < 0 {
            let code = errno
            if code == ENOENT { return false }
            throw TelegramPrivateFileError.systemCall("open_reclaim_barrier", code)
        }
        defer { close(descriptor) }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0 else { throw systemCall("fstat_reclaim_barrier") }
        guard (metadata.st_mode & S_IFMT) == S_IFDIR,
              (metadata.st_mode & 0o777) == 0o700,
              metadata.st_uid == geteuid() else {
            throw TelegramPrivateFileError.insecurePath(reclaimDirectory.path)
        }
        guard metadata.st_dev == pathMetadata.st_dev,
              metadata.st_ino == pathMetadata.st_ino else { return false }
        return true
    }

    private func createCandidate(prefix: String) throws -> Candidate {
        let pid = getpid()
        let token = UUID().uuidString.lowercased()
        let owner: [String: Any] = [
            "schema": Self.schema,
            "pid": pid,
            "token": token,
            "process_start_seconds": Self.processStartSeconds(pid).map { NSNumber(value: $0) } ?? NSNull()
        ]
        let data = try JSONSerialization.data(withJSONObject: owner, options: [.sortedKeys]) + Data([0x0A])
        let url = stateDirectory.appendingPathComponent("\(prefix).\(pid).\(token).tmp")
        let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw systemCall("open_lock_candidate") }
        var descriptorOpen = true
        var candidateReady = false
        defer {
            if descriptorOpen { close(descriptor) }
            if !candidateReady { _ = unlink(url.path) }
        }
        guard fchmod(descriptor, 0o600) == 0 else { throw systemCall("fchmod_lock_candidate") }
        try writeAll(data, descriptor: descriptor)
        guard fsync(descriptor) == 0 else { throw systemCall("fsync_lock_candidate") }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              (metadata.st_mode & 0o777) == 0o600,
              metadata.st_uid == geteuid() else {
            throw TelegramPrivateFileError.insecurePath(url.path)
        }
        guard close(descriptor) == 0 else { throw systemCall("close_lock_candidate") }
        descriptorOpen = false
        candidateReady = true
        return Candidate(
            url: url,
            identity: Identity(device: metadata.st_dev, inode: metadata.st_ino, pid: pid, token: token)
        )
    }

    private func inspectOwnerFile(_ url: URL, operation: String = "lock") throws -> Inspected {
        var pathMetadata = stat()
        guard lstat(url.path, &pathMetadata) == 0 else {
            throw TelegramPrivateFileError.systemCall("lstat_\(operation)", errno)
        }
        guard (pathMetadata.st_mode & S_IFMT) == S_IFREG,
              (pathMetadata.st_mode & 0o777) == 0o600,
              pathMetadata.st_uid == geteuid(),
              pathMetadata.st_size > 0,
              pathMetadata.st_size <= off_t(Self.maximumOwnerBytes) else {
            throw TelegramPrivateFileError.insecurePath(url.path)
        }
        let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw systemCall("open_\(operation)") }
        defer { close(descriptor) }
        var before = stat()
        guard fstat(descriptor, &before) == 0,
              before.st_dev == pathMetadata.st_dev, before.st_ino == pathMetadata.st_ino,
              (before.st_mode & S_IFMT) == S_IFREG, (before.st_mode & 0o777) == 0o600,
              before.st_uid == geteuid() else { throw ownerIdentityFailure(url, operation: operation) }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 512)
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count == 0 { break }
            guard count > 0 else {
                if errno == EINTR { continue }
                throw systemCall("read_\(operation)")
            }
            data.append(contentsOf: buffer.prefix(count))
            guard data.count <= Self.maximumOwnerBytes else {
                throw TelegramPrivateFileError.insecurePath(url.path)
            }
        }
        var after = stat()
        guard fstat(descriptor, &after) == 0,
              after.st_dev == before.st_dev, after.st_ino == before.st_ino, after.st_size == before.st_size else {
            throw ownerIdentityFailure(url, operation: operation)
        }
        var pathAfter = stat()
        guard lstat(url.path, &pathAfter) == 0 else {
            throw TelegramPrivateFileError.systemCall("lstat_\(operation)_after_read", errno)
        }
        guard
              pathAfter.st_dev == after.st_dev, pathAfter.st_ino == after.st_ino,
              (pathAfter.st_mode & S_IFMT) == S_IFREG, (pathAfter.st_mode & 0o777) == 0o600,
              pathAfter.st_uid == geteuid() else { throw ownerIdentityFailure(url, operation: operation) }
        let owner = try decodeOwner(data)
        return Inspected(
            identity: Identity(device: after.st_dev, inode: after.st_ino, pid: owner.pid, token: owner.token),
            owner: owner
        )
    }

    private func decodeOwner(_ data: Data) throws -> Owner {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(root.keys).isSubset(of: ["schema", "pid", "token", "process_start_seconds"]),
              root["schema"] as? String == Self.schema,
              let pidNumber = root["pid"] as? NSNumber,
              CFGetTypeID(pidNumber) != CFBooleanGetTypeID(),
              let pid = pid_t(pidNumber.stringValue), pid > 0,
              let token = root["token"] as? String, UUID(uuidString: token) != nil else {
            throw TelegramPrivateFileError.invalidStoredValue
        }
        let start: Int64?
        switch root["process_start_seconds"] {
        case nil, is NSNull:
            start = nil
        case let number as NSNumber where CFGetTypeID(number) != CFBooleanGetTypeID()
            && number.int64Value > 0 && number.doubleValue == Double(number.int64Value):
            start = number.int64Value
        default:
            throw TelegramPrivateFileError.invalidStoredValue
        }
        return Owner(pid: pid, token: token, processStartSeconds: start)
    }

    private func unlinkOwnedFile(_ url: URL, identity: Identity, operation: String) throws -> Bool {
        let current: Inspected
        do {
            current = try inspectOwnerFile(url, operation: operation)
        } catch TelegramPrivateFileError.systemCall(let name, let code)
            where (name == "lstat_\(operation)" && code == ENOENT)
                || (operation == "lock" && isTransientLockInspection(name, code)) {
            return false
        }
        guard sameIdentity(current, identity) else { return false }
        if unlink(url.path) == 0 { return true }
        if errno == ENOENT { return false }
        throw systemCall("unlink_\(operation)")
    }

    private func release(_ identity: Identity) {
        guard identity.pid == getpid() else { return }
        _ = try? unlinkOwnedFile(lockFileURL, identity: identity, operation: "lock")
    }

    private func sameIdentity(_ current: Inspected, _ expected: Identity) -> Bool {
        current.identity.device == expected.device && current.identity.inode == expected.inode
            && current.owner.pid == expected.pid && current.owner.token == expected.token
    }

    private func sameLock(_ left: Inspected, _ right: Inspected) -> Bool {
        left.identity.device == right.identity.device && left.identity.inode == right.identity.inode
            && left.owner.pid == right.owner.pid && left.owner.token == right.owner.token
    }

    private func ownerIsDead(_ owner: Owner) -> Bool {
        errno = 0
        let result = Darwin.kill(owner.pid, 0)
        if result != 0 && errno == ESRCH { return true }
        if result != 0 && errno != EPERM { return false }
        guard let expected = owner.processStartSeconds,
              let observed = Self.processStartSeconds(owner.pid) else { return false }
        return observed != expected
    }

    private func ownerIdentityFailure(_ url: URL, operation: String) -> TelegramPrivateFileError {
        operation == "lock"
            ? .systemCall("lock_identity_changed", EAGAIN)
            : .insecurePath(url.path)
    }

    private func isTransientLockInspection(_ operation: String, _ code: Int32) -> Bool {
        code == ENOENT && (
            operation == "lstat_lock" || operation == "open_lock" || operation == "lstat_lock_after_read"
        )
            || operation == "lock_identity_changed" && code == EAGAIN
    }

    private static func processStartSeconds(_ pid: pid_t) -> Int64? {
        guard pid > 0 else { return nil }
        var info = proc_bsdinfo()
        let expectedBytes = MemoryLayout<proc_bsdinfo>.stride
        let readBytes = withUnsafeMutablePointer(to: &info) {
            proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, $0, Int32(expectedBytes))
        }
        guard Int(readBytes) == expectedBytes, info.pbi_start_tvsec > 0 else { return nil }
        return Int64(info.pbi_start_tvsec)
    }

    private func retryDelay(_ attempt: Int) {
        if attempt + 1 < Self.attempts { usleep(Self.retryMicroseconds) }
    }

    private func writeAll(_ data: Data, descriptor: Int32) throws {
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                guard let base = bytes.baseAddress else { break }
                let count = Darwin.write(descriptor, base.advanced(by: offset), bytes.count - offset)
                guard count >= 0 else {
                    if errno == EINTR { continue }
                    throw systemCall("write_lock_owner")
                }
                offset += count
            }
        }
    }

    private func systemCall(_ operation: String) -> TelegramPrivateFileError {
        TelegramPrivateFileError.systemCall(operation, errno)
    }
}
