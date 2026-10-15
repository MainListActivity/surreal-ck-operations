// sck-vault is the only process that can use provider keys (ElevenLabs, sync.so). Each key sits in the login
// Keychain under an ACL bound to this exact binary, is read once at start (only from the install path), and is
// used only for fixed per-provider operations. The only guarantee this process makes is that keys never leave it.
// vault/build.sh builds it ad-hoc signed with the hardened runtime and no entitlements.
import CryptoKit
import Darwin
import Foundation
import LocalAuthentication
import Security

struct VaultError: Error {
    let code: String
    let message: String
}

func failure(_ code: String, _ message: String) -> [String: Any] {
    ["ok": false, "code": code, "message": message]
}

func die(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

enum Paths {
    #if SCK_VAULT_TEST
    static let socket = ProcessInfo.processInfo.environment["SCK_VAULT_TEST_SOCKET"] ?? "/tmp/sck-vault-test.sock"
    static let baseElevenlabs = ProcessInfo.processInfo.environment["SCK_VAULT_TEST_BASE_URL"] ?? "https://api.elevenlabs.io"
    static let baseSync = ProcessInfo.processInfo.environment["SCK_VAULT_SYNC_TEST_BASE_URL"] ?? "https://api.sync.so"
    #else
    static let socket = Build.home + "/vault/vault.sock"
    static let baseElevenlabs = "https://api.elevenlabs.io"
    static let baseSync = "https://api.sync.so"
    #endif
    static var dir: String { (socket as NSString).deletingLastPathComponent }
    static var audit: String { dir + "/audit.log" }
    static func base(_ provider: String) -> String { provider == "sync" ? baseSync : baseElevenlabs }
}

enum Secrets {
    /// Provider name to key material; "elevenlabs" and "sync" are the only names ever used.
    static var keys: [String: Data] = [:]
}

// MARK: Keychain

enum Keychain {
    static let service = "sck-vault"
    static func account(_ provider: String) -> String { "\(provider)-api-key" }

    static func query(_ provider: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account(provider)]
    }

    /// Prompts are allowed on purpose: after a rebuild the boss answers the Keychain dialog once.
    static func read(_ provider: String) -> Data? {
        var q = query(provider)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    static func write(_ secret: Data, _ provider: String) -> OSStatus {
        if SecItemUpdate(query(provider) as CFDictionary, [kSecValueData as String: secret] as CFDictionary) == errSecSuccess {
            return errSecSuccess
        }
        var me: SecTrustedApplication?
        var acl: SecAccess?
        guard SecTrustedApplicationCreateFromPath(nil, &me) == errSecSuccess, let app = me,
              SecAccessCreate("sck-vault \(provider) key" as CFString, [app] as CFArray, &acl) == errSecSuccess, let access = acl else {
            return errSecParam
        }
        var add = query(provider)
        add[kSecValueData as String] = secret
        add[kSecAttrLabel as String] = "sck-vault \(provider) key"
        add[kSecAttrAccess as String] = access
        return SecItemAdd(add as CFDictionary, nil)
    }
}

/// The Keychain ACL trusts any byte-identical copy of this binary, so the key is only read from the install path.
func runningFromInstallPath() -> Bool {
    #if SCK_VAULT_TEST
    return true
    #else
    var size: UInt32 = 0
    _ = _NSGetExecutablePath(nil, &size)
    var buffer = [CChar](repeating: 0, count: Int(size))
    guard _NSGetExecutablePath(&buffer, &size) == 0 else { return false }
    let running = URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath().path
    return running == URL(fileURLWithPath: Build.installPath).resolvingSymlinksInPath().path
    #endif
}

/// One-time boss confirmation for writing the key itself. Call-time operations need no human.
enum Auth {
    static func confirm(_ reason: String) -> Bool {
        #if SCK_VAULT_TEST
        return ProcessInfo.processInfo.environment["SCK_VAULT_TEST_AUTO_APPROVE"] == "1"
        #else
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else { return false }
        let done = DispatchSemaphore(value: 0)
        var approved = false
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
            approved = ok
            done.signal()
        }
        done.wait()
        return approved
        #endif
    }
}

// MARK: Audit (hash chain; the key itself is never written)

enum Audit {
    private static let lock = NSLock()
    private static var previous = String(repeating: "0", count: 64)

    static func resume() {
        lock.lock(); defer { lock.unlock() }
        guard let data = FileManager.default.contents(atPath: Paths.audit),
              let last = data.split(separator: 0x0a).last.map({ Data($0) }),
              let object = try? JSONSerialization.jsonObject(with: last) as? [String: Any],
              let hash = object["hash"] as? String else { return }
        previous = hash
    }

    static func append(_ entry: [String: Any]) {
        lock.lock(); defer { lock.unlock() }
        var record = entry
        record["ts"] = ISO8601DateFormatter().string(from: Date())
        record["prev"] = previous
        guard let body = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) else { return }
        let hash = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
        previous = hash
        record["hash"] = hash
        guard let line = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) else { return }
        let fd = open(Paths.audit, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        guard fd >= 0 else { return }
        defer { close(fd) }
        writeAll(fd, line + Data([0x0a]))
    }
}

// MARK: Socket

func unixAddress(_ path: String) -> sockaddr_un {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let bytes = Array(path.utf8.prefix(MemoryLayout.size(ofValue: addr.sun_path) - 1))
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
        for (index, byte) in bytes.enumerated() { raw[index] = byte }
    }
    return addr
}

func listenSocket(_ path: String) -> Int32 {
    unlink(path)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    var addr = unixAddress(path)
    let bound = withUnsafePointer(to: &addr) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard fd >= 0, bound == 0, chmod(path, 0o600) == 0, listen(fd, 16) == 0 else { die("无法监听 \(path)") }
    return fd
}

func connectSocket(_ path: String) -> Int32? {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    var addr = unixAddress(path)
    let connected = withUnsafePointer(to: &addr) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard connected == 0 else { close(fd); return nil }
    return fd
}

/// One newline-terminated request, at most 4 MiB.
func readRequest(_ fd: Int32) -> Data? {
    var data = Data()
    var chunk = [UInt8](repeating: 0, count: 65_536)
    while data.count <= 4 << 20 {
        let count = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress, 65_536) }
        if count <= 0 { return nil }
        if let newline = chunk[0..<count].firstIndex(of: 0x0a) {
            data.append(contentsOf: chunk[0..<newline])
            return data
        }
        data.append(contentsOf: chunk[0..<count])
    }
    return nil
}

func writeAll(_ fd: Int32, _ data: Data) {
    data.withUnsafeBytes { raw in
        var offset = 0
        while offset < raw.count {
            let written = write(fd, raw.baseAddress! + offset, raw.count - offset)
            if written <= 0 { return }
            offset += written
        }
    }
}

func writeJSON(_ fd: Int32, _ object: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{\"ok\":false}".utf8)
    writeAll(fd, data + Data([0x0a]))
}

// MARK: Fixed provider endpoints

struct Endpoint {
    let method: String
    let path: String
    let query: [URLQueryItem]
    let body: Data?
    let timeout: TimeInterval
    var provider: String = "elevenlabs"
    var extraHeaders: [(String, String)] = []
}

let kindNames = ["tts", "dialogue", "sfx", "music", "voice_design", "voice_create", "voices", "subscription",
                 "sync_models", "sync_errors", "sync_asset_presign", "sync_asset_register",
                 "sync_estimate", "sync_generate", "sync_get", "sync_download_url",
                 "sync_projects", "sync_generations", "sync_project_create"]

func jsonBody(_ object: [String: Any]) throws -> Data {
    guard let data = try? JSONSerialization.data(withJSONObject: object), data.count <= 1 << 20 else {
        throw VaultError(code: "invalid", message: "params 必须是 JSON 对象，且不超过 1 MiB")
    }
    return data
}

/// The caller picks a kind and a JSON body; it never picks a URL, host or header.
func endpoint(_ kind: String, _ params: [String: Any]) throws -> Endpoint {
    let mp3 = [URLQueryItem(name: "output_format", value: "mp3_44100_128")]
    switch kind {
    case "tts":
        guard let voice = params["voiceId"] as? String, voice.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil else {
            throw VaultError(code: "invalid", message: "voiceId 不合法")
        }
        var body = params
        body["voiceId"] = nil
        return Endpoint(method: "POST", path: "/v1/text-to-speech/\(voice)", query: mp3, body: try jsonBody(body), timeout: 120)
    case "dialogue":
        return Endpoint(method: "POST", path: "/v1/text-to-dialogue", query: mp3, body: try jsonBody(params), timeout: 120)
    case "sfx":
        return Endpoint(method: "POST", path: "/v1/sound-generation", query: mp3, body: try jsonBody(params), timeout: 120)
    case "music":
        return Endpoint(method: "POST", path: "/v1/music", query: mp3, body: try jsonBody(params), timeout: 300)
    case "voice_design":
        return Endpoint(method: "POST", path: "/v1/text-to-voice/design", query: [], body: try jsonBody(params), timeout: 120)
    case "voice_create":
        return Endpoint(method: "POST", path: "/v1/text-to-voice", query: [], body: try jsonBody(params), timeout: 120)
    case "voices":
        let search = String((params["search"] as? String ?? "").prefix(200))
        return Endpoint(method: "GET", path: "/v2/voices",
                        query: [URLQueryItem(name: "search", value: search), URLQueryItem(name: "page_size", value: "50")],
                        body: nil, timeout: 120)
    case "subscription":
        return Endpoint(method: "GET", path: "/v1/user/subscription", query: [], body: nil, timeout: 120)

    // sync.so (sync-3): fixed v2 endpoints. The caller still never picks a URL, host or header; the
    // only caller-controlled header is the Idempotency-Key the trusted studio already bound to a digest.
    case "sync_models":
        return Endpoint(method: "GET", path: "/v2/models", query: [], body: nil, timeout: 60, provider: "sync")
    case "sync_errors":
        return Endpoint(method: "GET", path: "/v2/errors", query: [], body: nil, timeout: 60, provider: "sync")
    case "sync_asset_presign":
        let fileOk = "^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$"
        guard let fileName = params["fileName"] as? String, fileName.range(of: fileOk, options: .regularExpression) != nil,
              [".mp4", ".wav", ".png", ".jpg", ".jpeg"].contains(where: { fileName.lowercased().hasSuffix($0) }) else {
            throw VaultError(code: "invalid", message: "fileName 不合法")
        }
        guard let contentType = params["contentType"] as? String,
              ["video/mp4", "audio/wav", "audio/x-wav", "audio/wave", "image/png", "image/jpeg"].contains(contentType) else {
            throw VaultError(code: "invalid", message: "contentType 不在白名单")
        }
        guard let size = (params["size"] as? NSNumber)?.intValue, size > 0, size <= 5 << 30 else {
            throw VaultError(code: "invalid", message: "size 不合法")
        }
        return Endpoint(method: "POST", path: "/v2/assets/upload", query: [],
                        body: try jsonBody(["fileName": fileName, "contentType": contentType, "size": size]),
                        timeout: 60, provider: "sync")
    case "sync_asset_register":
        guard let url = params["url"] as? String, url.count <= 2048,
              url.range(of: "^https://", options: .regularExpression) != nil else {
            throw VaultError(code: "invalid", message: "url 不合法")
        }
        guard let type = params["type"] as? String, ["VIDEO", "AUDIO", "IMAGE"].contains(type) else {
            throw VaultError(code: "invalid", message: "type 不合法")
        }
        var body: [String: Any] = ["url": url, "type": type]
        if let name = params["name"] as? String {
            guard name.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$", options: .regularExpression) != nil else {
                throw VaultError(code: "invalid", message: "name 不合法")
            }
            body["name"] = name
        }
        return Endpoint(method: "POST", path: "/v2/assets", query: [], body: try jsonBody(body), timeout: 60, provider: "sync")
    case "sync_estimate":
        guard params["model"] as? String == "sync-3" else {
            throw VaultError(code: "invalid", message: "model 固定为 sync-3")
        }
        guard let duration = (params["duration"] as? NSNumber)?.doubleValue, duration > 0, duration <= 3600 else {
            throw VaultError(code: "invalid", message: "duration 不合法")
        }
        var body: [String: Any] = ["model": "sync-3", "duration": duration]
        if let raw = params["fps"], !(raw is NSNull) {
            guard let fps = (raw as? NSNumber)?.doubleValue, fps > 0, fps <= 120 else {
                throw VaultError(code: "invalid", message: "fps 不合法")
            }
            body["fps"] = fps
        }
        return Endpoint(method: "POST", path: "/v2/generations/estimate", query: [], body: try jsonBody(body), timeout: 60, provider: "sync")
    case "sync_generate":
        guard let key = params["idempotencyKey"] as? String,
              key.range(of: "^[A-Za-z0-9._~-]{1,128}$", options: .regularExpression) != nil else {
            throw VaultError(code: "invalid", message: "idempotencyKey 不合法")
        }
        var body = params
        body["idempotencyKey"] = nil
        guard body["model"] as? String == "sync-3" else {
            throw VaultError(code: "invalid", message: "model 固定为 sync-3")
        }
        return Endpoint(method: "POST", path: "/v2/generate", query: [], body: try jsonBody(body),
                        timeout: 60, provider: "sync", extraHeaders: [("Idempotency-Key", key)])
    case "sync_get":
        guard let id = params["id"] as? String,
              id.range(of: "^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$", options: .regularExpression) != nil else {
            throw VaultError(code: "invalid", message: "id 不合法")
        }
        let wait = params["wait"] as? Bool ?? false
        let include = params["include"] as? String
        if wait, include != nil { throw VaultError(code: "invalid", message: "wait 与 include 互斥") }
        var query: [URLQueryItem] = []
        if wait {
            let timeout = (params["timeout"] as? NSNumber)?.intValue ?? 5
            guard timeout >= 1, timeout <= 10 else { throw VaultError(code: "invalid", message: "timeout 需在 1-10 秒") }
            query.append(URLQueryItem(name: "wait", value: "true"))
            query.append(URLQueryItem(name: "timeout", value: String(timeout)))
        }
        if let include {
            guard include == "progress" else { throw VaultError(code: "invalid", message: "include 只支持 progress") }
            query.append(URLQueryItem(name: "include", value: "progress"))
        }
        return Endpoint(method: "GET", path: "/v2/generate/\(id)", query: query, body: nil, timeout: 75, provider: "sync")
    case "sync_download_url":
        guard let id = params["id"] as? String,
              id.range(of: "^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$", options: .regularExpression) != nil else {
            throw VaultError(code: "invalid", message: "id 不合法")
        }
        return Endpoint(method: "GET", path: "/v2/generations/\(id)/download", query: [], body: nil, timeout: 60, provider: "sync")
    case "sync_project_create":
        // The only controlled write on this surface: one idempotent project creation per key, run
        // by sync_project_prepare. The studio fixes the body to {"name": …} and owns a
        // ledger-persisted client UUID as the Idempotency-Key, so a replayed call can never mint
        // a second project; the caller still never picks a URL, host or any other header.
        guard let name = params["name"] as? String,
              name.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", options: .regularExpression) != nil else {
            throw VaultError(code: "invalid", message: "name 不合法")
        }
        guard let key = params["idempotencyKey"] as? String,
              key.range(of: "^[A-Za-z0-9._~-]{1,128}$", options: .regularExpression) != nil else {
            throw VaultError(code: "invalid", message: "idempotencyKey 不合法")
        }
        return Endpoint(method: "POST", path: "/v2/projects", query: [], body: try jsonBody(["name": name]),
                        timeout: 60, provider: "sync", extraHeaders: [("Idempotency-Key", key)])
    case "sync_projects", "sync_generations":
        // Read-only org-side listings: projects prove org membership, generations prove consumption.
        // limit 1-100 and an opaque cursor are the only caller-controlled parameters.
        var query: [URLQueryItem] = []
        if let raw = params["limit"], !(raw is NSNull) {
            guard let limit = (raw as? NSNumber)?.intValue, limit >= 1, limit <= 100 else {
                throw VaultError(code: "invalid", message: "limit 需在 1-100")
            }
            query.append(URLQueryItem(name: "limit", value: String(limit)))
        }
        if let raw = params["cursor"], !(raw is NSNull) {
            guard let cursor = raw as? String,
                  cursor.range(of: "^[A-Za-z0-9][A-Za-z0-9._~+/=-]{0,511}$", options: .regularExpression) != nil else {
                throw VaultError(code: "invalid", message: "cursor 不合法")
            }
            query.append(URLQueryItem(name: "cursor", value: cursor))
        }
        let path = kind == "sync_projects" ? "/v2/projects" : "/v2/generations"
        return Endpoint(method: "GET", path: path, query: query, body: nil, timeout: 60, provider: "sync")
    default:
        throw VaultError(code: "invalid", message: "未知操作类型")
    }
}

final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil) // the key header must never reach another host
    }
}

let upstreamSession = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)

func upstream(_ spec: Endpoint) -> (status: Int, body: Data, contentType: String, headers: [String: String])? {
    guard var parts = URLComponents(string: Paths.base(spec.provider)) else { return nil }
    parts.path = spec.path
    parts.queryItems = spec.query.isEmpty ? nil : spec.query
    guard let url = parts.url else { return nil }
    var request = URLRequest(url: url, timeoutInterval: spec.timeout)
    request.httpMethod = spec.method
    let key = Secrets.keys[spec.provider] ?? Data()
    request.setValue(String(decoding: key, as: UTF8.self),
                     forHTTPHeaderField: spec.provider == "sync" ? "x-api-key" : "xi-api-key")
    for (name, value) in spec.extraHeaders {
        request.setValue(value, forHTTPHeaderField: name)
    }
    if let body = spec.body {
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "content-type")
    }
    let done = DispatchSemaphore(value: 0)
    var result: (status: Int, body: Data, contentType: String, headers: [String: String])?
    upstreamSession.dataTask(with: request) { data, response, _ in
        if let http = response as? HTTPURLResponse {
            // Only these whitelisted headers travel back; nothing signed or secret-bearing does.
            var headers: [String: String] = [:]
            for name in ["idempotency-replayed", "retry-after"] {
                if let value = http.value(forHTTPHeaderField: name) { headers[name] = value }
            }
            result = (http.statusCode, data ?? Data(), http.value(forHTTPHeaderField: "content-type") ?? "", headers)
        }
        done.signal()
    }.resume()
    done.wait()
    return result
}

/// Replaces any echo of either key in an upstream reply.
func scrubbed(_ data: Data) -> Data {
    var out = data
    for key in Secrets.keys.values where !key.isEmpty {
        var replaced = Data()
        var cursor = out.startIndex
        while let found = out.range(of: key, in: cursor..<out.endIndex) {
            replaced.append(out[cursor..<found.lowerBound])
            replaced.append(Data("[已遮盖]".utf8))
            cursor = found.upperBound
        }
        replaced.append(out[cursor..<out.endIndex])
        out = replaced
    }
    return out
}

// MARK: Requests

func performCall(_ object: [String: Any]) -> [String: Any] {
    guard let kind = object["kind"] as? String else { return failure("invalid", "需要 kind") }
    let params = (object["params"] as? [String: Any]) ?? [:]
    let spec: Endpoint
    do {
        spec = try endpoint(kind, params)
    } catch let error as VaultError {
        return failure(error.code, error.message)
    } catch {
        return failure("invalid", "参数不合法")
    }
    guard !(Secrets.keys[spec.provider] ?? Data()).isEmpty else {
        return failure("not_configured", "\(spec.provider) 的密钥未配置：请运行 sck-vault setup \(spec.provider)")
    }
    let reply = upstream(spec)
    Audit.append(["event": "call", "kind": kind, "provider": spec.provider,
                  "status": reply?.status ?? 0, "bytes": reply?.body.count ?? 0])
    guard let reply else { return failure("upstream_error", "\(spec.provider) 无响应") }
    var out: [String: Any] = ["ok": true, "status": reply.status, "contentType": reply.contentType,
                            "bodyBase64": scrubbed(reply.body).base64EncodedString()]
    if !reply.headers.isEmpty { out["headers"] = reply.headers }
    return out
}

func handle(_ fd: Int32) {
    defer { close(fd) }
    guard let raw = readRequest(fd), let object = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any],
          let op = object["op"] as? String else {
        writeJSON(fd, failure("invalid", "请求格式错误"))
        return
    }
    switch op {
    case "status":
        var providers: [String: Any] = [:]
        for name in ["elevenlabs", "sync"] {
            let key = Secrets.keys[name] ?? Data()
            var entry: [String: Any] = ["configured": !key.isEmpty]
            if !key.isEmpty {
                entry["keyFp"] = SHA256.hash(data: key).prefix(8).map { String(format: "%02x", $0) }.joined()
            }
            providers[name] = entry
        }
        // Top-level "configured" keeps its original meaning (the ElevenLabs key) for existing clients.
        writeJSON(fd, ["ok": true, "configured": !(Secrets.keys["elevenlabs"] ?? Data()).isEmpty,
                       "providers": providers])
    case "call":
        writeJSON(fd, performCall(object))
    default:
        writeJSON(fd, failure("invalid", "未知请求"))
    }
}

// MARK: Commands

func serve() -> Never {
    guard runningFromInstallPath() else { die("sck-vault 只能从安装路径运行") }
    umask(0o077)
    if let running = connectSocket(Paths.socket) {
        close(running)
        die("sck-vault 已在运行")
    }
    #if SCK_VAULT_TEST
    Secrets.keys["elevenlabs"] = Data((ProcessInfo.processInfo.environment["SCK_VAULT_TEST_SECRET"] ?? "").utf8)
    Secrets.keys["sync"] = Data((ProcessInfo.processInfo.environment["SCK_VAULT_SYNC_TEST_SECRET"] ?? "").utf8)
    #else
    Secrets.keys["elevenlabs"] = Keychain.read("elevenlabs") ?? Data()
    Secrets.keys["sync"] = Keychain.read("sync") ?? Data()
    #endif
    guard Secrets.keys.values.contains(where: { !$0.isEmpty }) else { die("钥匙串里没有密钥：请先运行 sck-vault setup") }
    Audit.resume()
    try? FileManager.default.createDirectory(atPath: Paths.dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let listener = listenSocket(Paths.socket)
    FileHandle.standardError.write(Data("sck-vault listening on \(Paths.socket)\n".utf8))
    while true {
        let client = accept(listener, nil, nil)
        if client >= 0 { DispatchQueue.global().async { handle(client) } }
    }
}

func setup() -> Never {
    guard runningFromInstallPath() else { die("sck-vault 只能从安装路径运行") }
    let provider = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "elevenlabs"
    guard ["elevenlabs", "sync"].contains(provider) else { die("未知 provider：\(provider)") }
    guard Auth.confirm("设置 sck-vault 的 \(provider) 密钥（只写入钥匙串，不会显示）") else { die("未获得老板确认") }
    var original = termios()
    let interactive = isatty(STDIN_FILENO) == 1
    if interactive {
        FileHandle.standardError.write(Data("请粘贴 \(provider) API key 后回车（输入不会显示）：".utf8))
        tcgetattr(STDIN_FILENO, &original)
        var quiet = original
        quiet.c_lflag &= ~tcflag_t(ECHO)
        tcsetattr(STDIN_FILENO, TCSANOW, &quiet)
    }
    let line = readLine(strippingNewline: true) ?? ""
    if interactive {
        tcsetattr(STDIN_FILENO, TCSANOW, &original)
        FileHandle.standardError.write(Data("\n".utf8))
    }
    let key = line.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !key.isEmpty else { die("没有输入密钥") }
    guard Keychain.write(Data(key.utf8), provider) == errSecSuccess else { die("写入钥匙串失败") }
    print("已保存到钥匙串（provider: \(provider)）。用稳定签名身份（SCK Vault Code Sign）构建的 sck-vault 只在首次读取钥匙串时弹窗一次；ad-hoc 构建则每次重建都会弹窗。出现弹窗请选「始终允许」。")
    exit(0)
}

func clientRequest(_ request: [String: Any]) -> Never {
    guard let fd = connectSocket(Paths.socket) else { die("sck-vault 未运行") }
    guard let body = try? JSONSerialization.data(withJSONObject: request) else { die("请求格式错误") }
    writeAll(fd, body + Data([0x0a]))
    let reply = readRequest(fd)
    close(fd)
    guard let reply else { die("sck-vault 没有回复") }
    print(String(decoding: reply, as: UTF8.self))
    exit(0)
}

signal(SIGPIPE, SIG_IGN)
switch CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "" {
case "serve": serve()
case "setup": setup()
case "status": clientRequest(["op": "status"])
default:
    print("用法: sck-vault setup [elevenlabs|sync] | serve | status")
    exit(2)
}
