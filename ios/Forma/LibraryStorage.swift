import Foundation
import FormaCore

actor LibraryStorage {
    let url: URL
    init(url: URL) { self.url = url }
    func load() throws -> (library: Library, notice: String?) { try LibraryDiskStore(url: url).load() }
    func save(_ library: Library) throws { try LibraryDiskStore(url: url).save(library) }
    func syncBase() -> Library? { guard let bytes = try? Data(contentsOf: url.appendingPathExtension("sync-base")) else { return nil }; return try? JSONDecoder().decode(Library.self, from: bytes) }
    func saveSyncBase(_ library: Library?) throws {
        let dest = url.appendingPathExtension("sync-base")
        if let library {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(library).write(to: dest, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
        else { try? FileManager.default.removeItem(at: dest) }
    }
    func saveSynchronized(_ library: Library, base: Library) throws {
        // Never advance the sync baseline before the user's library is durable.
        try save(library)
        try saveSyncBase(base)
    }
}
