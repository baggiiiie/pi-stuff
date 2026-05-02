import AppKit
import ApplicationServices
import Foundation

// IPC sentinel so the TS side never has to guess where JSON starts.
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

// MARK: - Accessibility

func ensureAXTrusted() {
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: false] as CFDictionary
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
    // Collapse runs of whitespace so previews are not eaten by padding.
    let flat = collapsed.split(whereSeparator: { $0 == " " || $0 == "\t" }).joined(separator: " ")
    return flat.count > n ? String(flat.prefix(n)) + "…" : flat
}

// MARK: - Tree walk

var elements: [[String: Any]] = []
var elementRefs: [AXUIElement] = []

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

// MARK: - Screenshot

func screenshotBase64(_ rect: CGRect?) -> String? {
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("pi-computer-use-\(UUID().uuidString).png")
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    if let r = rect {
        p.arguments = [
            "-x", "-R",
            "\(Int(r.origin.x)),\(Int(r.origin.y)),\(Int(r.size.width)),\(Int(r.size.height))",
            tmp.path,
        ]
    } else {
        p.arguments = ["-x", tmp.path]
    }
    do {
        try p.run()
        p.waitUntilExit()
        if p.terminationStatus != 0 { return nil }
        let data = try Data(contentsOf: tmp)
        try? FileManager.default.removeItem(at: tmp)
        return data.base64EncodedString()
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

/// Runs an AppleScript and returns nil on success, or a human-readable error
/// message on failure. Never calls `fail()` so callers can clean up first.
func tryOSA(_ script: String) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    p.arguments = ["-e", script]
    // Discard stdout so the child can never block on a full pipe.
    p.standardOutput = FileHandle.nullDevice
    let errPipe = Pipe()
    p.standardError = errPipe

    // Drain stderr concurrently so >64KB output cannot deadlock waitUntilExit.
    var errData = Data()
    let group = DispatchGroup()
    group.enter()
    DispatchQueue.global(qos: .userInitiated).async {
        errData = errPipe.fileHandleForReading.readDataToEndOfFile()
        group.leave()
    }

    do {
        try p.run()
    } catch {
        return "osascript failed to launch: \(error.localizedDescription)"
    }
    p.waitUntilExit()
    group.wait()

    if p.terminationStatus != 0 {
        let msg =
            String(data: errData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? ""
        let detail = msg.isEmpty ? "exit \(p.terminationStatus)" : msg
        return
            "osascript failed: \(detail). If this mentions \"not allowed\", grant Automation permission to the host app under System Settings → Privacy & Security → Automation."
    }
    return nil
}

/// Convenience wrapper for callers with no clean-up to do.
func runOSA(_ script: String) {
    if let err = tryOSA(script) { fail(err) }
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

func cmdGetState(_ bundle: String) {
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
    var rect: CGRect? = nil
    if let f = wf, let x = f["x"], let y = f["y"], let w = f["width"], let h = f["height"] {
        rect = CGRect(x: x, y: y, width: w, height: h)
    }
    emit([
        "ok": true,
        "app": bundle,
        "appName": app.localizedName ?? "",
        "window": [
            "title": strAttr(win, kAXTitleAttribute) as Any,
            "frame": wf as Any,
        ],
        "elements": elements,
        "screenshotBase64": screenshotBase64(rect) as Any,
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
    let script: String
    if mods.isEmpty {
        script = "tell application \"System Events\" to key code \(code)"
    } else {
        let modList = mods.map { "\($0) down" }.joined(separator: ", ")
        script = "tell application \"System Events\" to key code \(code) using {\(modList)}"
    }
    runOSA(script)
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
    let osaErr = tryOSA("tell application \"System Events\" to keystroke \"v\" using command down")
    if osaErr == nil {
        // Wait for the paste to actually land before restoring the clipboard.
        usleep(500_000)
    }
    restorePasteboard(snap)
    if let err = osaErr { fail(err) }
    emit(["ok": true])
}

// MARK: - Main

let args = CommandLine.arguments
if args.count < 2 {
    fail("usage: helper.swift <list_apps|get_state|click|key|type> ...")
}

switch args[1] {
case "list_apps": cmdListApps()
case "get_state":
    if args.count < 3 { fail("missing bundle id") }
    cmdGetState(args[2])
case "click": cmdClick(args)
case "key": cmdKey(args)
case "type": cmdType(args)
default: fail("unknown command \(args[1])")
}
