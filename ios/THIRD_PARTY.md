# Использованный открытый код

## YouTubeKit

- Автор: **Alexander Eichhorn**.
- Репозиторий: https://github.com/alexeichhorn/YouTubeKit
- Закреплённый commit: **e5b7d0396ce12bf3444f0d209e8436c83373b7af**.
- Лицензия: **MIT**, полный текст сохранён в `Vendor/YouTubeKit/LICENSE`.
- В `Vendor/YouTubeKit` включены исходники, ресурсы, тесты, README и manifest этого commit. Swift/JavaScript-код не изменён. В `Package.swift` только установлен минимальный deployment target iOS 17/macOS 14. Происхождение записано в `UPSTREAM.json`.
- Используется напрямую через **local Swift Package** в Xcode. Авторство сохранено в исходниках и доступно внутри приложения: «Настройка Пульса» → «Авторы и лицензии».
- Вызов `YouTube(..., methods: [.local], useOAuth: false)` явно отключает автоматический переход на чужой сервер. Модуль выполняет получение потока на телефоне; это не режим прослушивания локальных файлов.

## Ресурсы внутри YouTubeKit

| Ресурс | Происхождение | Лицензия |
| --- | --- | --- |
| `astring.umd.js` | [Astring / David Bonnet](https://github.com/davidbonnet/astring) | MIT, `ASTRING-LICENSE` |
| `meriyah.umd.js`, версия 6.1.4 | [Meriyah / KFlash и участники](https://github.com/meriyah/meriyah) | ISC, `MERIYAH-LICENSE` |
| `yt_ejs_helper.js` | [yt-dlp/ejs](https://github.com/yt-dlp/ejs), источник указан в заголовке файла | Unlicense, `EJS-LICENSE` |

Полные уведомления входят в `Forma/Resources/ThirdPartyNotices.txt` и в собранное приложение. MIT-лицензия собственного кода iOS находится в `ios/LICENSE`; она не заменяет лицензии включённых сторонних файлов и не распространяется автоматически на остальной Windows-проект.

NewPipe, Metrolist и Yattee изучены как примеры архитектуры. Их исходники в заготовку не скопированы. Воспроизведение, SwiftUI-интерфейс и мобильное ядро Пульса написаны для Forma; получение потоков использует YouTubeKit.
