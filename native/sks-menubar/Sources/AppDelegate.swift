import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let singletonGuard: SingletonInstanceGuard
    private var processClient: ProcessClient!
    private var operations: OperationCoordinator!
    private var notifications: NotificationCoordinator!
    private var controlCenter: ControlCenterWindowController!
    private var statusItemController: StatusItemController!
    private var telegramService: TelegramMenuBarService?

    init(singletonGuard: SingletonInstanceGuard) {
        self.singletonGuard = singletonGuard
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        AppIdentity.configure()
        // Accessory/menubar apps have no system Edit menu by default, so Cmd+C/V
        // never reaches NSTextField/NSTextView responders without an explicit menu.
        AppIdentity.installStandardEditMenu()
        processClient = ProcessClient(actionScript: AppRuntime.actionScript, logPath: AppRuntime.lastActionLogPath, projectRoot: AppRuntime.projectRoot)
        let residentTelegramService = TelegramRuntimeFactory.make(
            processClient: processClient,
            canonicalProjectRoot: AppRuntime.canonicalProjectRoot
        )
        telegramService = residentTelegramService
        _ = residentTelegramService.start()
        operations = OperationCoordinator(directory: AppRuntime.operationDirectory)
        notifications = NotificationCoordinator()
        controlCenter = ControlCenterWindowController(
            processClient: processClient,
            operations: operations,
            notifications: notifications,
            telegramService: residentTelegramService
        )
        statusItemController = StatusItemController(
            processClient: processClient,
            operations: operations,
            notifications: notifications,
            openControlCenter: { [weak self] section in self?.controlCenter.show(section: section) }
        )
        notifications.onOpenControlCenter = { [weak self] in self?.controlCenter.show(section: .overview) }
        notifications.onOpenLog = { NSWorkspace.shared.open(URL(fileURLWithPath: AppRuntime.lastActionLogPath)) }
        notifications.onRetryOperation = { [weak self] in self?.statusItemController.retryLastOperation() }
        notifications.onAuthorizationChanged = { [weak self] denied in
            self?.statusItemController.setNotificationAuthorizationDenied(denied)
            self?.controlCenter.setNotificationAuthorizationDenied(denied)
        }
        notifications.configure()
        statusItemController.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        if telegramService?.stopAndWait(timeout: 2) == false {
            fputs("SKS Telegram bounded stop timed out; liveness will become stale.\n", stderr)
        }
        statusItemController?.stop()
        processClient?.terminateAll()
        singletonGuard.releaseRuntimeStateIfOwned()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        controlCenter?.show(section: .overview)
        return true
    }
}
