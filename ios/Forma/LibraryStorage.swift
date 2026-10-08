import Foundation
import FormaCore

actor LibraryStorage {
    let url: URL
    init(url: URL) { self.url = url }
    func save(_ library: Library) throws { try LibraryDiskStore(url: url).save(library) }
    func syncBase() -> Library? { guard let bytes = try? Data(contentsOf: url.appendingPathExtension("sync-base")) else { return nil }; return try? JSONDecoder().decode(Library.self, from: bytes) }
    func saveSyncBase(_ library: Library?) throws {
        let dest = url.appendingPathExtension("sync-base")
        if let library { try JSONEncoder().encode(library).write(to: dest, options: .atomic) }
        else { try? FileManager.default.removeItem(at: dest) }
    }
}
