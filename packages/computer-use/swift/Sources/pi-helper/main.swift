import AppKit
import ApplicationServices
import CoreGraphics
import CuaDriverCore
import Foundation

// IPC sentinel — mirrors the legacy script-mode helper so the existing
// Node IPC layer (src/ipc.ts) parses the response identically.
let JSON_SENTINEL = "===PI_HELPER_JSON==="

// MARK: - Output / errors

func sanitize(_ obj: Any) -> Any {
    if let d = obj as? Double {
        if d.isNaN || d.isInfinite { return 0 }
        return d
    }
    if let arr = obj as? [Any] { return arr.map(sanitize) }
    if let dict = obj as? [String: Any] {
        var out: [String: Any] = [:]
        for (k, v) in dict { out[k] = sanitize(v) }
        return out
    }
    return obj
}

func emit(_ obj: [String: Any]) {
    let safe = sanitize(obj)
    print(JSON_SENTINEL)
    do {
        let data = try JSONSerialization.data(withJSONObject: safe, options: [.prettyPrinted])
        if let s = String(data: data, encoding: .utf8) { print(s) }
    } catch {
        let fallback =
            "{\"ok\":false,\"error\":\"JSON serialization failed: \(error.localizedDescription)\"}"
        print(fallback)
    }
}

func fail(_ msg: String) -> Never {
    emit(["ok": false, "error": msg])
    exit(1)
}

// MARK: - Accessibility preflight

func ensureAXTrusted() {
    // Hardcoded key avoids importing the framework's mutable global var
    // `kAXTrustedCheckOptionPrompt`, which trips Swift 6 strict concurrency.
    // Value is stable across macOS versions ("AXTrustedCheckOptionPrompt").
    let opts = ["AXTrustedCheckOptionPrompt": false] as CFDictionary
    if !AXIsProcessTrustedWithOptions(opts) {
        fail(
            "Accessibility permission not granted. Grant access in System Settings → Privacy & Security → Accessibility for the host running this helper (e.g. Terminal/iTerm/Node)."
        )
    }
}

// MARK: - App activation

func appByBundle(_ bundle: String) -> NSRunningApplication? {
    NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == bundle }
}

func activate(_ bundle: String) -> NSRunningApplication {
    if let app = appByBundle(bundle) {
        if #available(macOS 14.0, *) {
            app.activate()
        } else {
            app.activate(options: [.activateIgnoringOtherApps])
        }
        usleep(300_000)
        return app
    }
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else {
        fail("Could not find application for bundle id \(bundle)")
    }
    let conf = NSWorkspace.OpenConfiguration()
    conf.activates = true
    let sem = DispatchSemaphore(value: 0)
    var ra: NSRunningApplication?
    var er: Error?
    NSWorkspace.shared.openApplication(at: url, configuration: conf) { app, error in
        ra = app
        er = error
        sem.signal()
    }
    _ = sem.wait(timeout: .now() + 5)
    if let app = ra {
        usleep(700_000)
        return app
    }
    fail("Could not activate app \(bundle): \(er?.localizedDescription ?? "unknown")")
}

// MARK: - AX helpers

func val(_ el: AXUIElement, _ attr: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success ? v : nil
}

func strAttr(_ el: AXUIElement, _ attr: String) -> String? { val(el, attr) as? String }
func boolAttr(_ el: AXUIElement, _ attr: String) -> Bool? { val(el, attr) as? Bool }

func axElement(_ obj: AnyObject?) -> AXUIElement? {
    guard let obj = obj else { return nil }
    guard CFGetTypeID(obj) == AXUIElementGetTypeID() else { return nil }
    return (obj as! AXUIElement)
}

func frameOf(_ el: AXUIElement) -> [String: Double]? {
    guard
        let po = val(el, kAXPositionAttribute),
        let so = val(el, kAXSizeAttribute),
        CFGetTypeID(po) == AXValueGetTypeID(),
        CFGetTypeID(so) == AXValueGetTypeID()
    else { return nil }
    let p = po as! AXValue
    let s = so as! AXValue
    var pt = CGPoint.zero
    var sz = CGSize.zero
    guard AXValueGetValue(p, .cgPoint, &pt), AXValueGetValue(s, .cgSize, &sz) else { return nil }
    return [
        "x": Double(pt.x), "y": Double(pt.y), "width": Double(sz.width),
        "height": Double(sz.height),
    ]
}

func actions(_ el: AXUIElement) -> [String] {
    var a: CFArray?
    if AXUIElementCopyActionNames(el, &a) == .success {
        return (a as? [String]) ?? []
    }
    return []
}

func appElement(_ pid: pid_t) -> AXUIElement { AXUIElementCreateApplication(pid) }

func focusedWindow(_ appEl: AXUIElement) -> AXUIElement? {
    if let w = axElement(val(appEl, kAXFocusedWindowAttribute)) { return w }
    if let w = axElement(val(appEl, kAXMainWindowAttribute)) { return w }
    return nil
}

func textPreview(_ s: String?, _ n: Int = 220) -> String? {
    guard let s = s, !s.isEmpty else { return nil }
    let collapsed =
        s
        .replacingOccurrences(of: "\n", with: " ")
        .replacingOccurrences(of: "\r", with: " ")
    let flat = collapsed.split(whereSeparator: { $0 == " " || $0 == "\t" }).joined(separator: " ")
    return flat.count > n ? String(flat.prefix(n)) + "…" : flat
}

// MARK: - Tree walk

// Single-threaded helper, but Swift 6 strict concurrency demands the marker.
nonisolated(unsafe) var elements: [[String: Any]] = []
nonisolated(unsafe) var elementRefs: [AXUIElement] = []

func walk(_ el: AXUIElement, depth: Int, maxDepth: Int, maxCount: Int) {
    if elements.count >= maxCount || depth > maxDepth { return }
    let role = strAttr(el, kAXRoleAttribute) ?? ""
    let title = strAttr(el, kAXTitleAttribute)
    let desc = strAttr(el, kAXDescriptionAttribute)
    let ident = strAttr(el, kAXIdentifierAttribute)
    let value = (val(el, kAXValueAttribute) as? String)
    let acts = actions(el)
    let frame = frameOf(el)
    let useful =
        depth == 0
        || !role.isEmpty
        || title != nil
        || desc != nil
        || ident != nil
        || value != nil
        || !acts.isEmpty
    if useful {
        let idx = elements.count
        elements.append([
            "index": idx,
            "depth": depth,
            "role": role,
            "title": title as Any,
            "description": desc as Any,
            "identifier": ident as Any,
            "valuePreview": textPreview(value) as Any,
            "focused": boolAttr(el, kAXFocusedAttribute) as Any,
            "selected": boolAttr(el, kAXSelectedAttribute) as Any,
            "enabled": boolAttr(el, kAXEnabledAttribute) as Any,
            "frame": frame as Any,
            "actions": acts,
        ])
        elementRefs.append(el)
    }
    if let kids = val(el, kAXChildrenAttribute) as? [AXUIElement] {
        for c in kids { walk(c, depth: depth + 1, maxDepth: maxDepth, maxCount: maxCount) }
    }
}

// MARK: - Screenshot helpers

/// Capture the full main display via cua-driver's WindowCapture and return
/// the PNG-encoded blob plus pixel dimensions / scale factor. Used by the
/// `screenshot` subcommand.
func captureMainDisplayScreenshot() async throws -> (data: Data, width: Int, height: Int, scale: Double) {
    let shot = try await WindowCapture().captureMainDisplay(format: .png, quality: 95)
    return (shot.imageData, shot.width, shot.height, shot.scaleFactor)
}

/// Capture the frontmost layer-0 window of `pid` as a base64 PNG. Returns nil
/// when the pid has no shareable window (e.g. the app just launched and its
/// window backing isn't registered with SCShareableContent yet, or it's
/// menubar-only). We deliberately use `captureWindow(windowID:)` over
/// "capture full display + crop with CoreGraphics" because cua-driver already
/// resolves the right display's scale factor for the chosen window — the
/// crop-after-capture path would have to redo that work and would fail on
/// secondary displays where the AX frame doesn't match the main display.
func captureFrontmostWindowBase64(pid: Int32) async -> String? {
    guard let target = WindowCapture.selectFrontmostWindow(forPid: pid) else { return nil }
    do {
        let shot = try await WindowCapture().captureWindow(
            windowID: UInt32(target.id), format: .png, quality: 95
        )
        return shot.imageData.base64EncodedString()
    } catch {
        return nil
    }
}

// MARK: - Mouse / keyboard

func postClick(at loc: CGPoint, count: Int) {
    let clicks = max(1, count)
    // macOS double/triple-click is signalled by N consecutive down/up pairs
    // with escalating mouseEventClickState (1, 2, 3, …) fired within the
    // system double-click interval. Setting clickState=N on a single pair
    // does NOT register as a double-click for most Cocoa apps.
    for state in 1...clicks {
        let down = CGEvent(
            mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: loc,
            mouseButton: .left)
        let up = CGEvent(
            mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: loc,
            mouseButton: .left)
        down?.setIntegerValueField(.mouseEventClickState, value: Int64(state))
        up?.setIntegerValueField(.mouseEventClickState, value: Int64(state))
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }
}

func keyCode(_ k: String) -> Int? {
    let m: [String: Int] = [
        "Right": 124, "Left": 123, "Up": 126, "Down": 125,
        "Enter": 36, "Return": 36,
        "Escape": 53, "Esc": 53,
        "Tab": 48, "Space": 49,
        "Delete": 51, "Backspace": 51,
        "ForwardDelete": 117,
        "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121,
        "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97,
        "F7": 98, "F8": 100, "F9": 101, "F10": 109, "F11": 103, "F12": 111,
    ]
    return m[k]
}

func parseModifiers(_ s: String?) -> [String] {
    guard let s = s, !s.isEmpty else { return [] }
    var out: [String] = []
    for raw in s.split(whereSeparator: { $0 == "," || $0 == "+" || $0 == " " }) {
        let normalized: String
        switch raw.lowercased() {
        case "cmd", "command": normalized = "command"
        case "shift": normalized = "shift"
        case "alt", "opt", "option": normalized = "option"
        case "ctrl", "control": normalized = "control"
        default: continue
        }
        if !out.contains(normalized) { out.append(normalized) }
    }
    return out
}

func cgFlags(for mods: [String]) -> CGEventFlags {
    var flags: CGEventFlags = []
    for m in mods {
        switch m {
        case "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "option": flags.insert(.maskAlternate)
        case "control": flags.insert(.maskControl)
        default: break
        }
    }
    return flags
}

/// Synthesize a key down/up pair via CGEvent. Replaces the legacy
/// osascript-based `keystroke` path so no Automation permission is required.
func postKey(code: CGKeyCode, flags: CGEventFlags) {
    let src = CGEventSource(stateID: .combinedSessionState)
    let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)
    let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
    down?.flags = flags
    up?.flags = flags
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
}

// MARK: - Pasteboard snapshot/restore

struct PBItem {
    let representations: [(NSPasteboard.PasteboardType, Data)]
}

func snapshotPasteboard() -> [PBItem] {
    let pb = NSPasteboard.general
    var snaps: [PBItem] = []
    for item in pb.pasteboardItems ?? [] {
        var reps: [(NSPasteboard.PasteboardType, Data)] = []
        for type in item.types {
            if let data = item.data(forType: type) {
                reps.append((type, data))
            }
        }
        snaps.append(PBItem(representations: reps))
    }
    return snaps
}

func restorePasteboard(_ snaps: [PBItem]) {
    let pb = NSPasteboard.general
    pb.clearContents()
    var items: [NSPasteboardItem] = []
    for snap in snaps {
        let it = NSPasteboardItem()
        for (type, data) in snap.representations {
            it.setData(data, forType: type)
        }
        items.append(it)
    }
    if !items.isEmpty { pb.writeObjects(items) }
}

// MARK: - Argument parsing

func argOrFail(_ args: [String], _ idx: Int, _ what: String) -> String {
    if idx >= args.count { fail("missing argument: \(what)") }
    return args[idx]
}

// MARK: - Commands

func cmdListApps() {
    let apps = NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular }
        .map { app -> [String: Any] in
            [
                "name": app.localizedName ?? "",
                "bundleId": app.bundleIdentifier ?? "",
                "pid": Int(app.processIdentifier),
                "running": true,
            ]
        }
        .sorted { (($0["name"] as? String) ?? "") < (($1["name"] as? String) ?? "") }
    emit(["ok": true, "apps": apps])
}

func cmdScreenshot() async {
    do {
        let shot = try await captureMainDisplayScreenshot()
        emit([
            "ok": true,
            "screenshotBase64": shot.data.base64EncodedString(),
            "width": shot.width,
            "height": shot.height,
            "scaleFactor": shot.scale,
        ])
    } catch {
        fail("screenshot failed: \(error)")
    }
}

func cmdGetState(_ bundle: String) async {
    ensureAXTrusted()
    let app = activate(bundle)
    let ax = appElement(app.processIdentifier)
    guard let win = focusedWindow(ax) else {
        fail("No focused/main window for \(bundle).")
    }
    elements = []
    elementRefs = []
    walk(win, depth: 0, maxDepth: 8, maxCount: 220)
    let wf = frameOf(win)
    let shotB64 = await captureFrontmostWindowBase64(pid: app.processIdentifier)
    emit([
        "ok": true,
        "app": bundle,
        "appName": app.localizedName ?? "",
        "window": [
            "title": strAttr(win, kAXTitleAttribute) as Any,
            "frame": wf as Any,
        ],
        "elements": elements,
        "screenshotBase64": shotB64 as Any,
    ])
}

func cmdClick(_ args: [String]) {
    let bundle = argOrFail(args, 2, "bundle")
    let mode = argOrFail(args, 3, "mode (xy|element)")
    let valueArg = argOrFail(args, 4, "value")
    let count: Int = {
        if args.count > 5, let n = Int(args[5]), n > 0 { return n }
        return 1
    }()

    let app = activate(bundle)

    switch mode {
    case "xy":
        let parts = valueArg.split(separator: ",").map {
            String($0).trimmingCharacters(in: .whitespaces)
        }
        guard
            parts.count == 2,
            let x = Double(parts[0]), let y = Double(parts[1]),
            x.isFinite, y.isFinite
        else {
            fail("xy must be \"x,y\" with finite numbers; got \"\(valueArg)\"")
        }
        postClick(at: CGPoint(x: x, y: y), count: count)
        emit(["ok": true])
    case "element":
        ensureAXTrusted()
        let ax = appElement(app.processIdentifier)
        guard let win = focusedWindow(ax) else { fail("no window") }
        elements = []
        elementRefs = []
        walk(win, depth: 0, maxDepth: 8, maxCount: 220)
        guard let i = Int(valueArg), i >= 0, i < elementRefs.count else {
            fail("bad element index \(valueArg); have \(elementRefs.count) elements")
        }
        let el = elementRefs[i]
        var pressed = false
        if actions(el).contains(kAXPressAction) {
            for _ in 0..<count {
                let r = AXUIElementPerformAction(el, kAXPressAction as CFString)
                if r != .success {
                    pressed = false
                    break
                }
                pressed = true
                usleep(50_000)
            }
        }
        if !pressed {
            guard let f = frameOf(el) else { fail("AXPress failed and element has no frame") }
            let loc = CGPoint(x: f["x"]! + f["width"]! / 2, y: f["y"]! + f["height"]! / 2)
            postClick(at: loc, count: count)
        }
        usleep(300_000)
        emit(["ok": true])
    default:
        fail("unknown click mode \(mode)")
    }
}

func cmdKey(_ args: [String]) {
    let bundle = argOrFail(args, 2, "bundle")
    let key = argOrFail(args, 3, "key")
    let modsArg = args.count > 4 ? args[4] : nil
    guard let code = keyCode(key) else {
        fail(
            "unknown key \"\(key)\". Supported: Right,Left,Up,Down,Enter,Return,Escape,Tab,Space,Delete,Backspace,ForwardDelete,Home,End,PageUp,PageDown,F1..F12"
        )
    }
    _ = activate(bundle)
    let mods = parseModifiers(modsArg)
    postKey(code: CGKeyCode(code), flags: cgFlags(for: mods))
    emit(["ok": true])
}

func cmdType(_ args: [String]) {
    let bundle = argOrFail(args, 2, "bundle")
    let text = argOrFail(args, 3, "text")
    _ = activate(bundle)
    let snap = snapshotPasteboard()
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString(text, forType: .string)
    // Synthesize Cmd+V via CGEvent. The legacy helper used `osascript`
    // here, which required Automation permission; CGEvent only needs
    // Accessibility, which we already require for AX-touching commands.
    // virtualKey 9 == ANSI 'v'.
    postKey(code: CGKeyCode(9), flags: .maskCommand)
    // Wait for the paste to actually land before restoring the clipboard.
    usleep(500_000)
    restorePasteboard(snap)
    emit(["ok": true])
}

// MARK: - Main

@main
struct PiHelper {
    static func main() async {
        let args = CommandLine.arguments
        if args.count < 2 {
            fail("usage: pi-helper <list_apps|get_state|click|key|type|screenshot> ...")
        }
        switch args[1] {
        case "list_apps": cmdListApps()
        case "screenshot": await cmdScreenshot()
        case "get_state":
            if args.count < 3 { fail("missing bundle id") }
            await cmdGetState(args[2])
        case "click": cmdClick(args)
        case "key": cmdKey(args)
        case "type": cmdType(args)
        default: fail("unknown command \(args[1])")
        }
    }
}
