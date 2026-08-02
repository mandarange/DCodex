import Darwin
import Foundation

enum TelegramPrivateFileError: Error, Equatable {
    case invalidStoredValue
    case insecurePath(String)
    case fileTooLarge(String)
    case tooManyConfirmations
    case systemCall(String, Int32)
}

final class TelegramPrivateFileSupport: @unchecked Sendable {
    static let maximumFileBytes = 1_048_576

    let tokenURL: URL
    let stateURL: URL

    private let sksDirectory: URL
    private let secretDirectory: URL
    private let stateDirectory: URL
    private let stateLock: TelegramStateLock
    private let lock = NSLock()

    init(homeDirectory: URL?, environment: [String: String]) {
        let home = homeDirectory
            ?? environment["HOME"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.homeDirectoryForCurrentUser
        let configuredRoot = environment["SKS_HOME"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.sksDirectory = configuredRoot.flatMap {
            $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true)
        }?.standardizedFileURL
            ?? home.standardizedFileURL.appendingPathComponent(".sneakoscope", isDirectory: true)
        self.secretDirectory = sksDirectory.appendingPathComponent("secrets", isDirectory: true)
        self.stateDirectory = sksDirectory.appendingPathComponent("state", isDirectory: true)
        self.tokenURL = secretDirectory.appendingPathComponent("telegram-bot-token")
        self.stateURL = stateDirectory.appendingPathComponent("telegram.json")
        self.stateLock = TelegramStateLock(stateDirectory: stateDirectory)
    }

    func readTokenData() throws -> Data? {
        try lock.withTelegramFileLock {
            guard try prepareDirectory(sksDirectory, create: false, exactPrivateMode: false),
                  try prepareDirectory(secretDirectory, create: false, exactPrivateMode: true) else { return nil }
            return try readPrivateFile(tokenURL)
        }
    }

    func withStateTransaction<T>(_ operation: () throws -> T) throws -> T {
        try lock.withTelegramFileLock {
            _ = try prepareDirectory(sksDirectory, create: true, exactPrivateMode: false)
            _ = try prepareDirectory(stateDirectory, create: true, exactPrivateMode: true)
            return try stateLock.withLock(operation)
        }
    }

    func readStateData() throws -> Data? { try readPrivateFile(stateURL) }

    func writeStateData(_ data: Data) throws {
        guard data.count <= Self.maximumFileBytes else {
            throw TelegramPrivateFileError.fileTooLarge(stateURL.path)
        }
        try writePrivateFileAtomically(data, to: stateURL)
    }

    @discardableResult
    private func prepareDirectory(_ url: URL, create: Bool, exactPrivateMode: Bool) throws -> Bool {
        var pathMetadata = stat()
        var created = false
        if lstat(url.path, &pathMetadata) != 0 {
            let code = errno
            guard code == ENOENT else { throw TelegramPrivateFileError.systemCall("lstat_directory", code) }
            guard create else { return false }
            if mkdir(url.path, 0o700) == 0 { created = true }
            else if errno != EEXIST { throw systemCall("mkdir") }
            guard lstat(url.path, &pathMetadata) == 0 else { throw systemCall("lstat_directory") }
        }
        guard (pathMetadata.st_mode & S_IFMT) == S_IFDIR else {
            throw TelegramPrivateFileError.insecurePath(url.path)
        }
        let descriptor = open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw systemCall("open_directory") }
        defer { close(descriptor) }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0 else { throw systemCall("fstat_directory") }
        if created && exactPrivateMode {
            guard fchmod(descriptor, 0o700) == 0, fstat(descriptor, &metadata) == 0 else {
                throw systemCall("fchmod_directory")
            }
        }
        guard (metadata.st_mode & S_IFMT) == S_IFDIR,
              (exactPrivateMode ? (metadata.st_mode & 0o777) == 0o700 : (metadata.st_mode & 0o022) == 0),
              metadata.st_uid == geteuid(),
              metadata.st_dev == pathMetadata.st_dev,
              metadata.st_ino == pathMetadata.st_ino else {
            throw TelegramPrivateFileError.insecurePath(url.path)
        }
        return true
    }

    private func readPrivateFile(_ url: URL) throws -> Data? {
        var pathMetadata = stat()
        if lstat(url.path, &pathMetadata) != 0 {
            let code = errno
            if code == ENOENT { return nil }
            throw TelegramPrivateFileError.systemCall("lstat_file", code)
        }
        guard (pathMetadata.st_mode & S_IFMT) == S_IFREG else {
            throw TelegramPrivateFileError.insecurePath(url.path)
        }
        let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw systemCall("open_file") }
        defer { close(descriptor) }
        var before = stat()
        guard fstat(descriptor, &before) == 0,
              (before.st_mode & S_IFMT) == S_IFREG,
              (before.st_mode & 0o777) == 0o600,
              before.st_uid == geteuid(),
              before.st_dev == pathMetadata.st_dev,
              before.st_ino == pathMetadata.st_ino else {
            throw TelegramPrivateFileError.insecurePath(url.path)
        }
        guard before.st_size <= off_t(Self.maximumFileBytes) else {
            throw TelegramPrivateFileError.fileTooLarge(url.path)
        }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16 * 1024)
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count == 0 { break }
            guard count > 0 else {
                if errno == EINTR { continue }
                throw systemCall("read_file")
            }
            data.append(contentsOf: buffer.prefix(count))
            guard data.count <= Self.maximumFileBytes else {
                throw TelegramPrivateFileError.fileTooLarge(url.path)
            }
        }
        var after = stat()
        var pathAfter = stat()
        guard fstat(descriptor, &after) == 0,
              lstat(url.path, &pathAfter) == 0,
              after.st_dev == before.st_dev,
              after.st_ino == before.st_ino,
              after.st_size == before.st_size,
              (after.st_mode & S_IFMT) == S_IFREG,
              (after.st_mode & 0o777) == 0o600,
              after.st_uid == geteuid(),
              pathAfter.st_dev == after.st_dev,
              pathAfter.st_ino == after.st_ino,
              (pathAfter.st_mode & S_IFMT) == S_IFREG,
              (pathAfter.st_mode & 0o777) == 0o600,
              pathAfter.st_uid == geteuid() else {
            throw TelegramPrivateFileError.insecurePath(url.path)
        }
        return data
    }

    private func writePrivateFileAtomically(_ data: Data, to url: URL) throws {
        guard data.count <= Self.maximumFileBytes else {
            throw TelegramPrivateFileError.fileTooLarge(url.path)
        }
        var existing = stat()
        if lstat(url.path, &existing) == 0 {
            guard (existing.st_mode & S_IFMT) == S_IFREG,
                  (existing.st_mode & 0o777) == 0o600,
                  existing.st_uid == geteuid() else {
                throw TelegramPrivateFileError.insecurePath(url.path)
            }
        } else {
            let code = errno
            if code != ENOENT { throw TelegramPrivateFileError.systemCall("lstat_file", code) }
        }
        let temporaryURL = stateDirectory.appendingPathComponent(
            ".\(url.lastPathComponent).\(getpid()).\(UUID().uuidString).tmp"
        )
        let descriptor = open(temporaryURL.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw systemCall("open_temporary") }
        var descriptorOpen = true
        defer {
            if descriptorOpen { close(descriptor) }
            unlink(temporaryURL.path)
        }
        guard fchmod(descriptor, 0o600) == 0 else { throw systemCall("fchmod_temporary") }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              (metadata.st_mode & 0o777) == 0o600,
              metadata.st_uid == geteuid() else {
            throw TelegramPrivateFileError.insecurePath(temporaryURL.path)
        }
        try writeAll(data, descriptor: descriptor)
        guard fsync(descriptor) == 0 else { throw systemCall("fsync_temporary") }
        guard close(descriptor) == 0 else { throw systemCall("close_temporary") }
        descriptorOpen = false
        guard rename(temporaryURL.path, url.path) == 0 else { throw systemCall("rename_state") }
        let directoryDescriptor = open(stateDirectory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directoryDescriptor >= 0 else { throw systemCall("open_state_directory") }
        guard fsync(directoryDescriptor) == 0 else {
            let code = errno
            close(directoryDescriptor)
            throw TelegramPrivateFileError.systemCall("fsync_state_directory", code)
        }
        guard close(directoryDescriptor) == 0 else { throw systemCall("close_state_directory") }
        guard try readPrivateFile(url) == data else {
            throw TelegramPrivateFileError.insecurePath(url.path)
        }
    }

    private func writeAll(_ data: Data, descriptor: Int32) throws {
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                guard let base = bytes.baseAddress else { break }
                let count = Darwin.write(descriptor, base.advanced(by: offset), bytes.count - offset)
                guard count >= 0 else {
                    if errno == EINTR { continue }
                    throw systemCall("write_temporary")
                }
                offset += count
            }
        }
    }

    private func systemCall(_ operation: String) -> TelegramPrivateFileError {
        TelegramPrivateFileError.systemCall(operation, errno)
    }
}

private extension NSLock {
    func withTelegramFileLock<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
