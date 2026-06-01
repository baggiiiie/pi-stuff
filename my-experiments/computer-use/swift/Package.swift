// swift-tools-version: 6.0
import PackageDescription

// Compiled Swift binary backing the @baggiiiie/pi-computer-use Node
// extension. Implements every computer-use subcommand (list_apps,
// get_state, click, key, type, screenshot) using trycua/cua's
// CuaDriverCore for screen capture and AppKit/ApplicationServices
// directly for AX, input, and pasteboard work. Replaces the legacy
// `/usr/bin/swift src/helper.swift` script-mode entry point.
//
// cua-driver does not yet publish plain semver tags (only "cua-driver-v*"),
// so SwiftPM has to pin by revision.
let package = Package(
    name: "pi-helper",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(
            url: "https://github.com/trycua/cua.git",
            revision: "cua-driver-v0.1.2"
        ),
    ],
    targets: [
        .executableTarget(
            name: "pi-helper",
            dependencies: [
                .product(name: "CuaDriverCore", package: "cua"),
            ],
            path: "Sources/pi-helper"
        ),
    ]
)
