import Foundation

/// PCM16k, Hann512, power FFT, hop256, 96 area-normalized Slaney bands,
/// log10(1+10000*x). Deliberately independent of title, artist and genre.
public enum EffnetMel {
    public struct Patches: Sendable { public let data: [Float]; public let count: Int }
    private static let window = (0..<512).map { 0.5 - 0.5 * cos(2 * Double.pi * Double($0) / 511) }
    private static func hzMel(_ f: Double) -> Double { f < 1000 ? f * 3 / 200 : 15 + 27 * log(f / 1000) / log(6.4) }
    private static func melHz(_ m: Double) -> Double { m < 15 ? m * 200 / 3 : 1000 * pow(6.4, (m - 15) / 27) }
    private static let filters: [[(Int, Double)]] = {
        let centers = (0..<98).map { melHz(hzMel(8000) * Double($0) / 97) }
        return (0..<96).map { band in
            let lo = centers[band], mid = centers[band + 1], hi = centers[band + 2]
            return (0...256).compactMap { bin in
                let f = Double(bin * 16000) / 512
                guard f > lo, f < hi else { return nil }
                let weight = (f <= mid ? (f - lo) / (mid - lo) : (hi - f) / (hi - mid)) * 2 / (hi - lo)
                return weight > 0 ? (bin, weight) : nil
            }
        }
    }()
    public static func patches(_ pcm: [Float], sampleRate: Int = 16000) -> Patches? {
        guard sampleRate == 16000, pcm.count >= 8 * 16000 else { return nil }
        let length = min(pcm.count, 30 * 16000), frames = (length - 512) / 256 + 1
        let starts = [0, (frames - 128) / 2, frames - 128]
        var result = [Float](repeating: 0, count: 3 * 128 * 96)
        for patch in 0..<3 {
            for frame in 0..<128 {
                let start = (starts[patch] + frame) * 256
                var re = (0..<512).map { i -> Double in let raw = Double(pcm[start + i]); return (raw.isFinite ? min(1, max(-1, raw)) : 0) * window[i] }
                var im = [Double](repeating: 0, count: 512), j = 0
                for i in 1..<512 { var bit = 256; while j & bit != 0 { j ^= bit; bit >>= 1 }; j ^= bit; if i < j { re.swapAt(i, j) } }
                var size = 2
                while size <= 512 {
                    for base in stride(from: 0, to: 512, by: size) {
                        for i in 0..<(size / 2) {
                            let angle = -2 * Double.pi * Double(i) / Double(size), c = cos(angle), s = sin(angle), p = base + i, q = p + size / 2
                            let x = re[q] * c - im[q] * s, y = re[q] * s + im[q] * c
                            re[q] = re[p] - x; im[q] = im[p] - y; re[p] += x; im[p] += y
                        }
                    }
                    size *= 2
                }
                let power = (0...256).map { re[$0] * re[$0] + im[$0] * im[$0] }
                for band in 0..<96 {
                    let value = filters[band].reduce(0.0) { $0 + power[$1.0] * $1.1 }
                    result[(patch * 128 + frame) * 96 + band] = Float(log10(1 + 10000 * value))
                }
            }
        }
        return Patches(data: result, count: 3)
    }
}
