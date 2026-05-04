// swift-tools-version: 6.0
import PackageDescription

// Proof-of-concept: a tiny executable that uses trycua/cua's CuaDriverCore
// for screenshot capture, replacing the `screencapture(1)` subprocess in
// src/helper.swift. Once the pattern is proven for screenshots we'll port
// the rest of the helper commands.
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
