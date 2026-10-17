import Foundation

public enum RecordingQuality {
    private static let titleRules = [
        #"^(?:(?:royalty free|copyright free|no copyright|stock|instrumental) )?(?:energetic|energy|upbeat|happy|sad|calm|relaxing|relaxation|motivational|inspiring|inspirational|workout|background|study|sleep|meditation|focus|chill)(?: background)? music(?:$| for | vol | mix | playlist | [0-9])"#,
        #"^(?:music for |музыка для |спокойная музыка(?:$| )|энергичная музыка(?:$| )|фоновая музыка(?:$| ))"#
    ].map { try! NSRegularExpression(pattern: $0) }
    private static let artistRule = try! NSRegularExpression(pattern: #"^(?:energetic music|background music|relaxing music|royalty free music|music for |музыка для )"#)
    public static func utility(_ track: Track) -> Bool {
        let title = PulseEngine.fold(track.title), artist = PulseEngine.fold(track.artist)
        let titleRange = NSRange(title.startIndex..., in: title), artistRange = NSRange(artist.startIndex..., in: artist)
        return titleRules.contains { $0.firstMatch(in: title, range: titleRange) != nil } || artistRule.firstMatch(in: artist, range: artistRange) != nil
    }
    public static func allowsUtility(_ library: Library) -> Bool {
        (library.likedIDs + library.playlists.filter { library.settings.playlistSource != "selected" || library.settings.seedPlaylistIDs.contains($0.id) }.flatMap(\.trackIDs)).contains { id in library.tracks[id].map(utility) == true }
    }
}
