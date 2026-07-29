import Foundation

// Keep first-run connection setup near Overview, then provider/update work,
// integrations, and maintenance.
enum SidebarItem: String, CaseIterable {
    case overview = "Overview"
    case remoteCoding = "Remote Coding"
    case providers = "Providers"
    case updates = "Updates"
    case mcpServers = "MCP Servers"
    case diagnostics = "Diagnostics"
    case settings = "Settings"

    var symbolName: String {
        switch self {
        case .overview: return "gauge"
        case .providers: return "cpu"
        case .updates: return "arrow.down.circle"
        case .mcpServers: return "server.rack"
        case .remoteCoding: return "laptopcomputer.and.iphone"
        case .diagnostics: return "stethoscope"
        case .settings: return "gearshape"
        }
    }
}
