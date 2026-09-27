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

/// Join an AXWindow to its CGWindowID by bounds matching against
/// CGWindowList (AXUIElementGetWindow is not exported by the CLT 13.1
/// SDK's tbd). Returns nil when the match is ambiguous — callers treat
/// that as "window not found".
func resolveWindowId(_ window: AXUIElement, pid: Int) -> UInt32? {
    guard let pos = getPoint(window, kPosition), let size = getSize(window, kSize) else { return nil }
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return nil }
    var matches: [UInt32] = []
    for entry in list {
        guard (entry["kCGWindowLayer"] as? Int) == 0 else { continue }
        guard (entry["kCGWindowOwnerPID"] as? Int) == pid else { continue }
        let b = entry["kCGWindowBounds"] as? [String: Any] ?? [:]
        let x = (b["X"] as? NSNumber)?.doubleValue ?? -1
        let y = (b["Y"] as? NSNumber)?.doubleValue ?? -1
        let w = (b["Width"] as? NSNumber)?.doubleValue ?? -1
        let h = (b["Height"] as? NSNumber)?.doubleValue ?? -1
        if abs(x - pos.x) < 0.5 && abs(y - pos.y) < 0.5
            && abs(w - size.width) < 0.5 && abs(h - size.height) < 0.5 {
            if let wid = (entry["kCGWindowNumber"] as? NSNumber)?.uint32Value {
                matches.append(wid)
            }
        }
    }
    return matches.count == 1 ? matches[0] : nil
}

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
        return ("stale-handle", "the AXUIElement is no longer valid (app quit or element destroyed)")
    case .noValue:
        return ("no-value", "attribute has no value")
    case .attributeUnsupported:
        return ("unsupported", "attribute unsupported by the target element")
    case .actionUnsupported:
        return ("unsupported", "action unsupported by the target element")
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

func getElement(_ element: AXUIElement, _ attr: String) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success else { return nil }
    // AXUIElement attribute payloads come back as AXUIElementRef.
    let raw = value!
    if CFGetTypeID(raw) == AXUIElementGetTypeID() {
        return (raw as! AXUIElement)
    }
    return nil
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

func getActionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return (names as? [String]) ?? []
}

// MARK: - Snapshot handle registry

/// Opaque short-lived element handles (plan 572 D3): every
/// enumerate/probe registers the elements it returned; actions resolve
/// through this table. Bounded — the oldest entries are evicted.
var handleRegistry: [String: (element: AXUIElement, seq: Int)] = [:]
var handleSeq = 0
let registryLock = NSLock()
let REGISTRY_CAP = 4096

func registerHandle(_ element: AXUIElement) -> String {
    registryLock.lock()
    defer { registryLock.unlock() }
    handleSeq += 1
    let handle = "h\(handleSeq)"
    handleRegistry[handle] = (element, handleSeq)
    if handleRegistry.count > REGISTRY_CAP {
        // Evict the oldest quarter (seq-ordered scan; registry is small).
        let cutoff = handleSeq - REGISTRY_CAP + REGISTRY_CAP / 4
        handleRegistry = handleRegistry.filter { $0.value.seq >= cutoff }
    }
    return handle
}

func resolveHandle(_ handle: String) -> AXUIElement? {
    registryLock.lock()
    defer { registryLock.unlock() }
    return handleRegistry[handle]?.element
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
let kFocused = kAXFocusedAttribute as String

func elementJSON(_ element: AXUIElement, register: Bool) -> [String: Any] {
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
    let actions = getActionNames(element)
    if !actions.isEmpty { out["actions"] = actions }
    if register {
        out["handle"] = registerHandle(element)
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
    let windowId = req["windowId"] as? Int

    let appElement = AXUIElementCreateApplication(pid_t(pid))
    var roots: [AXUIElement] = []
    if let wid = windowId {
        // Target one window: join AX windows to CGWindowIDs via bounds
        // matching (AXUIElementGetWindow is unavailable on this SDK).
        for window in getElements(appElement, kWindows) {
            if resolveWindowId(window, pid: pid) == UInt32(wid) {
                roots.append(window)
                break
            }
        }
        if roots.isEmpty {
            return err("stale-handle", "window \(wid) not found under pid \(pid)")
        }
    } else {
        let windows = getElements(appElement, kWindows)
        roots = windows.isEmpty ? [appElement] : windows
    }

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
            var json = elementJSON(element, register: true)
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
        // qualifier so the client can drive the AXManualAccessibility
        // recipe and retry.
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
    // The CF out-param reference is kept alive by the handle registry
    // (bounded at REGISTRY_CAP entries — the helper is short-lived, so
    // the bounded leak is intentional).
    return ["ok": true, "element": elementJSON(hit, register: true)]
}

// MARK: - action / setValue / manualAccessibility

func actionOp(_ req: [String: Any]) -> [String: Any] {
    if let denied = requireAxTrust() { return denied }
    guard let handle = req["handle"] as? String, let action = req["action"] as? String,
          let element = resolveHandle(handle) else {
        return err("stale-handle", "unknown handle \(req["handle"] ?? "?")")
    }
    let axErr = AXUIElementPerformAction(element, action as CFString)
    guard axErr == .success else {
        let (code, message) = axErrorToCode(axErr)
        return err(code, message)
    }
    return ["ok": true, "performed": true]
}

func setValueOp(_ req: [String: Any]) -> [String: Any] {
    if let denied = requireAxTrust() { return denied }
    guard let handle = req["handle"] as? String, let value = req["value"] as? String,
          let element = resolveHandle(handle) else {
        return err("stale-handle", "unknown handle \(req["handle"] ?? "?")")
    }
    var settable: DarwinBoolean = false
    guard AXUIElementIsAttributeSettable(element, kValue as CFString, &settable) == .success else {
        return err("error", "IsAttributeSettable failed")
    }
    guard settable.boolValue else {
        return err("not-settable", "kAXValue is not settable on this element")
    }
    let axErr = AXUIElementSetAttributeValue(element, kValue as CFString, value as CFTypeRef)
    guard axErr == .success else {
        let (code, message) = axErrorToCode(axErr)
        return err(code, message)
    }
    return ["ok": true, "set": true]
}

func manualAccessibilityOp(_ req: [String: Any]) -> [String: Any] {
    guard let pid = req["pid"] as? Int, pid > 0 else {
        return err("error", "manualAccessibility requires a pid")
    }
    let appElement = AXUIElementCreateApplication(pid_t(pid))
    let axErr = AXUIElementSetAttributeValue(
        appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    return ["ok": true, "manualAccessibility": axErr == .success]
}

// MARK: - window / app queries (no AX trust required)

func windowBoundsToJSON(_ dict: [String: Any]) -> [String: Any] {
    // kCGWindowBounds is a CGRect dictionary: {X, Y, Width, Height} in points.
    let x = (dict["X"] as? NSNumber)?.doubleValue ?? 0
    let y = (dict["Y"] as? NSNumber)?.doubleValue ?? 0
    let w = (dict["Width"] as? NSNumber)?.doubleValue ?? 0
    let h = (dict["Height"] as? NSNumber)?.doubleValue ?? 0
    return ["x": x, "y": y, "w": w, "h": h]
}

func windowsOp(_ req: [String: Any]) -> [String: Any] {
    guard let pid = req["pid"] as? Int, pid > 0 else {
        return err("error", "windows requires a pid")
    }
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
        return ["ok": true, "windows": []]
    }
    var out: [[String: Any]] = []
    for window in list {
        guard (window["kCGWindowLayer"] as? Int) == 0 else { continue }
        guard (window["kCGWindowOwnerPID"] as? Int) == pid else { continue }
        let windowId = (window["kCGWindowNumber"] as? Int) ?? 0
        let entry: [String: Any] = [
            "windowId": windowId,
            "pid": pid,
            "ownerName": (window["kCGWindowOwnerName"] as? String) ?? "",
            // kCGWindowName is only present WITH Screen Recording —
            // degrade to empty, never fail the op.
            "title": (window["kCGWindowName"] as? String) ?? "",
            "bounds": windowBoundsToJSON((window["kCGWindowBounds"] as? [String: Any]) ?? [:]),
        ]
        out.append(entry)
    }
    return ["ok": true, "windows": out]
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

func appsOp() -> [String: Any] {
    let apps = NSWorkspace.shared.runningApplications.filter {
        $0.activationPolicy == .regular
    }
    let out: [[String: Any]] = apps.map { app in
        [
            "pid": app.processIdentifier,
            "name": app.localizedName ?? "",
            "bundleId": app.bundleIdentifier ?? NSNull(),
            "isActive": app.isActive,
        ]
    }
    return ["ok": true, "apps": out]
}

func activateOp(_ req: [String: Any]) -> [String: Any] {
    guard let pid = req["pid"] as? Int, pid > 0,
          let app = NSRunningApplication(processIdentifier: pid_t(pid)) else {
        return err("error", "no running app for pid \(req["pid"] ?? 0)")
    }
    // activate(options:) is deprecated on macOS 14 but the replacement
    // activate(from:options:) needs a requesting app context we do not
    // have from a CLI; the deprecated path keeps working.
    let ok = app.activate(options: [.activateIgnoringOtherApps])
    // Raise the app's AX windows too — activation alone can leave the
    // wanted window behind others.
    if ok {
        let appElement = AXUIElementCreateApplication(pid_t(pid))
        for window in getElements(appElement, kWindows) {
            AXUIElementPerformAction(window, "AXRaise" as CFString)
        }
    }
    return ["ok": true, "activated": ok]
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

// MARK: - background delivery (CGEventPostToPid)

func keyToPidOp(_ req: [String: Any]) -> [String: Any] {
    guard let pid = req["pid"] as? Int, pid > 0, let vk = req["vk"] as? Int else {
        return err("error", "keyToPid requires pid + vk")
    }
    let flags = (req["flags"] as? [String]) ?? []
    var mask: CGEventFlags = []
    for f in flags {
        switch f.lowercased() {
        case "cmd", "meta": mask.insert(.maskCommand)
        case "ctrl": mask.insert(.maskControl)
        case "alt", "option": mask.insert(.maskAlternate)
        case "shift": mask.insert(.maskShift)
        default: break
        }
    }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(vk), keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(vk), keyDown: false) else {
        return err("error", "CGEventCreateKeyboardEvent failed")
    }
    if !flags.isEmpty {
        down.flags = mask
        up.flags = mask
    }
    // Targeted delivery: the pid receives the event without being
    // activated. Chromium filters pid-posted MOUSE events; keyboard
    // events are accepted.
    down.postToPid(pid_t(pid))
    up.postToPid(pid_t(pid))
    return ["ok": true, "performed": true]
}

func scrollToPidOp(_ req: [String: Any]) -> [String: Any] {
    guard let pid = req["pid"] as? Int, pid > 0, let ticks = req["ticks"] as? Int else {
        return err("error", "scrollToPid requires pid + ticks")
    }
    let direction = (req["direction"] as? String) ?? "down"
    let signed = direction == "up" ? -ticks : ticks
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: Int32(clamping: signed), wheel2: 0, wheel3: 0) else {
        return err("error", "CGEventCreateScrollWheelEvent failed")
    }
    event.postToPid(pid_t(pid))
    return ["ok": true, "performed": true]
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

// MARK: - screenshotWindow (ScreenCaptureKit, macOS 14+)
//
// The SCK implementation lives in screenshot.swift, compiled in only
// when the build SDK is 14+ (scripts/build-ax-helper.sh passes
// -DDUYA_HAS_SCK). Without it the op degrades to a structured
// `unsupported` instead of failing the helper build on older SDKs.

#if !DUYA_HAS_SCK
func screenshotWindowOp(_ req: [String: Any]) -> [String: Any] {
    return err("unsupported", "helper built without ScreenCaptureKit (SDK < 14)")
}
#endif

// MARK: - dispatch

func dispatch(_ req: [String: Any]) -> [String: Any] {
    let op = req["op"] as? String ?? ""
    switch op {
    case "ping":
        return ["ok": true]
    case "permissions":
        return permissionsOp()
    case "apps":
        return appsOp()
    case "fg":
        return fgOp()
    case "secureInput":
        return secureInputOp()
    case "windows":
        return windowsOp(req)
    case "enumerate":
        return enumerateOp(req)
    case "probe":
        return probeOp(req)
    case "action":
        return actionOp(req)
    case "setValue":
        return setValueOp(req)
    case "manualAccessibility":
        return manualAccessibilityOp(req)
    case "readUrl":
        return readUrlOp(req)
    case "keyToPid":
        return keyToPidOp(req)
    case "scrollToPid":
        return scrollToPidOp(req)
    case "activate":
        return activateOp(req)
    case "screenshotWindow":
        return screenshotWindowOp(req)
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
