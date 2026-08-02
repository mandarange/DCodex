#if SKS_NATIVE_TESTING
import Foundation
import Darwin

private func sksCanonicalFilesystemPath(_ value: String) -> String {
    let standardized = URL(fileURLWithPath: value, isDirectory: true)
        .resolvingSymlinksInPath().standardizedFileURL.path
    return standardized.withCString { pointer in
        guard let resolved = Darwin.realpath(pointer, nil) else { return standardized }
        defer { free(resolved) }
        return String(cString: resolved)
    }
}

enum AppRuntime {
    static let actionScript = "/tmp/sks-menubar-action.sh"
    static let projectRoot = "/tmp/sks-menubar-project"
    static let canonicalProjectRoot = sksCanonicalFilesystemPath(projectRoot)
    static let buildStampPath = "/tmp/sks-menubar-build-stamp.json"
    static let configPath = "/tmp/sks-menubar-config.json"
    static let lastActionLogPath = "/tmp/sks-menubar-last-action.log"
    static let operationDirectory = "/tmp/sks-menubar-operations"
    static let codexBundleId: String? = nil
    static let packageVersion = "test"
}
#endif
