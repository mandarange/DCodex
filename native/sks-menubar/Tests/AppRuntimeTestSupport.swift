#if SKS_NATIVE_TESTING
enum AppRuntime {
    static let actionScript = "/tmp/sks-menubar-action.sh"
    static let projectRoot = "/tmp/sks-menubar-project"
    static let buildStampPath = "/tmp/sks-menubar-build-stamp.json"
    static let configPath = "/tmp/sks-menubar-config.json"
    static let lastActionLogPath = "/tmp/sks-menubar-last-action.log"
    static let operationDirectory = "/tmp/sks-menubar-operations"
    static let codexBundleId: String? = nil
    static let packageVersion = "test"
}
#endif
