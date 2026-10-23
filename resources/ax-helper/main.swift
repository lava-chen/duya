// ax-helper main.swift — duya macOS AX helper (plan 572).
//
// A resident CLI speaking one JSON line per request on stdin, one JSON
// line per response on stdout, plus {"ready":true} at startup and
// {"type":"heartbeat"} every 30s (the daemon dead-man watches it).
//
// AX discipline (docs/references/macos-accessibility-research.md §1.7):
//   - every AX call is synchronous cross-process Mach IPC; a busy
//     target app can block the caller. We set a global messaging
//     timeout (AXUIElementSetMessagingTimeout on the systemwide
//     element, 0.5s) at startup so wedged apps surface as
//     kAXErrorCannotComplete instead of hanging us, AND we run every
//     op on a dedicated queue behind a wall-clock race — double
//     insurance. Never touch AX from the Electron main process.
//
// Coordinate space: all positions/sizes are global screen points,
// top-left origin (kAXPositionAttribute / CGWindowBounds native
// space) — the JS side converts to/from capture pixels.

import Foundation
import ApplicationServices
import CoreGraphics
import AppKit

// MARK: - JSON plumbing

let outQueue = DispatchQueue(label: "duya.ax-helper.out")

func emit(_ payload: [String: Any]) {
    outQueue.async {
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.fragmentsAllowed]) else {
            return
        }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}

func err(_ code: String, _ message: String) -> [String: Any] {
    return ["ok": false, "error": ["code": code, "message": message]]
}

// MARK: - AX helpers

/// Global messaging timeout for every AX call in this process (seconds).
let AX_MESSAGING_TIMEOUT: Float = 0.5
/// Wall-clock budget for one request beyond which the caller gets `timeout`.
let REQUEST_WALL_CLOCK_BUDGET: Double = 2.5

let axQueue = DispatchQueue(label: "duya.ax-helper.ax", qos: .userInitiated)

var trustedSystemWide: AXUIElement? = {
    let el = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(el, AX_MESSAGING_TIMEOUT)
    return el
}()

func requireAxTrust() -> [String: Any]? {
    if AXIsProcessTrusted() { return nil }
    return err("permission-denied", "the DUYA app is not in the Accessibility TCC list — grant it in System Settings and retry")
}

func axErrorToCode(_ error: AXError) -> (String, String) {
    switch error {
    case .apiDisabled:
        return ("permission-denied", "process is not in the Accessibility TCC list (AXIsProcessTrusted == false)")
    case .cannotComplete:
        return ("timeout", "target application did not answer the AX call in time")
    case .invalidUIElement:
        return ("error", "the AXUIElement is no longer valid (app quit or element destroyed)")
    case .noValue:
        return ("no-value", "attribute has no value")
    case .attributeUnsupported:
        return ("unsupported", "attribute unsupported by the target element")
    default:
        return ("error", "AXError \(error.rawValue)")
    }
}

func getString(_ element: AXUIElement, _ attr: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success else { return nil }
    return value as? String
}

func getBool(_ element: AXUIElement, _ attr: String) -> Bool? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success else { return nil }
    return value as? Bool
}

func getElements(_ element: AXUIElement, _ attr: String) -> [AXUIElement] {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success else { return [] }
    guard let array = value as? [AXUIElement] else { return [] }
    return array
}

func getPoint(_ element: AXUIElement, _ attr: String) -> CGPoint? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success else { return nil }
    guard CFGetTypeID(value!) == AXValueGetTypeID() else { return nil }
    let axv = unsafeBitCast(value!, to: AXValue.self)
    var point = CGPoint.zero
    guard AXValueGetValue(axv, .cgPoint, &point) else { return nil }
    return point
}

func getSize(_ element: AXUIElement, _ attr: String) -> CGSize? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success else { return nil }
    guard CFGetTypeID(value!) == AXValueGetTypeID() else { return nil }
    let axv = unsafeBitCast(value!, to: AXValue.self)
    var size = CGSize.zero
    guard AXValueGetValue(axv, .cgSize, &size) else { return nil }
    return size
}

// MARK: - Element → JSON

let kRole = kAXRoleAttribute as String
let kSubrole = kAXSubroleAttribute as String
let kTitle = kAXTitleAttribute as String
let kDescription = kAXDescriptionAttribute as String
let kValue = kAXValueAttribute as String
let kPosition = kAXPositionAttribute as String
let kSize = kAXSizeAttribute as String
let kEnabled = kAXEnabledAttribute as String
let kChildren = kAXChildrenAttribute as String
let kWindows = kAXWindowsAttribute as String
let kIdentifier = "AXIdentifier"

func elementJSON(_ element: AXUIElement) -> [String: Any] {
    var out: [String: Any] = [:]
    let role = getString(element, kRole) ?? ""
    if !role.isEmpty { out["role"] = role }
    if let subrole = getString(element, kSubrole), !subrole.isEmpty { out["subrole"] = subrole }
    var name = getString(element, kTitle) ?? ""
    if name.isEmpty {
        // Icon-only buttons carry their label in the description attribute.
        name = getString(element, kDescription) ?? ""
    }
    if !name.isEmpty { out["name"] = name }
    // AXSecureField: reading kAXValue is impossible by design — only flag it.
    if role == "AXSecureField" {
        out["isPassword"] = true
    } else if let v = getString(element, kValue), !v.isEmpty {
        out["value"] = String(v.prefix(200))
    }
    if let pos = getPoint(element, kPosition), let size = getSize(element, kSize) {
        out["rect"] = ["x": pos.x, "y": pos.y, "w": size.width, "h": size.height]
    }
    if let enabled = getBool(element, kEnabled) {
        out["enabled"] = enabled
    }
    if let ident = getString(element, kIdentifier), !ident.isEmpty {
        out["automationId"] = ident
    }
    return out
}

// MARK: - enumerate

struct WalkBudget {
    var deadline: Date
    var nodes: Int
    var maxNodes: Int
    mutating func consume() -> Bool {
        nodes += 1
        return nodes <= maxNodes && Date() < deadline
    }
}

func enumerateOp(_ req: [String: Any]) -> [String: Any] {
    if let denied = requireAxTrust() { return denied }
    guard let pid = req["pid"] as? Int, pid > 0 else {
        return err("error", "enumerate requires a pid")
    }
    let maxDepth = (req["maxDepth"] as? Int) ?? 40
    let maxNodes = (req["maxNodes"] as? Int) ?? 500
    let roleFilter = (req["roles"] as? [String]) ?? defaultInteractiveRoles
    let appElement = AXUIElementCreateApplication(pid_t(pid))
    let windows = getElements(appElement, kWindows)
    let roots = windows.isEmpty ? [appElement] : windows

    var out: [[String: Any]] = []
    var truncated = false
    var reason: String? = nil
    var budget = WalkBudget(deadline: Date().addingTimeInterval(1.5), nodes: 0, maxNodes: maxNodes)

    func walk(_ element: AXUIElement, _ depth: Int) {
        if depth > maxDepth || Date() >= budget.deadline {
            truncated = truncated || Date() >= budget.deadline
            return
        }
        let role = getString(element, kRole) ?? ""
        let interactive = roleFilter.contains(role)
        if interactive {
            if !budget.consume() {
                truncated = true
                return
            }
            var json = elementJSON(element)
            json["interactive"] = true
            out.append(json)
        }
        for child in getElements(element, kChildren) {
            walk(child, depth + 1)
            if Date() >= budget.deadline {
                truncated = true
                return
            }
        }
    }

    for root in roots {
        walk(root, 0)
    }
    if out.isEmpty {
        // An empty tree usually means the app has not built its
        // accessibility tree yet (Chromium/Electron). Surface the
        // qualifier for diagnostics and allow a later scan to retry.
        reason = "empty-tree"
    }
    return [
        "ok": true,
        "elements": out,
        "truncated": truncated,
        "reason": reason ?? NSNull(),
    ]
}

let defaultInteractiveRoles = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton",
    "AXMenuItem", "AXTextField", "AXSecureField", "AXTextArea", "AXComboBox",
    "AXSlider", "AXLink", "AXRow", "AXStaticText",
]

// MARK: - probe

func probeOp(_ req: [String: Any]) -> [String: Any] {
    if let denied = requireAxTrust() { return denied }
    guard let x = req["x"] as? Double, let y = req["y"] as? Double,
          let systemWide = trustedSystemWide else {
        return err("error", "probe requires x/y")
    }
    var result: AXUIElement?
    let axErr = AXUIElementCopyElementAtPosition(systemWide, Float(x), Float(y), &result)
    guard axErr == .success, let hit = result else {
        let (code, message) = axErrorToCode(axErr)
        if axErr == .noValue {
            return ["ok": true, "element": NSNull()]
        }
        return err(code, message)
    }
    return ["ok": true, "element": elementJSON(hit)]
}

// MARK: - foreground window snapshot

func windowBoundsToJSON(_ dict: [String: Any]) -> [String: Any] {
    // kCGWindowBounds is a CGRect dictionary: {X, Y, Width, Height} in points.
    let x = (dict["X"] as? NSNumber)?.doubleValue ?? 0
    let y = (dict["Y"] as? NSNumber)?.doubleValue ?? 0
    let w = (dict["Width"] as? NSNumber)?.doubleValue ?? 0
    let h = (dict["Height"] as? NSNumber)?.doubleValue ?? 0
    return ["x": x, "y": y, "w": w, "h": h]
}

func fgOp() -> [String: Any] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
        return ["ok": true, "fg": NSNull()]
    }
    // Topmost layer-0 on-screen window = the foreground window. This
    // avoids NSWorkspace.frontmostApplication's frozen cache in
    // runloop-less processes (Hunch benchmark pitfall).
    for window in list {
        guard (window["kCGWindowLayer"] as? Int) == 0 else { continue }
        let bounds = windowBoundsToJSON((window["kCGWindowBounds"] as? [String: Any]) ?? [:])
        if (bounds["w"] as? Double ?? 0) <= 1 || (bounds["h"] as? Double ?? 0) <= 1 {
            continue
        }
        guard let pid = window["kCGWindowOwnerPID"] as? Int, pid > 0 else { continue }
        let windowId = (window["kCGWindowNumber"] as? Int) ?? 0
        let ownerName = (window["kCGWindowOwnerName"] as? String) ?? ""
        let title = (window["kCGWindowName"] as? String) ?? ""
        let processName = NSRunningApplication(processIdentifier: pid_t(pid))?.localizedName ?? ownerName
        let fg: [String: Any] = [
            "windowId": windowId,
            "pid": pid,
            "processName": processName,
            "title": title,
        ]
        return ["ok": true, "fg": fg]
    }
    return ["ok": true, "fg": NSNull()]
}

// MARK: - permissions / secure input

func permissionsOp() -> [String: Any] {
    // AXIsProcessTrusted (no prompt): TCC attributes the check to the
    // responsible process — the app bundle that spawned us.
    let accessibility = AXIsProcessTrusted() ? "granted" : "denied"
    var screen = "not-determined"
    var listen = "not-determined"
    if CGPreflightScreenCaptureAccess() {
        screen = "granted"
    } else {
        screen = "denied"
    }
    if CGPreflightListenEventAccess() {
        listen = "granted"
    } else {
        listen = "denied"
    }
    var permissions: [String: Any] = [
        "accessibility": accessibility,
        "screen": screen,
        "listen": listen,
        "secureInputPid": NSNull(),
    ]
    if let securePid = secureInputPid() {
        permissions["secureInputPid"] = securePid
    }
    return ["ok": true, "permissions": permissions]
}

func secureInputOp() -> [String: Any] {
    var secure: [String: Any] = ["enabled": false, "pid": NSNull()]
    if let pid = secureInputPid() {
        secure = ["enabled": true, "pid": pid]
    }
    return ["ok": true, "secureInput": secure]
}

/// kCGSSessionSecureInputPID from the current session dictionary — the
/// public-API way to detect Secure Input (alexwlchan.net/2021/secure-input).
func secureInputPid() -> Int? {
    guard let dict = CGSessionCopyCurrentDictionary() as? [String: Any] else { return nil }
    // The key arrives as CFString "kCGSSessionSecureInputPID"; value is
    // a CFNumber in some macOS versions and a string in others.
    if let n = dict["kCGSSessionSecureInputPID"] as? Int {
        return n
    }
    if let s = dict["kCGSSessionSecureInputPID"] as? String {
        return Int(s)
    }
    return nil
}

// MARK: - readUrl (AppleScript dictionaries)

func readUrlOp(_ req: [String: Any]) -> [String: Any] {
    guard let app = req["app"] as? String, !app.isEmpty else {
        return err("error", "readUrl requires an app name")
    }
    guard let script = urlScript(for: app) else {
        return err("no-url", "no AppleScript URL dictionary for \(app)")
    }
    let osascript = Process()
    osascript.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    osascript.arguments = ["-e", script]
    let pipe = Pipe()
    osascript.standardOutput = pipe
    osascript.standardError = Pipe()
    do {
        try osascript.run()
    } catch {
        return err("error", "osascript failed to start: \(error.localizedDescription)")
    }
    let waited = osascript.waitUntilExit(withTimeout: 2.0)
    guard waited, osascript.terminationStatus == 0 else {
        if osascript.isRunning {
            osascript.terminate()
            return err("timeout", "osascript did not answer within 2s")
        }
        // -1743 errAEEventNotPermitted = the Apple Events prompt was denied.
        return err("applescript-denied", "Apple Events permission missing or the app has no windows")
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    let url = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if url.isEmpty {
        return ["ok": true, "url": NSNull()]
    }
    return ["ok": true, "url": url]
}

extension Process {
    func waitUntilExit(withTimeout timeout: TimeInterval) -> Bool {
        let expectation = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            self.waitUntilExit()
            expectation.signal()
        }
        if expectation.wait(timeout: .now() + timeout) == .timedOut {
            return false
        }
        return true
    }
}

func urlScript(for app: String) -> String? {
    let name = app.trimmingCharacters(in: .whitespaces).lowercased()
    // Safari uses a different dictionary than the Chromium family.
    if name == "safari" {
        return "tell application \"Safari\" to if (count of documents) > 0 then get URL of front document"
    }
    let chromium: [String: String] = [
        "google chrome": "Google Chrome",
        "chrome": "Google Chrome",
        "microsoft edge": "Microsoft Edge",
        "msedge": "Microsoft Edge",
        "edge": "Microsoft Edge",
        "brave browser": "Brave Browser",
        "brave": "Brave Browser",
        "arc": "Arc",
        "vivaldi": "Vivaldi",
        "opera": "Opera",
        "dia": "Dia",
    ]
    guard let target = chromium[name] else { return nil }
    return "tell application \"\(target)\" to if (count of windows) > 0 then get URL of active tab of front window"
}

// MARK: - dispatch

func dispatch(_ req: [String: Any]) -> [String: Any] {
    let op = req["op"] as? String ?? ""
    switch op {
    case "ping":
        return ["ok": true]
    case "permissions":
        return permissionsOp()
    case "fg":
        return fgOp()
    case "secureInput":
        return secureInputOp()
    case "enumerate":
        return enumerateOp(req)
    case "probe":
        return probeOp(req)
    case "readUrl":
        return readUrlOp(req)
    default:
        return err("unsupported", "unknown op \(op)")
    }
}

/// Run one request on the AX queue behind a wall-clock race. A timed-out
/// op may still complete later; its response is dropped (seq guard).
func handleRequest(_ req: [String: Any]) {
    guard let id = req["id"] as? Int else { return }
    var answered = false
    let lock = NSLock()
    let semaphore = DispatchSemaphore(value: 0)
    axQueue.async {
        let response = dispatch(req)
        lock.lock()
        let first = !answered
        answered = true
        lock.unlock()
        if first {
            var payload = response
            payload["id"] = id
            emit(payload)
            semaphore.signal()
        }
    }
    if semaphore.wait(timeout: .now() + REQUEST_WALL_CLOCK_BUDGET) == .timedOut {
        lock.lock()
        let first = !answered
        answered = true
        lock.unlock()
        if first {
            emit(["id": id, "ok": false, "error": ["code": "timeout", "message": "request exceeded the wall-clock budget"]])
        }
    }
}

// MARK: - main loop

func main() {
    // Ready line first (the client waits for it), then heartbeats for
    // the daemon dead-man.
    emit(["ready": true])
    let heartbeat = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
    heartbeat.schedule(deadline: .now() + 30, repeating: 30)
    heartbeat.setEventHandler {
        emit(["type": "heartbeat"])
    }
    heartbeat.resume()

    while true {
        guard let line = readLine(strippingNewline: true) else {
            // stdin EOF — the parent is gone; exit quietly.
            exit(0)
        }
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { continue }
        guard let data = trimmed.data(using: .utf8),
              let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            emit(err("error", "unparseable request line"))
            continue
        }
        handleRequest(req)
    }
}

main()
