import CuaDriverCore
import Foundation

// IPC sentinel — mirrors helper.swift so the existing Node IPC layer
// (src/ipc.ts) parses the response identically.
let JSON_SENTINEL = "===PI_HELPER_JSON==="

func emit(_ obj: [String: Any]) {
    print(JSON_SENTINEL)
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted]),
       let s = String(data: data, encoding: .utf8) {
        print(s)
    } else {
        print("{\"ok\":false,\"error\":\"JSON serialization failed\"}")
    }
}

func fail(_ msg: String) -> Never {
    emit(["ok": false, "error": msg])
    exit(1)
}

func cmdScreenshot() async {
    do {
        let shot = try await WindowCapture().captureMainDisplay(format: .png, quality: 95)
        emit([
            "ok": true,
            "screenshotBase64": shot.imageData.base64EncodedString(),
            "width": shot.width,
            "height": shot.height,
            "scaleFactor": shot.scaleFactor,
        ])
    } catch {
        fail("screenshot failed: \(error)")
    }
}

@main
struct PiHelper {
    static func main() async {
        let args = CommandLine.arguments
        if args.count < 2 {
            fail("usage: pi-helper screenshot")
        }
        switch args[1] {
        case "screenshot": await cmdScreenshot()
        default: fail("unknown command \(args[1])")
        }
    }
}
