import SwiftUI
import FormaCore

@MainActor
struct PlaylistsView: View {
    @ObservedObject var model: AppModel
    @State private var create = false
    @State private var name = ""
    var body: some View {
        List {
            NavigationLink { LibraryView(model: model) } label: { Label("Любимые треки · \(model.liked.count)", systemImage: "heart.fill").font(.headline).padding(.vertical, 12) }
            Section("Плейлисты") {
                ForEach(model.library.playlists) { playlist in
                    NavigationLink { PlaylistView(model: model, playlistID: playlist.id) } label: {
                        HStack(spacing: 14) {
                            Artwork(track: model.playlistTracks(playlist.id).first)
                            VStack(alignment: .leading, spacing: 5) { Text(playlist.name).font(.headline); Text("\(playlist.trackIDs.count) треков").font(.subheadline).foregroundStyle(.secondary) }
                        }.padding(.vertical, 4)
                    }.contextMenu { Button("Удалить плейлист", role: .destructive) { model.deletePlaylist(playlist.id) } }
                }
                if model.library.playlists.isEmpty { Text("Создай плейлист или перенеси его с ПК в настройках.").foregroundStyle(.secondary) }
            }
        }.scrollContentBackground(.hidden).background(FormaTheme.background).navigationTitle("Библиотека")
            .toolbar { Button { create = true } label: { Image(systemName: "plus") }.accessibilityLabel("Создать плейлист") }
            .alert("Новый плейлист", isPresented: $create) {
                TextField("Название", text: $name)
                Button("Создать") { model.createPlaylist(name); name = "" }
                Button("Отмена", role: .cancel) {}
            }
    }
}
@MainActor
struct PlaylistView: View {
    @ObservedObject var model: AppModel
    let playlistID: String
    @State private var rename = false
    @State private var name = ""
    var body: some View {
        let tracks = model.playlistTracks(playlistID)
        let title = model.library.playlists.first { $0.id == playlistID }?.name ?? "Плейлист"
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                Text(title).font(.largeTitle.bold())
                Text("\(tracks.count) треков · Твоя точка отправления").foregroundStyle(.secondary)
                HStack {
                    Button { if let first = tracks.first { model.play(first, list: tracks) } } label: { Label("Слушать", systemImage: "play.fill") }.buttonStyle(.borderedProminent)
                    Button { model.startPulse(playlistID: playlistID) } label: { Label("Пульс", systemImage: "waveform") }.buttonStyle(.bordered)
                }.disabled(tracks.isEmpty)
                ForEach(tracks) { track in
                    TrackRow(model: model, track: track) { model.play(track, list: tracks) }
                        .contextMenu { Button("Убрать из плейлиста", role: .destructive) { model.remove(track, from: playlistID) } }
                }
                if tracks.isEmpty { EmptyState(title: "Добавь музыку", text: "Найди трек и открой его меню, чтобы добавить в этот плейлист.") }
            }.padding(20)
        }.background(FormaTheme.background).navigationBarTitleDisplayMode(.inline)
            .task { await model.prepareTracks(tracks) }
            .toolbar { Button("Изменить") { name = title; rename = true } }
            .alert("Название плейлиста", isPresented: $rename) {
                TextField("Название", text: $name)
                Button("Сохранить") { model.renamePlaylist(playlistID, name: name) }; Button("Отмена", role: .cancel) {}
            }
    }
}
