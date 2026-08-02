import Foundation

enum ProcessTerminationReason {
    case timeout, outputLimit
}

final class ProcessExecutionState {
    private let lock = NSLock()
    private var reason: ProcessTerminationReason?
    private var completed = false

    var terminationReason: ProcessTerminationReason? {
        lock.lock()
        defer { lock.unlock() }
        return reason
    }

    var isCompleted: Bool {
        lock.lock()
        defer { lock.unlock() }
        return completed
    }

    func markTimedOut() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !completed, reason == nil else { return false }
        reason = .timeout
        return true
    }

    func markOutputLimitExceeded() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !completed, reason == nil else { return false }
        reason = .outputLimit
        return true
    }

    func markCompleted() {
        lock.lock()
        completed = true
        lock.unlock()
    }
}
