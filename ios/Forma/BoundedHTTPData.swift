import Foundation

final class BoundedHTTPData: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Data, Error>?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var cancelled = false
    private var data = Data()
    private let limit: Int
    private var failure: Error?
    init(limit: Int = 6 * 1024 * 1024) { self.limit = limit }
    func load(_ input: URLRequest) async throws -> Data {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { c in
                lock.lock()
                if cancelled { lock.unlock(); c.resume(throwing: CancellationError()); return }
                continuation = c
                let config = URLSessionConfiguration.ephemeral; config.allowsCellularAccess = true
                config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 30
                let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1; queue.qualityOfService = .utility
                let session = URLSession(configuration: config, delegate: self, delegateQueue: queue); self.session = session
                var request = input; request.networkServiceType = .background
                let task = session.dataTask(with: request); self.task = task; lock.unlock(); task.resume()
            }
        } onCancel: { self.cancel() }
    }
    private func finish(_ result: Result<Data, Error>) {
        lock.lock(); let c = continuation; continuation = nil; let s = session; session = nil; task = nil; lock.unlock()
        c?.resume(with: result); s?.invalidateAndCancel()
    }
    func cancel() { lock.lock(); cancelled = true; lock.unlock(); finish(.failure(CancellationError())) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), response.expectedContentLength <= limit else { failure = SyncError.rejected("Загрузка аудио: \((response as? HTTPURLResponse)?.statusCode ?? 0). Запрос отклонён или ответ превышает лимит"); completionHandler(.cancel); return }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive incoming: Data) {
        if data.count + incoming.count > limit { dataTask.cancel(); return }; data.append(incoming)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { finish(.failure(failure ?? error)) } else { finish(.success(data)) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

