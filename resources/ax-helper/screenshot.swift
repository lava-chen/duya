// screenshot.swift — ScreenCaptureKit single-window capture (plan 572 Phase 5).
//
// Compiled ONLY when the build SDK is 14+ (scripts/build-ax-helper.sh
// detects the SDK and passes -DDUYA_HAS_SCK). Provides the real
// screenshotWindowOp; on older SDKs main.swift's fallback answers
// `unsupported` instead.
//
// SCScreenshotManager.captureImage renders one window even when it is
// occluded — the CGWindowListCreateImage replacement (deprecated macOS 14).

#if DUYA_HAS_SCK

import Foundation
import ScreenCaptureKit
import CoreGraphics

func screenshotWindowOp(_ req: [String: Any]) -> [String: Any] {
    guard let windowId = req["windowId"] as? UInt32, windowId > 0 else {
        return err("error", "screenshotWindow requires a windowId")
    }

    let semaphore = DispatchSemaphore(value: 0)
    let box = ResultBox()

    let contentDone: (SCContentFilter?, Error?) -> Void = { filter, error in
        box.filter = filter
        box.error = error
        semaphore.signal()
    }

    // SCShareableContent enumerates shareable windows; on macOS 26 this
    // call itself can surface the TCC prompt — cache nothing here, the
    // helper is short-lived per respawn.
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
        guard let content = content, error == nil else {
            contentDone(nil, error ?? NSError(domain: "duya.ax-helper", code: -1))
            return
        }
        guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
            contentDone(nil, NSError(domain: "duya.ax-helper", code: -2, userInfo: [NSLocalizedDescriptionKey: "window \(windowId) not found"]))
            return
        }
        contentDone(SCContentFilter(desktopIndependentWindow: window), nil)
    }
    if semaphore.wait(timeout: .now() + 2.5) == .timedOut {
        return err("timeout", "SCShareableContent did not answer in time")
    }
    guard let filter = box.filter else {
        return err("error", box.error?.localizedDescription ?? "window not shareable")
    }

    let configuration = SCStreamConfiguration()
    configuration.width = Int(filter.contentRect.width)
    configuration.height = Int(filter.contentRect.height)
    configuration.showsCursor = false
    configuration.scalesToFit = false

    let imageDone = DispatchSemaphore(value: 0)
    let imageBox = ImageBox()
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
        imageBox.image = image
        imageBox.error = error
        imageDone.signal()
    }
    if imageDone.wait(timeout: .now() + 2.5) == .timedOut {
        return err("timeout", "captureImage did not answer in time")
    }
    guard let cgImage = imageBox.image else {
        return err("error", imageBox.error?.localizedDescription ?? "capture failed")
    }
    guard let png = cgImage.pngData() else {
        return err("error", "PNG encoding failed")
    }
    return [
        "ok": true,
        "png": png.base64EncodedString(),
        "width": cgImage.width,
        "height": cgImage.height,
    ]
}

final class ResultBox {
    var filter: SCContentFilter?
    var error: Error?
}

final class ImageBox {
    var image: CGImage?
    var error: Error?
}

extension CGImage {
    func pngData() -> Data? {
        let rect = CGRect(x: 0, y: 0, width: width, height: height)
        guard let bitmap = NSBitmapImageRep(cgImage: self) else { return nil }
        return bitmap.representation(using: .png, properties: [:])
    }
}

#endif
