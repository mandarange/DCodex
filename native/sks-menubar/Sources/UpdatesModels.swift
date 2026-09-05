import Foundation

/// Installation target returned by review and bound to the selected project.
struct ReviewedSoftwareUpdate {
    let target: String
    let registry: String
    let projectRoot: String
}
