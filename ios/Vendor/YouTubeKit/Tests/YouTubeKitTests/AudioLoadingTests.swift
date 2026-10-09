import Foundation
import XCTest
@testable import YouTubeKit

private final class AudioFixtureProtocol: URLProtocol {
    static let lock = NSLock()
    static var handler: ((URLRequest) -> (Data, TimeInterval, Int))!
    static var clients: [String] = []
    private var work: DispatchWorkItem?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        if request.url?.path == "/youtubei/v1/player" { Self.clients.append(request.value(forHTTPHeaderField: "X-Youtube-Client-Name") ?? "") }
        let (data, delay, status) = Self.handler(request)
        Self.lock.unlock()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.work?.isCancelled == false else { return }
            self.client?.urlProtocol(self, didReceive: HTTPURLResponse(url: self.request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: data)
            self.client?.urlProtocolDidFinishLoading(self)
        }
        self.work = work; DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: work)
    }
    override func stopLoading() { work?.cancel() }
}

final class AudioLoadingTests: XCTestCase {
    private func video(native: String = "aac", nativeDelay: Double = 0.01, scriptDelay: Double = 0.01) -> YouTube {
        let fixture = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let html = #"ytplayer.config = {"assets":{"js":"/s/player/FIXTURE/base.js"}}; ytcfg.set({}); var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"}};"#.replacingOccurrences(of: "FIXTURE", with: fixture)
        AudioFixtureProtocol.lock.lock(); AudioFixtureProtocol.clients = []
        AudioFixtureProtocol.handler = { request in
            let path = request.url!.path
            if path == "/watch" { return (Data(html.utf8), 0.01, 200) }
            if path.hasSuffix("base.js") { return (Data("signatureTimestamp:12345".utf8), scriptDelay, 200) }
            let isNative = request.value(forHTTPHeaderField: "X-Youtube-Client-Name") == "101"
            if isNative, native == "error" { return (Data(), nativeDelay, 500) }
            let webm = isNative && native == "webm"
            let object: [String: Any] = ["videoDetails": ["videoId": "abcdefghijk", "thumbnail": ["thumbnails": []]], "streamingData": ["adaptiveFormats": [["itag": webm ? 251 : 140, "mimeType": webm ? "audio/webm; codecs=\"opus\"" : "audio/mp4; codecs=\"mp4a.40.2\"", "url": "https://r1.googlevideo.com/audio?sig=ready", "bitrate": 128000]]]]
            return (try! JSONSerialization.data(withJSONObject: object), isNative ? nativeDelay : 0.01, 200)
        }
        AudioFixtureProtocol.lock.unlock()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AudioFixtureProtocol.self]
        return YouTube(videoID: "abcdefghijk", methods: [.local], session: URLSession(configuration: configuration))
    }
    func testFastAudioDoesNotWaitForSlowWebScript() async throws {
        let video = video(scriptDelay: 3), start = Date()
        let streams = try await video.audioStreams
        XCTAssertLessThan(Date().timeIntervalSince(start), 1, "A losing client must not block usable audio")
        XCTAssertEqual(streams.count, 1); XCTAssertEqual(streams.first?.fileExtension, .m4a)
        XCTAssertFalse(streams.contains { $0.includesVideoTrack })
        AudioFixtureProtocol.lock.lock(); let clients = AudioFixtureProtocol.clients; AudioFixtureProtocol.lock.unlock()
        XCTAssertFalse(clients.contains("0"), "Audio must not request MEDIA_CONNECT_FRONTEND progressive video")
    }
    func testWebAudioFallbackWhenNativeCodecIsUnsupported() async throws {
        let streams = try await video(native: "webm").audioStreams
        XCTAssertEqual(streams.first?.fileExtension, .m4a)
    }
    func testFailingClientDoesNotCancelOtherUsableClient() async throws {
        let streams = try await video(native: "error").audioStreams
        XCTAssertEqual(streams.first?.fileExtension, .m4a)
    }
    func testCancellationStopsSlowExtraction() async throws {
        let video = video(nativeDelay: 3, scriptDelay: 3), start = Date()
        let task = Task { try await video.audioStreams }
        try await Task.sleep(nanoseconds: 100_000_000); task.cancel()
        do { _ = try await task.value; XCTFail("Cancelled extraction returned streams") } catch { }
        XCTAssertLessThan(Date().timeIntervalSince(start), 1)
    }
}
