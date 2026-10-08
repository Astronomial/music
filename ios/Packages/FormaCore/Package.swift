// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "FormaCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "FormaCore", targets: ["FormaCore"])],
    targets: [
        .target(name: "FormaCore"),
        .testTarget(name: "FormaCoreTests", dependencies: ["FormaCore"], resources: [.process("Fixtures")])
    ]
)
