import Cocoa

enum AlertFactory {
    static func fatal(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = String(message.prefix(700))
        alert.alertStyle = .critical
        AppIdentity.applyIcon(to: alert)
        if let window = NSApp.keyWindow { alert.beginSheetModal(for: window) }
        else {
            NSApp.activate(ignoringOtherApps: true)
            alert.window.center()
            alert.window.orderFrontRegardless()
        }
    }

    static func confirmSheet(
        window: NSWindow,
        title: String,
        message: String,
        destructive: Bool,
        actionTitle: String? = nil,
        completion: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = destructive ? .warning : .informational
        alert.addButton(withTitle: actionTitle ?? (destructive ? "Remove" : "Continue"))
        alert.addButton(withTitle: "Cancel")
        AppIdentity.applyIcon(to: alert)
        alert.beginSheetModal(for: window) { completion($0 == .alertFirstButtonReturn) }
    }

    static func textSheet(
        window: NSWindow,
        title: String,
        message: String,
        secure: Bool = false,
        placeholder: String? = nil,
        actionTitle: String = "Apply",
        completion: @escaping (String?) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: actionTitle)
        alert.addButton(withTitle: "Cancel")
        let field: NSTextField = secure
            ? NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 420, height: 24))
            : NSTextField(frame: NSRect(x: 0, y: 0, width: 420, height: 24))
        field.isEditable = true
        field.isSelectable = true
        field.placeholderString = placeholder
        field.setAccessibilityLabel(title)
        if let placeholder, !placeholder.isEmpty {
            field.setAccessibilityPlaceholderValue(placeholder)
        }
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        AppIdentity.applyIcon(to: alert)
        alert.beginSheetModal(for: window) { response in
            let value = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            completion(response == .alertFirstButtonReturn && !value.isEmpty ? value : nil)
        }
        DispatchQueue.main.async {
            alert.window.makeFirstResponder(field)
        }
    }

    static func choiceSheet(window: NSWindow, title: String, message: String, choices: [(String, String)], completion: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 420, height: 26))
        popup.addItems(withTitles: choices.map(\.1))
        popup.setAccessibilityLabel(title)
        alert.accessoryView = popup
        AppIdentity.applyIcon(to: alert)
        alert.beginSheetModal(for: window) { response in
            let index = popup.indexOfSelectedItem
            completion(response == .alertFirstButtonReturn && index >= 0 && index < choices.count ? choices[index].0 : nil)
        }
    }
}
