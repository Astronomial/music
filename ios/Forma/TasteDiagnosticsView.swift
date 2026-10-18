import SwiftUI
import FormaCore

@MainActor
struct TasteDiagnosticsView: View {
    @ObservedObject var model: AppModel
    private var profile: TasteProfile { model.tasteProfile }
    private var genres: [String] { profile.genres.keys.sorted { (profile.genres[$0] ?? 0) > (profile.genres[$1] ?? 0) } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                GlassPanel {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(profile.likesLead ? "Лайки задают направление" : "Лайки и плейлисты равноправны").font(.headline)
                        Text("Любимое: \(profile.likedIDs.count) · В основе вкуса: \(profile.explicitIDs.count - profile.missingIDs.count) треков")
                        Text(profile.likesLead ? "После 100 лайков сохранённые в любимое треки имеют больший вес. Плейлисты дополняют вкус." : "Начиная со 100 лайков Пульс будет сильнее ориентироваться на любимое.").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                GlassPanel {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Исполнители").font(.headline)
                        ForEach(Array(profile.artistNames.prefix(12)), id: \.self) { Text($0) }
                        if profile.artists.isEmpty { Text("Добавь любимые треки или перенеси плейлист с ПК").foregroundStyle(.secondary) }
                    }
                }
                GlassPanel {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Жанры").font(.headline)
                        Text("Подтверждены у \(profile.confirmedGenreCount) сохранённых треков").font(.subheadline).foregroundStyle(.secondary)
                        ForEach(Array(genres.prefix(8)), id: \.self) { Text($0) }
                        Text("Неизвестный жанр не угадывается по поисковому запросу. Для таких треков учитываются исполнитель, музыкальные связи и анализ звучания.").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                GlassPanel {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Открытия").font(.headline)
                        Text("В кеше: \(model.library.tracks.count) · Загружено страниц: \(model.discoveredPages)")
                        Text("Пульс ищет новые записи в YouTube и пополняет очередь заранее. Кеш — лишь часть доступной музыки; полного списка всех записей YouTube сервис не предоставляет.").font(.footnote).foregroundStyle(.secondary)
                        Button("Обновить Пульс") { Task { await model.refresh() } }.disabled(model.isRefreshing)
                        if !profile.missingIDs.isEmpty { Text("Не хватает сведений о \(profile.missingIDs.count) сохранённых треках. Повтори обмен библиотекой с ПК.").font(.footnote) }
                    }
                }
            }.padding(20)
        }.cosmicBackground().navigationTitle("Твой вкус").navigationBarTitleDisplayMode(.inline)
    }
}
