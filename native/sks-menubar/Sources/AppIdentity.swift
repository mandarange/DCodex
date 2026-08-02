import Cocoa

enum AppIdentity {
    static let bundleIdentifier = "com.sneakoscope.sks-menubar"

    static var buildVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
            ?? AppRuntime.packageVersion
    }

    static func configure() {
        if let url = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
           let image = NSImage(contentsOf: url) {
            NSApplication.shared.applicationIconImage = image
        }
    }

    /// Install a minimal main menu so Cut/Copy/Paste/Select All key equivalents
    /// work in Control Center sheets and editable fields under `.accessory` policy.
    static func installStandardEditMenu() {
        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "Quit SKS Center", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Delete", action: #selector(NSText.delete(_:)), keyEquivalent: "")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        NSApp.mainMenu = mainMenu
    }

    static func applyIcon(to alert: NSAlert) {
        alert.icon = NSApplication.shared.applicationIconImage
    }

    static func statusImage(resource: String, symbol: String) -> NSImage? {
        // Prefer the validated custom status PDFs; fall back to SF Symbols only when missing.
        let image = Bundle.main.image(forResource: resource)
            ?? NSImage(systemSymbolName: symbol, accessibilityDescription: "SKS status")
        image?.isTemplate = true
        return image
    }
}
