// sck-vault is the only process that can use the ElevenLabs key. The key sits in the login Keychain under an ACL
// bound to this exact binary, is read once at start (only from the install path), and is used only for fixed
// ElevenLabs operations that a grant approved by the boss with Touch ID allows. No command or reply returns the key.
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
    static let base = ProcessInfo.processInfo.environment["SCK_VAULT_TEST_BASE_URL"] ?? "https://api.elevenlabs.io"
    #else
    static let socket = Build.home + "/vault/vault.sock"
    static let base = "https://api.elevenlabs.io"
    #endif
    static var dir: String { (socket as NSString).deletingLastPathComponent }
    static var audit: String { dir + "/audit.log" }
}

enum Secrets {
    static var apiKey = Data()
}

// MARK: Keychain

enum Keychain {
    static let service = "sck-vault"
    static let account = "elevenlabs-api-key"

    static func query() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    /// Prompts are allowed on purpose: after a rebuild the boss answers the Keychain dialog once.
    static func read() -> Data? {
        var q = query()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    static func write(_ secret: Data) -> OSStatus {
        if SecItemUpdate(query() as CFDictionary, [kSecValueData as String: secret] as CFDictionary) == errSecSuccess {
            return errSecSuccess
        }
        var me: SecTrustedApplication?
        var acl: SecAccess?
        guard SecTrustedApplicationCreateFromPath(nil, &me) == errSecSuccess, let app = me,
              SecAccessCreate("sck-vault" as CFString, [app] as CFArray, &acl) == errSecSuccess, let access = acl else {
            return errSecParam
        }
        var add = query()
        add[kSecValueData as String] = secret
        add[kSecAttrLabel as String] = "sck-vault ElevenLabs key"
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

// MARK: Boss confirmation

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

/// Executable path of the process on the other end of the socket, so the boss sees who is asking.
func peerPath(_ fd: Int32) -> String {
    var pid: pid_t = 0
    var length = socklen_t(MemoryLayout<pid_t>.size)
    guard getsockopt(fd, 0 /* SOL_LOCAL */, 2 /* LOCAL_PEERPID */, &pid, &length) == 0 else { return "unknown" }
    var buffer = [CChar](repeating: 0, count: 4096)
    guard proc_pidpath(pid, &buffer, 4096) > 0 else { return "pid \(pid)" }
    return String(cString: buffer)
}

// MARK: Fixed ElevenLabs endpoints

struct Endpoint {
    let method: String
    let path: String
    let query: [URLQueryItem]
    let body: Data?
    let timeout: TimeInterval
}

let kindNames = ["tts", "dialogue", "sfx", "music", "voice_design", "voice_create", "voices", "subscription"]

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

func upstream(_ spec: Endpoint) -> (status: Int, body: Data, contentType: String)? {
    guard var parts = URLComponents(string: Paths.base) else { return nil }
    parts.path = spec.path
    parts.queryItems = spec.query.isEmpty ? nil : spec.query
    guard let url = parts.url else { return nil }
    var request = URLRequest(url: url, timeoutInterval: spec.timeout)
    request.httpMethod = spec.method
    request.setValue(String(decoding: Secrets.apiKey, as: UTF8.self), forHTTPHeaderField: "xi-api-key")
    if let body = spec.body {
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "content-type")
    }
    let done = DispatchSemaphore(value: 0)
    var result: (status: Int, body: Data, contentType: String)?
    upstreamSession.dataTask(with: request) { data, response, _ in
        if let http = response as? HTTPURLResponse {
            result = (http.statusCode, data ?? Data(), http.value(forHTTPHeaderField: "content-type") ?? "")
        }
        done.signal()
    }.resume()
    done.wait()
    return result
}

/// Replaces any echo of the key in an upstream reply.
func scrubbed(_ data: Data) -> Data {
    let key = Secrets.apiKey
    guard !key.isEmpty else { return data }
    var out = Data()
    var cursor = data.startIndex
    while let found = data.range(of: key, in: cursor..<data.endIndex) {
        out.append(data[cursor..<found.lowerBound])
        out.append(Data("[已遮盖]".utf8))
        cursor = found.upperBound
    }
    out.append(data[cursor..<data.endIndex])
    return out
}

// MARK: Grants (boss-approved, memory only, lost on restart)

struct Grant {
    let id: String
    let expires: Date
    var callsLeft: [String: Int]
}

enum Grants {
    private static let lock = NSLock()
    private static var items: [String: Grant] = [:]
    private static var approvalInFlight = false

    static func beginApproval() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if approvalInFlight { return false }
        approvalInFlight = true
        return true
    }

    static func endApproval() {
        lock.lock(); defer { lock.unlock() }
        approvalInFlight = false
    }

    private static var deniedUntil = Date.distantPast

    /// A refused request starts a cooldown, so a noisy caller cannot keep the boss's Touch ID prompt on screen.
    static func coolingDown() -> Bool {
        lock.lock(); defer { lock.unlock() }
        return Date() < deniedUntil
    }

    static func startCooldown() {
        lock.lock(); defer { lock.unlock() }
        deniedUntil = Date().addingTimeInterval(60)
    }

    static func add(kinds: [String], calls: Int, minutes: Int) -> Grant {
        lock.lock(); defer { lock.unlock() }
        let id = (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        let grant = Grant(id: id, expires: Date().addingTimeInterval(TimeInterval(minutes * 60)),
                          callsLeft: Dictionary(uniqueKeysWithValues: kinds.map { ($0, calls) }))
        items[id] = grant
        return grant
    }

    /// Any active grant that still covers the kind pays for the call. Callers never learn grant ids.
    static func reserve(_ kind: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        prune()
        guard let grant = items.values.first(where: { ($0.callsLeft[kind] ?? 0) > 0 }),
              var current = items[grant.id] else { return nil }
        current.callsLeft[kind, default: 0] -= 1
        items[grant.id] = current
        return grant.id
    }

    static func refund(_ id: String, _ kind: String) {
        lock.lock(); defer { lock.unlock() }
        guard var grant = items[id] else { return }
        grant.callsLeft[kind, default: 0] += 1
        items[id] = grant
    }

    static func revoke(_ id: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return items.removeValue(forKey: id) != nil
    }

    static func snapshot() -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        prune()
        let formatter = ISO8601DateFormatter()
        return items.values.sorted { $0.expires < $1.expires }.map { grant -> [String: Any] in
            ["id": grant.id, "expiresAt": formatter.string(from: grant.expires), "callsLeft": grant.callsLeft]
        }
    }

    private static func prune() {
        items = items.filter { $0.value.expires > Date() }
    }
}

// MARK: Requests

func requestGrant(_ object: [String: Any], requester: String) -> [String: Any] {
    let kinds = (object["kinds"] as? [String]) ?? []
    let calls = (object["calls"] as? Int) ?? 0
    let minutes = (object["minutes"] as? Int) ?? 0
    guard !kinds.isEmpty, kinds.allSatisfy({ kindNames.contains($0) }), (1...500).contains(calls), (1...720).contains(minutes) else {
        return failure("invalid", "需要 kinds（已知操作）、calls 1-500、minutes 1-720")
    }
    guard !Grants.coolingDown() else { return failure("busy", "上一次请求被拒绝，一分钟后再试") }
    guard Grants.beginApproval() else { return failure("busy", "已有授权请求等待老板确认") }
    defer { Grants.endApproval() }
    let reason = "sck-vault 授权：\(kinds.joined(separator: ", "))，每项最多 \(calls) 次，\(minutes) 分钟内有效。请求方：\(requester)"
    guard Auth.confirm(reason) else {
        Grants.startCooldown()
        return failure("forbidden", "老板未批准")
    }
    let grant = Grants.add(kinds: kinds, calls: calls, minutes: minutes)
    Audit.append(["event": "grant", "grant": grant.id, "kinds": kinds, "calls": calls, "minutes": minutes, "requester": requester])
    return ["ok": true, "grantId": grant.id, "expiresAt": ISO8601DateFormatter().string(from: grant.expires)]
}

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
    guard let grantId = Grants.reserve(kind) else {
        return failure("forbidden", "未获授权：老板未批准该操作，或授权次数已用完、已过期")
    }
    let reply = upstream(spec)
    Audit.append(["event": "call", "kind": kind, "grant": grantId, "status": reply?.status ?? 0, "bytes": reply?.body.count ?? 0])
    guard let reply else {
        Grants.refund(grantId, kind)
        return failure("upstream_error", "ElevenLabs 无响应")
    }
    if !(200..<300).contains(reply.status) { Grants.refund(grantId, kind) }
    return ["ok": true, "status": reply.status, "contentType": reply.contentType, "bodyBase64": scrubbed(reply.body).base64EncodedString()]
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
        writeJSON(fd, ["ok": true, "configured": !Secrets.apiKey.isEmpty, "grants": Grants.snapshot()])
    case "grant":
        writeJSON(fd, requestGrant(object, requester: peerPath(fd)))
    case "revoke":
        let removed = Grants.revoke((object["grantId"] as? String) ?? "")
        writeJSON(fd, removed ? ["ok": true] : failure("invalid", "没有这个授权"))
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
    Secrets.apiKey = Data((ProcessInfo.processInfo.environment["SCK_VAULT_TEST_SECRET"] ?? "").utf8)
    #else
    guard let key = Keychain.read() else { die("钥匙串里没有密钥：请先运行 sck-vault setup") }
    Secrets.apiKey = key
    #endif
    guard !Secrets.apiKey.isEmpty else { die("密钥为空") }
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
    guard Auth.confirm("设置 sck-vault 的 ElevenLabs 密钥（只写入钥匙串，不会显示）") else { die("未获得老板确认") }
    var original = termios()
    let interactive = isatty(STDIN_FILENO) == 1
    if interactive {
        FileHandle.standardError.write(Data("请粘贴 ElevenLabs API key 后回车（输入不会显示）：".utf8))
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
    guard Keychain.write(Data(key.utf8)) == errSecSuccess else { die("写入钥匙串失败") }
    print("已保存到钥匙串。新编译的 sck-vault 第一次读取钥匙串时会弹窗，请选择「始终允许」。")
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

func grantRequest(_ args: [String]) -> [String: Any] {
    func value(_ flag: String) -> String? {
        guard let index = args.firstIndex(of: flag), args.indices.contains(index + 1) else { return nil }
        return args[index + 1]
    }
    return ["op": "grant",
            "kinds": (value("--kinds") ?? "").split(separator: ",").map(String.init),
            "calls": Int(value("--calls") ?? "") ?? 0,
            "minutes": Int(value("--minutes") ?? "") ?? 0]
}

signal(SIGPIPE, SIG_IGN)
let arguments = CommandLine.arguments
switch arguments.count > 1 ? arguments[1] : "" {
case "serve": serve()
case "setup": setup()
case "status": clientRequest(["op": "status"])
case "grant":
    FileHandle.standardError.write(Data("已发送授权请求，请在弹出的 Touch ID 窗口中确认……\n".utf8))
    clientRequest(grantRequest(Array(arguments.dropFirst(2))))
case "revoke" where arguments.count > 2: clientRequest(["op": "revoke", "grantId": arguments[2]])
default:
    print("用法: sck-vault setup | serve | status | grant --kinds K1,K2 --calls N --minutes M | revoke <grantId>")
    exit(2)
}
