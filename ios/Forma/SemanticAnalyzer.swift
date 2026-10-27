import Foundation
import CryptoKit
import OnnxRuntimeBindings
import FormaCore

/// One bounded background session. No model inference is on the player path.
actor SemanticAnalyzer {
    static let shared = SemanticAnalyzer()
    private var environment: ORTEnv?
    private var session: ORTSession?
    func analyze(_ pcm: [Float]) throws -> SemanticAudioProfile? {
        try Task.checkCancellation()
        guard let input = EffnetMel.patches(pcm) else { return nil }
        if session == nil {
            guard let url = Bundle.main.url(forResource: "discogs-effnet-bsdynamic-1", withExtension: "onnx") else { throw SyncError.rejected("SEMANTIC_MODEL_MISSING") }
            let bytes = try Data(contentsOf: url, options: [.mappedIfSafe])
            let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            guard digest == "a280825b334797cf677939db8cd5762c0392aedd0ca6415dbc1cd083f045e43c" else { throw SyncError.rejected("SEMANTIC_MODEL_CHECKSUM") }
            let environment = try ORTEnv(loggingLevel: .error)
            let options = try ORTSessionOptions()
            try options.setIntraOpNumThreads(1)
            try options.setGraphOptimizationLevel(.all)
            self.environment = environment
            session = try ORTSession(env: environment, modelPath: url.path, sessionOptions: options)
        }
        try Task.checkCancellation()
        let data = input.data.withUnsafeBytes { NSMutableData(bytes: $0.baseAddress!, length: $0.count) }
        let tensor = try ORTValue(tensorData: data, elementType: .float, shape: [NSNumber(value: input.count), 128, 96])
        let inputNames = try session!.inputNames()
        guard inputNames.count == 1 else { throw SyncError.rejected("SEMANTIC_INPUT_SCHEMA") }
        let outputs = try session!.run(withInputs: [inputNames[0]: tensor], outputNames: Set(try session!.outputNames()), runOptions: nil)
        func mean(size: Int) throws -> [Double] {
            guard let tensor = try outputs.values.first(where: { value in let shape = try value.tensorTypeAndShapeInfo().shape; return shape.map(\.intValue) == [input.count, size] }) else { throw SyncError.rejected("SEMANTIC_OUTPUT_MISSING") }
            let bytes = try tensor.tensorData() as Data
            guard bytes.count == input.count * size * MemoryLayout<Float>.size else { throw SyncError.rejected("SEMANTIC_OUTPUT_SHAPE") }
            return bytes.withUnsafeBytes { buffer in
                let values = buffer.bindMemory(to: Float.self)
                return (0..<size).map { i in (0..<input.count).reduce(0.0) { $0 + Double(values[$1 * size + i]) } / Double(input.count) }
            }
        }
        let embedding = try mean(size: 1280), scores = try mean(size: 400)
        try Task.checkCancellation()
        return SemanticAudioProfile.pack(embedding, scores: scores, seconds: min(30, Double(pcm.count) / 16000))
    }
}
