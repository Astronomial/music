import SwiftUI
import FormaCore

@MainActor
struct ArtistView: View {
    @ObservedObject var model: AppModel
    let artistTrack: Track
    @State private var tracks: [Track] = []
    @State private var loading = true
    @State private var error: String?
    @State private var retry = 0
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                Label("Исполнитель", systemImage: "person.crop.circle").foregroundStyle(.secondary)
                Text(artistTrack.artist).font(.largeTitle.bold())
                if let first = tracks.first { Button { model.play(first, list: tracks) } label: { Label("Слушать", systemImage: "play.fill") }.buttonStyle(.borderedProminent).primaryActionForeground() }
                if loading { ProgressView("Загружаем…") }
                if let error { Text(error).foregroundStyle(.secondary); Button("Повторить") { retry += 1 } }
                if !loading, error == nil, tracks.isEmpty { Text("Треки исполнителя пока не найдены.").foregroundStyle(.secondary) }
                ForEach(tracks) { track in TrackRow(model: model, track: track) { model.play(track, list: tracks) } }
            }.padding(20)
        }.cosmicBackground().navigationBarTitleDisplayMode(.inline)
            .task(id: retry) {
                loading = true; error = nil
                do { let result = try await model.tracksForArtist(artistTrack); try Task.checkCancellation(); tracks = result }
                catch is CancellationError { }
                catch { self.error = error.localizedDescription }
                if !Task.isCancelled { loading = false }
            }
    }
}
