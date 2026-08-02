import Cocoa
import Darwin
import UserNotifications

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
    static let actionScript = __SKS_ACTION_SCRIPT__
    static let projectRoot = __SKS_PROJECT_ROOT__
    static let canonicalProjectRoot = sksCanonicalFilesystemPath(projectRoot)
    static let buildStampPath = __SKS_BUILD_STAMP__
    static let configPath = __SKS_CONFIG_PATH__
    static let lastActionLogPath = __SKS_LAST_LOG__
    static let operationDirectory = __SKS_OPERATION_DIR__
    static let codexBundleId: String? = __SKS_CODEX_BUNDLE_ID__
    static let packageVersion = __SKS_PACKAGE_VERSION__
}

let application = NSApplication.shared
let singletonGuard = SingletonInstanceGuard(
    bundleIdentifier: AppIdentity.bundleIdentifier,
    packageVersion: AppRuntime.packageVersion,
    buildVersion: AppIdentity.buildVersion,
    buildStampPath: AppRuntime.buildStampPath
)
switch singletonGuard.acquire() {
case .acquired:
    break
case .lostArbitration:
    exit(EXIT_SUCCESS)
case .degraded:
    break
}
let applicationDelegate = AppDelegate(singletonGuard: singletonGuard)
application.delegate = applicationDelegate
application.run()
