import Foundation

public struct SoundProfile: Codable, Hashable, Sendable {
    public var version = 1
    public var seconds: Double
    public var bands: [Double]
    public var tempo: Double
    public var tempoConfidence: Double
    public var dynamicRange: Double
    public var brightness: Double
    public var onsetRate: Double
    public var semantic: SemanticAudioProfile? = nil
    public var isValid: Bool {
        version == 1 && bands.count == 8 && bands.allSatisfy { $0.isFinite && (0...1).contains($0) } && bands.reduce(0, +) >= 0.5 && (0.9...1.1).contains(bands.reduce(0) { $0 + $1 * $1 }) && seconds.isFinite && (8...30).contains(seconds) && tempo.isFinite && (0...220).contains(tempo) && [tempoConfidence, dynamicRange, brightness, onsetRate].allSatisfy { $0.isFinite && (0...1).contains($0) }
    }
    public static func similarity(_ a: SoundProfile?, _ b: SoundProfile?) -> Double? {
        guard let a, let b, a.isValid, b.isValid else { return nil }
        if let deep = SemanticAudioProfile.similarity(a.semantic, b.semantic) { return deep }
        let timbre = zip(a.bands, b.bands).reduce(0) { $0 + $1.0 * $1.1 }
        let tempo = a.tempo > 0 && b.tempo > 0 ? exp(-([1.0, 2.0, 0.5].map { abs(a.tempo * $0 - b.tempo) / b.tempo }.min() ?? 0) * 5) : 0.5
        return min(1, max(0, timbre * 0.6 + tempo * 0.2 + (1 - abs(a.dynamicRange - b.dynamicRange)) * 0.1 + (1 - abs(a.onsetRate - b.onsetRate)) * 0.1))
    }
    public static func analyze(_ pcm: [Float], sampleRate: Int = 16000) -> SoundProfile? {
        guard sampleRate == 16000, pcm.count >= sampleRate * 8 else { return nil }
        let count = min(pcm.count, 480000), bounds = [120.0, 250, 500, 1000, 2000, 4000, 6000, 8001]
        var bands = [Double](repeating: 0, count: 8), energies: [Double] = [], onsets: [Double] = [], previous = 0.0
        var re = [Double](repeating: 0, count: 1024), im = re
        for start in stride(from: 0, through: count - 1024, by: 512) {
            var energy = 0.0
            for i in 0..<1024 { let raw = Double(pcm[start + i]); let x = raw.isFinite ? min(1, max(-1, raw)) : 0; energy += x * x; re[i] = x * (0.5 - 0.5 * cos(2 * .pi * Double(i) / 1023)); im[i] = 0 }
            energy = sqrt(energy / 1024); energies.append(energy); onsets.append(max(0, energy - previous)); previous = energy
            fft(&re, &im); var band = 0
            for i in 4...512 { let hz = Double(i * sampleRate) / 1024; while band < 7 && hz >= bounds[band] { band += 1 }; bands[band] += re[i] * re[i] + im[i] * im[i] }
        }
        let total = bands.reduce(0, +); guard total > 1e-6 else { return nil }
        let normalized = bands.map { sqrt($0 / total) }, norm = sqrt(normalized.reduce(0) { $0 + $1 * $1 })
        let sorted = energies.sorted(), p10 = sorted[Int(Double(sorted.count) * 0.1)], p90 = sorted[Int(Double(sorted.count) * 0.9)], mean = onsets.reduce(0, +) / Double(onsets.count)
        var best = 0.0, tempo = 0.0
        for lag in 11...31 {
            var dot = 0.0, a = 0.0, b = 0.0
            for i in lag..<onsets.count { let x = onsets[i] - mean, y = onsets[i - lag] - mean; dot += x * y; a += x * x; b += y * y }
            let c = a * b > 1e-12 ? max(0, dot / sqrt(a * b)) : 0
            if c > best { best = c; tempo = 60 * Double(sampleRate) / Double(512 * lag) }
        }
        let seconds = Double(count) / Double(sampleRate)
        let result = SoundProfile(seconds: seconds, bands: normalized.map { $0 / norm }, tempo: best >= 0.15 ? tempo : 0, tempoConfidence: best, dynamicRange: min(1, max(0, (p90 - p10) / max(0.0001, p90))), brightness: normalized.suffix(4).reduce(0) { $0 + $1 * $1 }, onsetRate: min(1, Double(onsets.filter { $0 > max(0.002, mean * 2) }.count) / seconds / 6))
        return result.isValid ? result : nil
    }
    private static func fft(_ re: inout [Double], _ im: inout [Double]) {
        let n = re.count; var j = 0
        for i in 1..<n { var bit = n >> 1; while j & bit != 0 { j ^= bit; bit >>= 1 }; j ^= bit; if i < j { re.swapAt(i, j); im.swapAt(i, j) } }
        var len = 2
        while len <= n { let angle = -2 * Double.pi / Double(len)
            for start in stride(from: 0, to: n, by: len) { for k in 0..<(len / 2) { let c = cos(angle * Double(k)), s = sin(angle * Double(k)), i = start + k, other = i + len / 2; let x = re[other] * c - im[other] * s, y = re[other] * s + im[other] * c; re[other] = re[i] - x; im[other] = im[i] - y; re[i] += x; im[i] += y } }; len *= 2
        }
    }
}
