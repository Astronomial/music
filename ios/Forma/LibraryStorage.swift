import Foundation
import FormaCore

actor LibraryStorage {
    private struct Baseline: Codable { let version: Int; let peerID: String; let library: Library }
    private var highestRequestedRevision: UInt64 = 0
    private var savedRevision: UInt64 = 0
    let url: URL
    init(url: URL) { self.url = url }
    func load() throws -> (library: Library, notice: String?) { try LibraryDiskStore(url: url).load() }
    func save(_ library: Library, revision: UInt64) throws {
        guard revision >= highestRequestedRevision else { return }
        highestRequestedRevision = revision
        try LibraryDiskStore(url: url).save(library); savedRevision = revision
    }
    func syncBase(peerID: String?, allowLegacy: Bool = false) -> Library? {
        guard let peerID, let bytes = try? Data(contentsOf: url.appendingPathExtension("sync-base")) else { return nil }
        if let baseline = try? JSONDecoder().decode(Baseline.self, from: bytes) {
            guard baseline.version == 1, baseline.peerID == peerID, baseline.library.version == 1 else { return nil }
            return LibraryValidation.normalized(baseline.library)
        }
        // Only a connection created before this format may adopt a legacy baseline.
        guard allowLegacy, let old = try? JSONDecoder().decode(Library.self, from: bytes), old.version == 1 else { return nil }
        return LibraryValidation.normalized(old)
    }
    func saveSyncBase(_ library: Library?, peerID: String? = nil) throws {
        let dest = url.appendingPathExtension("sync-base")
        if let library {
            guard let peerID else { throw SyncError.rejected("Нет идентификатора подключённого ПК.") }
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(Baseline(version: 1, peerID: peerID, library: library)).write(to: dest, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
        else if FileManager.default.fileExists(atPath: dest.path) { try FileManager.default.removeItem(at: dest) }
    }
    func saveSynchronized(_ library: Library, base: Library, peerID: String, revision: UInt64) throws {
        // Never advance the sync baseline before the user's library is durable.
        try save(library, revision: revision)
        guard savedRevision >= revision else { throw SyncError.rejected("Новое сохранение библиотеки ещё не завершено.") }
        try saveSyncBase(base, peerID: peerID)
    }
}
