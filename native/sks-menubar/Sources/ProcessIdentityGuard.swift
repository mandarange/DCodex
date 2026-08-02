import Darwin
import Foundation

struct OwnedProcessIdentity: Hashable {
    let pid: pid_t
    let startSeconds: UInt64
    let startMicroseconds: UInt64
}

final class ProcessIdentityGuard {
    typealias IdentityLookup = (pid_t) -> OwnedProcessIdentity?
    typealias ProcessGroupLookup = (pid_t) -> pid_t
    typealias ProcessGroupExistence = (pid_t) -> Bool
    typealias ProcessSignal = (pid_t, Int32) -> Int32

    private let identityLookup: IdentityLookup
    private let processGroupLookup: ProcessGroupLookup
    private let processGroupExists: ProcessGroupExistence
    private let processSignal: ProcessSignal

    init(
        identityLookup: @escaping IdentityLookup = ProcessIdentityGuard.systemIdentity,
        processGroupLookup: @escaping ProcessGroupLookup = { Darwin.getpgid($0) },
        processGroupExists: @escaping ProcessGroupExistence = ProcessIdentityGuard.systemProcessGroupExists,
        processSignal: @escaping ProcessSignal = { Darwin.kill($0, $1) }
    ) {
        self.identityLookup = identityLookup
        self.processGroupLookup = processGroupLookup
        self.processGroupExists = processGroupExists
        self.processSignal = processSignal
    }

    func capture(_ pid: pid_t) -> OwnedProcessIdentity? {
        identityLookup(pid)
    }

    func isCurrent(_ identity: OwnedProcessIdentity) -> Bool {
        identityLookup(identity.pid) == identity
    }

    func processGroupID(ifCurrent identity: OwnedProcessIdentity) -> pid_t? {
        guard isCurrent(identity) else { return nil }
        let processGroupID = processGroupLookup(identity.pid)
        guard processGroupID > 0, isCurrent(identity) else { return nil }
        return processGroupID
    }

    func processGroupIsOwned(
        _ expectedProcessGroupID: pid_t,
        rootIdentity: OwnedProcessIdentity?,
        descendants: [OwnedProcessIdentity]
    ) -> Bool {
        if descendants.contains(where: { identity in
            processGroupID(ifCurrent: identity) == expectedProcessGroupID
        }) {
            return true
        }
        guard let rootIdentity else { return false }
        if processGroupID(ifCurrent: rootIdentity) == expectedProcessGroupID {
            return true
        }
        // A group can outlive its leader. It still belongs to this tracked
        // execution while the original leader PID remains absent. If that PID
        // has been reused, its mismatched start identity revokes ownership.
        guard identityLookup(rootIdentity.pid) == nil else { return false }
        return processGroupExists(expectedProcessGroupID)
    }

    @discardableResult
    func signalIfCurrent(_ identity: OwnedProcessIdentity, signal: Int32) -> Bool {
        guard isCurrent(identity) else { return false }
        return processSignal(identity.pid, signal) == 0
    }

    @discardableResult
    func signalProcessGroupIfOwned(
        _ processGroupID: pid_t,
        rootIdentity: OwnedProcessIdentity?,
        descendants: [OwnedProcessIdentity],
        signal: Int32
    ) -> Bool {
        guard processGroupID > 0,
              processGroupIsOwned(
                processGroupID,
                rootIdentity: rootIdentity,
                descendants: descendants
              ) else {
            return false
        }
        return processSignal(-processGroupID, signal) == 0
    }

    static func systemIdentity(_ pid: pid_t) -> OwnedProcessIdentity? {
        guard pid > 0 else { return nil }
        var info = proc_bsdinfo()
        let expectedBytes = MemoryLayout<proc_bsdinfo>.stride
        let readBytes = withUnsafeMutablePointer(to: &info) {
            proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, $0, Int32(expectedBytes))
        }
        guard Int(readBytes) == expectedBytes else { return nil }
        return OwnedProcessIdentity(
            pid: pid,
            startSeconds: UInt64(info.pbi_start_tvsec),
            startMicroseconds: UInt64(info.pbi_start_tvusec)
        )
    }

    static func systemProcessGroupExists(_ processGroupID: pid_t) -> Bool {
        guard processGroupID > 0 else { return false }
        errno = 0
        return Darwin.kill(-processGroupID, 0) == 0 || errno != ESRCH
    }
}

struct OwnedProcessExecution {
    let process: Process
    let reader: FileHandle
    let rootIdentity: OwnedProcessIdentity?
    let processGroupID: pid_t?
    var observedDescendants: Set<OwnedProcessIdentity>
}

struct OwnedProcessIdentitySnapshot {
    let rootIdentity: OwnedProcessIdentity?
    let processGroupID: pid_t?
    let descendants: [OwnedProcessIdentity]
}

final class OwnedProcessRegistry {
    private let identityGuard: ProcessIdentityGuard
    private let queue = DispatchQueue(label: "com.sneakoscope.sks-menubar.process-registry")
    private var executions: [Int32: OwnedProcessExecution] = [:]

    init(identityGuard: ProcessIdentityGuard) {
        self.identityGuard = identityGuard
    }

    func activeExecutions() -> [OwnedProcessExecution] {
        queue.sync { Array(executions.values) }
    }

    func track(_ process: Process, reader: FileHandle) {
        let pid = process.processIdentifier
        let rootIdentity = identityGuard.capture(pid)
        let observedGroup = rootIdentity.flatMap {
            identityGuard.processGroupID(ifCurrent: $0)
        }
        let ownedGroup = observedGroup == pid ? observedGroup : nil
        queue.sync {
            executions[pid] = OwnedProcessExecution(
                process: process,
                reader: reader,
                rootIdentity: rootIdentity,
                processGroupID: ownedGroup,
                observedDescendants: []
            )
        }
    }

    func untrack(_ process: Process) {
        _ = queue.sync {
            executions.removeValue(forKey: process.processIdentifier)
        }
    }

    func rememberDescendants(_ descendants: [pid_t], of process: Process) {
        let captured = descendants.compactMap { identityGuard.capture($0) }
        queue.sync {
            let pid = process.processIdentifier
            guard var execution = executions[pid] else { return }
            execution.observedDescendants = current(execution.observedDescendants)
            execution.observedDescendants.formUnion(captured)
            executions[pid] = execution
        }
    }

    func identitySnapshot(of process: Process) -> OwnedProcessIdentitySnapshot? {
        queue.sync {
            let pid = process.processIdentifier
            guard var execution = executions[pid] else { return nil }
            execution.observedDescendants = current(execution.observedDescendants)
            executions[pid] = execution
            return OwnedProcessIdentitySnapshot(
                rootIdentity: execution.rootIdentity,
                processGroupID: execution.processGroupID,
                descendants: Array(execution.observedDescendants)
            )
        }
    }

    private func current(
        _ identities: Set<OwnedProcessIdentity>
    ) -> Set<OwnedProcessIdentity> {
        Set(identities.filter { identityGuard.isCurrent($0) })
    }
}
