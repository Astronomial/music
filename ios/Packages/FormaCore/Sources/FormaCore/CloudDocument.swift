import Foundation

public enum CloudValue: Codable, Equatable, Sendable {
    case null, bool(Bool), number(Double), string(String), array([CloudValue]), object([String: CloudValue])
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let x = try? c.decode(Bool.self) { self = .bool(x) }
        else if let x = try? c.decode(Double.self) { self = .number(x) }
        else if let x = try? c.decode(String.self) { self = .string(x) }
        else if let x = try? c.decode([CloudValue].self) { self = .array(x) }
        else { self = .object(try c.decode([String: CloudValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .null: try c.encodeNil(); case .bool(let x): try c.encode(x); case .number(let x): try c.encode(x); case .string(let x): try c.encode(x); case .array(let x): try c.encode(x); case .object(let x): try c.encode(x) }
    }
    public var object: [String: CloudValue] { if case .object(let x) = self { return x }; return [:] }
    public var array: [CloudValue] { if case .array(let x) = self { return x }; return [] }
    public var text: String? { if case .string(let x) = self { return x }; return nil }
    public var number: Double? { if case .number(let x) = self { return x }; return nil }
    public static func encoded<T: Encodable>(_ x: T) throws -> CloudValue { let e = JSONEncoder(); e.dateEncodingStrategy = .millisecondsSince1970; return try JSONDecoder().decode(CloudValue.self, from: e.encode(x)) }
    public func decoded<T: Decodable>(_ type: T.Type) throws -> T { let d = JSONDecoder(); d.dateDecodingStrategy = .millisecondsSince1970; return try d.decode(type, from: JSONEncoder().encode(self)) }
}
public struct CloudStamp: Codable, Equatable, Sendable, Comparable {
    public var time: Int64
    public var counter: Int
    public var actor: String
    public static func < (a: Self, b: Self) -> Bool { if a.time != b.time { return a.time < b.time }; if a.counter != b.counter { return a.counter < b.counter }; return a.actor < b.actor }
}
public struct CloudRegister: Codable, Equatable, Sendable { public var stamp: CloudStamp; public var value: CloudValue }
public struct CloudDocument: Codable, Sendable {
    public var schema = 2
    public var actor: String
    public var clock: Int64 = 0
    public var counter = 0
    public var records: [String: CloudRegister] = [:]
    public init(actor: String = UUID().uuidString) { self.actor = actor }
    public enum Failure: Error { case invalidDocument, identityConflict }
    public func validated(now: Date = Date()) throws -> CloudDocument {
        func validActor(_ x: String) -> Bool { x.range(of: "^[A-Za-z0-9-]{8,80}$", options: .regularExpression) != nil }
        guard schema == 2, validActor(actor), records.count <= 30000 else { throw Failure.invalidDocument }
        var result = self; result.clock = 0; result.counter = 0
        let maxTime = Int64((now.timeIntervalSince1970 + 86400) * 1000)
        for (key, r) in records {
            guard key.count <= 400, ["track:", "preference:", "hidden:", "playlist:", "member:", "setting:", "event:"].contains(where: key.hasPrefix), r.stamp.time >= 0, r.stamp.time <= maxTime, (0...10000000).contains(r.stamp.counter), validActor(r.stamp.actor), try JSONEncoder().encode(r.value).count <= 50000 else { throw Failure.invalidDocument }
            if r.stamp.time > result.clock { result.clock = r.stamp.time; result.counter = r.stamp.counter } else if r.stamp.time == result.clock { result.counter = max(result.counter, r.stamp.counter) }
        }
        return result
    }
    public static func fields(_ source: Library) throws -> [String: CloudValue] {
        let l = LibraryValidation.normalized(source); var fields: [String: CloudValue] = [:]
        for (id, t) in l.tracks { fields["track:" + id] = try .encoded(t) }
        for id in Set(l.likedIDs + l.dislikedIDs) { fields["preference:" + id] = .string(l.dislikedIDs.contains(id) ? "disliked" : "liked") }
        for id in l.hiddenIDs { fields["hidden:" + id] = .bool(true) }
        for (index, p) in l.playlists.enumerated() {
            fields["playlist:" + p.id] = .object(["id": .string(p.id), "name": .string(p.name), "order": .number(Double(index))])
            for (index, id) in p.trackIDs.enumerated() { fields["member:" + p.id + ":" + id] = .number(Double(index)) }
        }
        for (key, value) in try CloudValue.encoded(l.settings).object { fields["setting:" + key] = value }
        for e in l.events { let time = Int64((e.at.timeIntervalSince1970 * 1000).rounded()), seconds = Int64((e.seconds * 1000).rounded()), ratio = Int64((e.ratio * 1000).rounded()); fields["event:\(e.trackID):\(e.kind.rawValue):\(time):\(seconds):\(ratio)"] = try .encoded(e) }
        return fields
    }
    public func capturing(_ current: Library, base: Library?, now: Date = Date()) throws -> CloudDocument {
        var next = try validated(now: now); let before = try base.map(Self.fields) ?? [:], after = try Self.fields(current)
        for key in Set(before.keys).union(after.keys).sorted() {
            let old = before[key] ?? .null, value = after[key] ?? .null; guard old != value else { continue }
            let time = base == nil ? 1 : max(Int64(now.timeIntervalSince1970 * 1000), next.clock)
            next.counter = time == next.clock ? next.counter + 1 : 0; next.clock = time
            next.records[key] = CloudRegister(stamp: CloudStamp(time: time, counter: next.counter, actor: next.actor), value: value)
        }
        return try next.validated(now: now)
    }
    public func merging(_ remote: CloudDocument, now: Date = Date()) throws -> CloudDocument {
        var a = try validated(now: now); let b = try remote.validated(now: now)
        for (key, value) in b.records {
            if let old = a.records[key] {
                if old.stamp < value.stamp { a.records[key] = value }
                else if old.stamp == value.stamp && old.value != value.value { throw Failure.identityConflict }
            } else { a.records[key] = value }
        }
        return try a.validated(now: now)
    }
    public func publishing(now: Date = Date()) throws -> CloudDocument {
        var next = try validated(now: now)
        for key in next.records.keys.sorted() {
            guard let entry = next.records[key], entry.stamp.actor == actor, entry.stamp.time == 1 else { continue }
            let time = max(Int64(now.timeIntervalSince1970 * 1000), next.clock)
            next.counter = time == next.clock ? next.counter + 1 : 0; next.clock = time
            next.records[key]?.stamp = CloudStamp(time: time, counter: next.counter, actor: actor)
        }
        return try next.validated(now: now)
    }
    public func library() throws -> Library {
        let fields = try validated().records; var result = Library(), settings = try CloudValue.encoded(result.settings).object
        var playlists: [(Double, Playlist)] = []
        for (key, r) in fields {
            guard r.value != .null, let split = key.firstIndex(of: ":") else { continue }
            let kind = String(key[..<split]), id = String(key[key.index(after: split)...])
            switch kind {
            case "track": if let t = try? r.value.decoded(Track.self), t.id == id { result.merge([t]) }
            case "preference": if r.value.text == "liked" { result.likedIDs.append(id) }; if r.value.text == "disliked" { result.dislikedIDs.append(id) }
            case "hidden": if r.value == .bool(true) { result.hiddenIDs.append(id) }
            case "setting": settings[id] = r.value
            case "event": if let event = try? r.value.decoded(ListeningEvent.self) { result.events.append(event) }
            case "playlist":
                let meta = r.value.object; guard meta["id"]?.text == id, let name = meta["name"]?.text else { continue }
                let prefix = "member:" + id + ":"
                let members = fields.filter { $0.key.hasPrefix(prefix) && ($0.value.value.number.map { $0 >= 0 && $0.rounded() == $0 } ?? false) }.sorted { let a = $0.value.value.number ?? 0, b = $1.value.value.number ?? 0; return a == b ? $0.key < $1.key : a < b }
                playlists.append((meta["order"]?.number ?? 0, Playlist(id: id, name: name, trackIDs: members.map { String($0.key.dropFirst(prefix.count)) })))
            default: break
            }
        }
        result.playlists = playlists.sorted { $0.0 == $1.0 ? $0.1.id < $1.1.id : $0.0 < $1.0 }.map(\.1)
        result.events = Array(result.events.sorted { $0.at < $1.at }.suffix(3000)); result.settings = try CloudValue.object(settings).decoded(PulseSettings.self)
        return LibraryValidation.normalized(result)
    }
}
