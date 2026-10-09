import Foundation
import ImageIO
import UIKit
import FormaCore

@MainActor
final class ArtworkStore {
    static let shared = ArtworkStore()
    private let images = NSCache<NSString, UIImage>()
    private var pending: [String: Task<UIImage?, Never>] = [:]
    private var unavailable: [URL: Date] = [:]
    private let session: URLSession
    init() {
        images.countLimit = 80; images.totalCostLimit = 32 * 1024 * 1024
        let config = URLSessionConfiguration.default
        config.urlCache = URLCache(memoryCapacity: 8 * 1024 * 1024, diskCapacity: 48 * 1024 * 1024, diskPath: "forma-artwork")
        config.timeoutIntervalForRequest = 6; config.timeoutIntervalForResource = 10
        config.httpCookieStorage = nil; config.httpMaximumConnectionsPerHost = 2
        session = URLSession(configuration: config)
    }
    func image(for track: Track, pixels: Int) async -> UIImage? {
        // Two shared sizes keep UI and lock-screen requests from decoding duplicates.
        let pixels = pixels > 480 ? 1024 : 320
        let urls = ArtworkPolicy.candidates(for: track, pixels: pixels)
        let key = "\(pixels)|\(urls.map(\.absoluteString).joined(separator: "|"))"
        if let image = images.object(forKey: key as NSString) { return image }
        if let task = pending[key] { return await task.value }
        let task = Task<UIImage?, Never> { [self] in
            for url in urls {
                if let until = unavailable[url], until > Date() { continue }
                do {
                    var request = URLRequest(url: url); request.httpShouldHandleCookies = false
                    let (data, response) = try await session.data(for: request)
                    guard let response = response as? HTTPURLResponse else { continue }
                    if response.statusCode == 404 { unavailable[url] = Date().addingTimeInterval(3600); continue }
                    guard (200..<300).contains(response.statusCode), data.count < 5 * 1024 * 1024 else { continue }
                    // Decode and downsample off the UI thread, not on every player tick.
                    let image = await Task.detached(priority: .utility) { Self.decode(data, pixels: pixels) }.value
                    guard let image else { continue }
                    // YouTube sometimes returns a 120px placeholder with HTTP 200 for absent maxres.
                    if url.lastPathComponent == "maxresdefault.jpg", image.size.width <= 120 { unavailable[url] = Date().addingTimeInterval(3600); continue }
                    images.setObject(image, forKey: key as NSString, cost: Int(image.size.width * image.size.height * 4))
                    return image
                } catch { continue }
            }
            return nil
        }
        pending[key] = task
        let result = await task.value; pending[key] = nil
        if unavailable.count > 200 { unavailable = unavailable.filter { $0.value > Date() } }
        return result
    }
    nonisolated private static func decode(_ data: Data, pixels: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: pixels, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}
