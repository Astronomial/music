// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "FormaCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "FormaCore", targets: ["FormaCore"]), .executable(name: "pulse-audit", targets: ["PulseAudit"])],
    targets: [
        .target(name: "FormaCore", resources: [.process("Resources")]),
        .executableTarget(name: "PulseAudit", dependencies: ["FormaCore"]),
        .testTarget(name: "FormaCoreTests", dependencies: ["FormaCore"], resources: [.process("Fixtures")])
    ]
)
