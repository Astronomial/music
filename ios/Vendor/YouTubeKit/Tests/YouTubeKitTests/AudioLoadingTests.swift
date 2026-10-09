import Foundation
import XCTest
@testable import YouTubeKit

private final class AudioFixtureProtocol: URLProtocol {
    static let lock = NSLock()
    static var handler: ((URLRequest) -> (Data, TimeInterval, Int))!
    static var clients: [String] = []
    static var paths: [String] = []
    private var work: DispatchWorkItem?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        Self.paths.append(request.url?.path ?? "")
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
    private var fixtureSession: URLSession!
    func testOldConfigurationCannotRepopulateCacheAfterNetworkReset() async throws {
        let cache = AudioContextCache(), session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let configuration = try JSONDecoder().decode(Extraction.YtCfg.self, from: Data(#"{"VISITOR_DATA":"old-route"}"#.utf8))
        let old = await cache.ticket(session: session)
        await cache.invalidate(session: session)
        await cache.store(configuration: configuration, playerURL: nil, session: session, ticket: old)
        let rejected = await cache.cached(session: session); XCTAssertNil(rejected)
        let fresh = await cache.ticket(session: session)
        await cache.store(configuration: configuration, playerURL: nil, session: session, ticket: fresh)
        let accepted = await cache.cached(session: session); XCTAssertNotNil(accepted)
    }
    func testResettingOneSessionDoesNotInvalidateAnotherSessionContext() async throws {
        let cache = AudioContextCache(), a = URLSession(configuration: .ephemeral), b = URLSession(configuration: .ephemeral)
        defer { a.invalidateAndCancel(); b.invalidateAndCancel() }
        let configuration = try JSONDecoder().decode(Extraction.YtCfg.self, from: Data("{}".utf8))
        let ticket = await cache.ticket(session: b)
        await cache.invalidate(session: a)
        await cache.store(configuration: configuration, playerURL: nil, session: b, ticket: ticket)
        let accepted = await cache.cached(session: b); XCTAssertNotNil(accepted)
    }
    private static func requestBody(_ request: URLRequest) -> Data? {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open(); defer { stream.close() }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return data
    }
    // Tiny deterministic player with the same structural signature entry as yt-ejs expects.
    private static let playerFixture = """
    (function(){function State(){this.values={};} State.prototype.set=function(k,v){this.values[k]=v;}; State.prototype.get=function(k){return this.values[k];}; State.prototype.transform=function(){if(this.values.s)this.values.s=encodeURIComponent(decodeURIComponent(this.values.s).split('').reverse().join(''));if(this.values.n)this.values.n=this.values.n.split('').reverse().join('');}; function build(url,key,s){var state=new State(); if(s)state.set(key,s); state.set('alr','yes'); return state;}}).call(this);
    """

    private func video(native: String = "aac", nativeDelay: Double = 0.01, scriptDelay: Double = 0.01, watchDelay: Double = 0.01) -> YouTube {
        let fixture = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let html = #"ytplayer.config = {"assets":{"js":"/s/player/FIXTURE/base.js"}}; ytcfg.set({"VISITOR_DATA":"fixture-visitor"}); var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"}};"#.replacingOccurrences(of: "FIXTURE", with: fixture)
        AudioFixtureProtocol.lock.lock(); AudioFixtureProtocol.clients = []; AudioFixtureProtocol.paths = []
        AudioFixtureProtocol.handler = { request in
            let path = request.url!.path
            if path == "/watch" { return (Data(html.utf8), watchDelay, 200) }
            if path.hasSuffix("base.js") { return (Data((native == "cipher" ? Self.playerFixture : "signatureTimestamp:12345").utf8), scriptDelay, 200) }
            let isNative = request.value(forHTTPHeaderField: "X-Youtube-Client-Name") == "101"
            let body = Self.requestBody(request).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let client = (body?["context"] as? [String: Any])?["client"] as? [String: Any]
            let hasVisitor = request.value(forHTTPHeaderField: "X-Goog-Visitor-Id") == "fixture-visitor" && client?["visitorData"] as? String == "fixture-visitor"
            if isNative, native == "error" { return (Data(), nativeDelay, 500) }
            if native == "blocked" || (isNative && native == "visitor" && !hasVisitor) {
                return (Data(#"{"playabilityStatus":{"status":"LOGIN_REQUIRED","reason":"Sign in to confirm"}}"#.utf8), nativeDelay, 200)
            }
            if native == "malformed" { return (Data("not JSON".utf8), 0.01, 200) }
            let webm = isNative && native == "webm"
            var format: [String: Any] = ["itag": webm ? 251 : 140, "mimeType": webm ? "audio/webm; codecs=\"opus\"" : "audio/mp4; codecs=\"mp4a.40.2\"", "url": "https://r1.googlevideo.com/audio?sig=ready", "bitrate": 128000]
            if native == "cipher" {
                var cipher = URLComponents(); cipher.queryItems = [URLQueryItem(name: "url", value: "https://r1.googlevideo.com/audio?n=xyz"), URLQueryItem(name: "s", value: "abc123"), URLQueryItem(name: "sp", value: "signature")]
                format["url"] = nil; format["signatureCipher"] = cipher.percentEncodedQuery
            }
            if native == "default-track" { format["audioTrack"] = ["displayName": "Русский", "id": "ru.0", "audioIsDefault": true] }
            if native == "partial-track" { format["audioTrack"] = ["id": "ru.0", "audioIsDefault": true] }
            if native == "sabr" { format["url"] = nil }
            var object: [String: Any] = ["playabilityStatus": ["status": "OK"], "videoDetails": ["videoId": (body?["videoId"] as? String) ?? "abcdefghijk", "thumbnail": ["thumbnails": []]], "streamingData": ["adaptiveFormats": [format]]]
            if native == "no-status" { object["playabilityStatus"] = nil }
            return (try! JSONSerialization.data(withJSONObject: object), isNative ? nativeDelay : 0.01, 200)
        }
        AudioFixtureProtocol.lock.unlock()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AudioFixtureProtocol.self]
        fixtureSession = URLSession(configuration: configuration)
        return YouTube(videoID: "abcdefghijk", methods: [.local], session: fixtureSession)
    }
    func testNetworkContextResetForcesFreshConfigurationWithoutBreakingAudio() async throws {
        let first = video(native: "visitor")
        _ = try await first.audioStreams
        await YouTube.resetAudioContext(session: fixtureSession)
        AudioFixtureProtocol.lock.lock(); AudioFixtureProtocol.paths = []; AudioFixtureProtocol.lock.unlock()
        let second = YouTube(videoID: "abcdefghij2", methods: [.local], session: fixtureSession)
        let streams = try await second.audioStreams
        XCTAssertFalse(streams.isEmpty)
        AudioFixtureProtocol.lock.lock(); let paths = AudioFixtureProtocol.paths; AudioFixtureProtocol.lock.unlock()
        XCTAssertTrue(paths.contains("/watch"), "A former VPN visitor context must not survive route reset")
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
    func testNativeAudioDoesNotWaitForSlowWatchPage() async throws {
        let video = video(watchDelay: 3), start = Date()
        let streams = try await video.audioStreams
        XCTAssertLessThan(Date().timeIntervalSince(start), 1)
        XCTAssertEqual(streams.first?.fileExtension, .m4a)
    }
    func testWebAudioFallbackWhenNativeCodecIsUnsupported() async throws {
        let streams = try await video(native: "webm").audioStreams
        XCTAssertEqual(streams.first?.fileExtension, .m4a)
    }
    func testFailingClientDoesNotCancelOtherUsableClient() async throws {
        let streams = try await video(native: "error").audioStreams
        XCTAssertEqual(streams.first?.fileExtension, .m4a)
    }
    func testDefaultAudioWithLocalizedLabelIsPlayable() async throws {
        let streams = try await video(native: "default-track").audioStreams
        XCTAssertEqual(streams.count, 1)
    }
    func testPartialAudioTrackMetadataIsPlayable() async throws {
        let streams = try await video(native: "partial-track").audioStreams
        XCTAssertEqual(streams.count, 1)
    }
    func testNativeRequestRetriesWithVisitorContext() async throws {
        let streams = try await video(native: "visitor").audioStreams
        XCTAssertEqual(streams.first?.fileExtension, .m4a)
        AudioFixtureProtocol.lock.lock(); let clients = AudioFixtureProtocol.clients; AudioFixtureProtocol.lock.unlock()
        XCTAssertEqual(clients.filter { $0 == "101" }.count, 2)
        XCTAssertFalse(clients.contains("1"), "Configured native audio must not wait for WEB or JS")
    }
    func testWarmContextStartsAnotherVideoWithoutWatchOrScriptRequests() async throws {
        let first = video(native: "visitor", watchDelay: 0.2)
        _ = try await first.audioStreams
        AudioFixtureProtocol.lock.lock(); AudioFixtureProtocol.paths = []; AudioFixtureProtocol.clients = []; AudioFixtureProtocol.lock.unlock()
        let start = Date()
        let next = YouTube(videoID: "lmnopqrstuv", methods: [.local], session: fixtureSession!)
        let streams = try await next.audioStreams
        XCTAssertEqual(streams.first?.fileExtension, .m4a)
        XCTAssertLessThan(Date().timeIntervalSince(start), 0.15)
        AudioFixtureProtocol.lock.lock(); let paths = AudioFixtureProtocol.paths, clients = AudioFixtureProtocol.clients; AudioFixtureProtocol.lock.unlock()
        XCTAssertEqual(paths, ["/youtubei/v1/player"])
        XCTAssertEqual(clients, ["101"])
    }
    func testRejectedWarmContextRefreshesInsteadOfPoisoningNextTracks() async throws {
        _ = try await video(native: "visitor").audioStreams
        AudioFixtureProtocol.lock.lock()
        AudioFixtureProtocol.paths = []
        AudioFixtureProtocol.handler = { request in
            if request.url!.path == "/watch" {
                return (Data(#"ytcfg.set({"VISITOR_DATA":"fresh-visitor"});"#.utf8), 0.01, 200)
            }
            if request.value(forHTTPHeaderField: "X-Goog-Visitor-Id") != "fresh-visitor" {
                return (Data(#"{"playabilityStatus":{"status":"LOGIN_REQUIRED"}}"#.utf8), 0.01, 200)
            }
            let body = Self.requestBody(request).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let id = body?["videoId"] as? String ?? ""
            let json: [String: Any] = ["playabilityStatus": ["status": "OK"], "videoDetails": ["videoId": id, "thumbnail": ["thumbnails": []]], "streamingData": ["adaptiveFormats": [["itag":140, "mimeType":"audio/mp4; codecs=\"mp4a.40.2\"", "url":"https://r1.googlevideo.com/audio?sig=ready"]]]]
            return (try! JSONSerialization.data(withJSONObject: json), 0.01, 200)
        }
        AudioFixtureProtocol.lock.unlock()
        let streams = try await YouTube(videoID: "lmnopqrstuv", methods: [.local], session: fixtureSession!).audioStreams
        XCTAssertEqual(streams.count, 1)
        AudioFixtureProtocol.lock.lock(); let paths = AudioFixtureProtocol.paths; AudioFixtureProtocol.lock.unlock()
        XCTAssertTrue(paths.contains("/watch"))
    }
    func testValidStreamsDoNotRequireOptionalStatus() async throws {
        let streams = try await video(native: "no-status").audioStreams
        XCTAssertEqual(streams.count, 1)
    }
    func testBlockedResponsesKeepUsefulDiagnostics() async throws {
        do { _ = try await video(native: "blocked").audioStreams; XCTFail("Blocked response returned audio") }
        catch let error as AudioStreamExtractionError {
            XCTAssertEqual(error.attempts.count, 3)
            XCTAssertTrue(error.attempts.allSatisfy { $0.contains("LOGIN_REQUIRED") })
            XCTAssertFalse(error.localizedDescription.contains("error 2"))
            XCTAssertFalse(error.localizedDescription.contains("fixture-visitor"))
        }
    }
    func testMalformedPlayerResponsesKeepStage() async throws {
        do { _ = try await video(native: "malformed").audioStreams; XCTFail("Malformed JSON returned audio") }
        catch let error as AudioStreamExtractionError {
            XCTAssertTrue(error.attempts.allSatisfy { $0.contains("PLAYER/DECODE") })
        }
    }
    func testSABROnlyFormatsAreDiagnosedWithoutInvalidURLs() async throws {
        do { _ = try await video(native: "sabr").audioStreams; XCTFail("SABR-only response returned direct audio") }
        catch let error as AudioStreamExtractionError {
            XCTAssertTrue(error.attempts.allSatisfy { $0.contains("NO_AAC") })
        }
    }
    func testPlayerJSWithHyphenatedVariantPath() throws {
        let path = "/s/player/abcdef12/tv-player-ias.vflset/tv-player-ias.js"
        XCTAssertEqual(try Extraction.getYTPlayerJS(html: "<script src='\(path)'></script>"), path)
    }
    func testOriginalAudioSelectionPreservesVideoAndExcludesDubs() throws {
        let data = Data(#"{"adaptiveFormats":[{"itag":137,"mimeType":"video/mp4; codecs=\"avc1.640028\"","url":"https://example.com/video"},{"itag":140,"mimeType":"audio/mp4; codecs=\"mp4a.40.2\"","url":"https://example.com/original","audioTrack":{"id":"ru.0","displayName":"Russian original","audioIsDefault":false}},{"itag":140,"mimeType":"audio/mp4; codecs=\"mp4a.40.2\"","url":"https://example.com/dub","audioTrack":{"id":"en.1","displayName":"English","audioIsDefault":true}}]}"#.utf8)
        let formats = try JSONDecoder().decode(InnerTube.StreamingData.self, from: data)
        let selected = Extraction.filterOutDubbedAudio(streamManifest: Extraction.applyDescrambler(streamData: formats))
        XCTAssertEqual(selected.compactMap { $0.url }, ["https://example.com/video", "https://example.com/original"])
    }
    func testCachedSignatureSolverUsesNewInputs() throws {
        let solver = try SignatureSolver(js: Self.playerFixture)
        let first = try solver.batchSolve(request: .init(nInputs: ["xyz"], sigInputs: ["abc123"]))
        XCTAssertEqual(first.nMap["xyz"], "zyx"); XCTAssertEqual(first.sigMap["abc123"], "321cba")
        let second = try solver.batchSolve(request: .init(nInputs: ["new"], sigInputs: ["second"]))
        XCTAssertEqual(second.nMap["new"], "wen"); XCTAssertEqual(second.sigMap["second"], "dnoces")
    }
    func testAudioPathDeciphersSignatureAndThrottlingParameter() async throws {
        let streams = try await video(native: "cipher").audioStreams
        let parameters = URLComponents(url: try XCTUnwrap(streams.first?.url), resolvingAgainstBaseURL: false)?.queryItems
        XCTAssertEqual(parameters?.first { $0.name == "signature" }?.value, "321cba")
        XCTAssertEqual(parameters?.first { $0.name == "n" }?.value, "zyx")
    }
    func testCancellationStopsSlowExtraction() async throws {
        let video = video(nativeDelay: 3, scriptDelay: 3), start = Date()
        let task = Task { try await video.audioStreams }
        try await Task.sleep(nanoseconds: 100_000_000); task.cancel()
        do { _ = try await task.value; XCTFail("Cancelled extraction returned streams") } catch { }
        XCTAssertLessThan(Date().timeIntervalSince(start), 1)
    }
}
