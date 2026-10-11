import AVFoundation
import Foundation
import FormaCore

// Optional bounded download, never on the player request/AVQueuePlayer path.

actor SoundAnalyzer {
    private var attempts: [String: Date] = [:]
    private var budget: [Date] = []
    func analyze(_ track: Track, resolver: any StreamResolving) async -> SoundProfile? {
        let now = Date(); budget.removeAll { now.timeIntervalSince($0) > 3600 }
        guard budget.count < 12, now.timeIntervalSince(attempts[track.id] ?? .distantPast) > 300 else { return nil }
        attempts[track.id] = now; budget.append(now)
        if attempts.count > 512 { attempts = attempts.filter { now.timeIntervalSince($0.value) < 3600 } }
        do {
            let source = try await resolver.analysisAudio(videoID: track.id); try Task.checkCancellation()
            let file: URL
            if source.url.isFileURL { file = source.url }
            else {
                let data = try await BoundedHTTPData().load(URLRequest(url: source.url)); try Task.checkCancellation()
                file = FileManager.default.temporaryDirectory.appendingPathComponent("forma-sound-" + UUID().uuidString + ".m4a")
                try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            }
            defer { if !source.url.isFileURL { try? FileManager.default.removeItem(at: file) } }
            return try await Self.decode(file)
        } catch { return nil }
    }
    // AVAssetReader performs actual AAC/PCM decoding; unsupported/silent material
    // returns no profile. It never substitutes title/genre guesses for audio.
    nonisolated static func decode(_ file: URL) async throws -> SoundProfile? {
        let asset = AVURLAsset(url: file), tracks = try await asset.loadTracks(withMediaType: .audio)
        guard !tracks.isEmpty else { return nil }
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderAudioMixOutput(audioTracks: tracks, audioSettings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { return nil }; reader.add(output)
        reader.timeRange = CMTimeRange(start: .zero, duration: CMTime(seconds: 24, preferredTimescale: 16000))
        guard reader.startReading() else { throw reader.error ?? GoogleError.message("Не удалось декодировать аудио для анализа") }
        defer { reader.cancelReading() }; var pcm: [Float] = []; pcm.reserveCapacity(384000)
        while let sample = output.copyNextSampleBuffer(), pcm.count < 384000 {
            try Task.checkCancellation()
            guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
            let count = min(CMBlockBufferGetDataLength(block) / MemoryLayout<Float>.size, 384000 - pcm.count)
            var chunk = [Float](repeating: 0, count: count)
            let status = chunk.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: count * MemoryLayout<Float>.size, destination: $0.baseAddress!) }
            if status == kCMBlockBufferNoErr { pcm += chunk }
        }
        try Task.checkCancellation(); return SoundProfile.analyze(pcm)
    }
}
