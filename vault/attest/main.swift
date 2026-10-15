// sck-sync-attest is the owner-only landing entry for a free-trial sync-3 spend-approval
// artifact. The boss feeds it console screenshots (billing plan + payment method, projects
// page with the org marker, both carrying a timestamp) AND declares each file's real capture
// time — never inferred from mtime or landing time. The tool hashes the evidence, binds every
// file's SHA256 to its declared capturedAt, takes the org binding from the controlled
// sync_project_prepare ledger (unique organizationId + project ID per key — an empty or
// multi-org org cannot have a ready record), asks for device-owner confirmation plus typed
// attestations, then writes a single-use free-trial artifact into
// <serviceHome>/private/sync/approvals/. The artifact's capturedAt is the EARLIEST evidence
// capture time, issuedAt is the landing time — re-landing old screenshots can never refresh
// the 2h qualification window. Screenshot bytes never leave this process and are never shown
// to employees or the model. vault/build.sh builds it alongside sck-vault.
import CryptoKit
import Foundation
import LocalAuthentication

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("attest: \(message)\n".utf8))
    exit(1)
}

func note(_ message: String) {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
}

enum Paths {
    #if SCK_VAULT_TEST
    static let socket = ProcessInfo.processInfo.environment["SCK_VAULT_TEST_SOCKET"] ?? "/tmp/sck-vault-test.sock"
    static let home = ProcessInfo.processInfo.environment["SCK_ATTEST_TEST_HOME"] ?? "/tmp/sck-attest-test"
    #else
    static let socket = Build.home + "/vault/vault.sock"
    static let home = Build.home
    #endif
    static var approvals: String { home + "/private/sync/approvals" }
    static var log: String { home + "/private/sync/attest-log.jsonl" }
}

/// Same guarantee as sck-vault: the artifact writer is only the installed binary.
func runningFromInstallPath() -> Bool {
    #if SCK_VAULT_TEST
    return true
    #else
    var size: UInt32 = 0
    _ = _NSGetExecutablePath(nil, &size)
    var buffer = [CChar](repeating: 0, count: Int(size))
    guard _NSGetExecutablePath(&buffer, &size) == 0 else { return false }
    let running = URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath().path
    return running == URL(fileURLWithPath: Build.attestInstallPath).resolvingSymlinksInPath().path
    #endif
}

/// One-time device-owner confirmation, identical policy to sck-vault setup.
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

// MARK: Minimal vault socket client (newline-JSON, same wire format as sck-vault)

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

func readReply(_ fd: Int32) -> Data? {
    var data = Data()
    var chunk = [UInt8](repeating: 0, count: 65_536)
    while data.count <= 4 << 20 {
        let count = chunk.withUnsafeMutableBufferPointer { read(fd, $0.baseAddress, 65_536) }
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

/// One request per connection; returns the parsed reply or nil on any transport failure.
func vaultRequest(_ object: [String: Any]) -> [String: Any]? {
    guard let fd = connectSocket(Paths.socket) else { return nil }
    defer { close(fd) }
    guard let body = try? JSONSerialization.data(withJSONObject: object) else { return nil }
    writeAll(fd, body + Data([0x0a]))
    guard let raw = readReply(fd) else { return nil }
    return try? JSONSerialization.jsonObject(with: raw) as? [String: Any]
}

// MARK: Helpers

func matches(_ value: String, _ pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression) != nil
}

func sha256hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func iso(_ date: Date) -> String {
    ISO8601DateFormatter().string(from: date)
}

/// Free-tier months clear on the org's cycle; the artifact never outlives the current UTC month.
func endOfUtcMonth(_ now: Date) -> Date {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "UTC")!
    let start = cal.date(from: cal.dateComponents([.year, .month], from: now))!
    return cal.date(byAdding: DateComponents(month: 1, second: -1), to: start)!
}

func ask(_ question: String) -> Bool {
    note("\n\(question)")
    FileHandle.standardError.write(Data("  yes/no: ".utf8))
    return readLine(strippingNewline: true)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "yes"
}

/// The attestation freshness contract: evidence older than 2h (or in the future) cannot land.
let JIT_MS: TimeInterval = 2 * 3600

/// Test builds only: a fixed reference instant so boundary cases (±1s around now/2h) are
/// deterministic. The production binary has no such switch — real time is always Date().
func attestNow() -> Date {
    #if SCK_VAULT_TEST
    if let raw = ProcessInfo.processInfo.environment["SCK_ATTEST_TEST_NOW"], let ms = Double(raw) {
        return Date(timeIntervalSince1970: ms / 1000)
    }
    #endif
    return Date()
}

/// Parses the owner-declared capture time. Strict ISO-8601 with an explicit timezone is the
/// only accepted shape (`YYYY-MM-DD[T| ]HH:MM[:SS[.fff]][Z|±HH:MM]`) — an ambiguous local time
/// could silently mean a different instant, and mtimes/landing time are never consulted.
/// Fractional seconds are preserved (truncated to ms): dropping them would launder a
/// sub-second future instant into an apparently-current one.
func parseCapturedAt(_ raw: String) -> Date? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let pattern = "^(\\d{4}-\\d{2}-\\d{2})[T ](\\d{2}):(\\d{2})(?::(\\d{2})(\\.\\d{1,9})?)?(Z|[+-]\\d{2}:?\\d{2})$"
    guard let re = try? NSRegularExpression(pattern: pattern),
          let m = re.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)),
          m.numberOfRanges == 7 else { return nil }
    let group = { (i: Int) -> String? in
        let r = m.range(at: i)
        guard r.location != NSNotFound, let range = Range(r, in: trimmed) else { return nil }
        return String(trimmed[range])
    }
    guard let day = group(1), let hh = group(2), let mm = group(3), let zone = group(6) else { return nil }
    let ss = group(4) ?? "00"
    let fracDigits = group(5).map { String($0.dropFirst()) } ?? "0"
    let frac = "." + String((fracDigits + "000").prefix(3)) // normalize to millis exactly
    var tz = zone == "Z" ? "+00:00" : zone
    if tz.count == 5 { tz.insert(":", at: tz.index(tz.startIndex, offsetBy: 3)) } // +0800 → +08:00
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: "\(day)T\(hh):\(mm):\(ss)\(frac)\(tz)")
}

// MARK: Main

func run() -> Never {
    guard runningFromInstallPath() else { fail("sck-sync-attest 只能从安装路径运行") }
    var project = "", taskId = "", videoSha = "", audioSha = "", remaining = ""
    var evidence: [(path: String, capturedRaw: String)] = []
    var args = Array(CommandLine.arguments.dropFirst())
    while let arg = args.first {
        args.removeFirst()
        let take = { () -> String in
            guard let value = args.first else { fail("\(arg) 缺参数") }
            args.removeFirst()
            return value
        }
        switch arg {
        case "--project": project = take()
        case "--task": taskId = take()
        case "--video-sha256": videoSha = take().lowercased()
        case "--audio-sha256": audioSha = take().lowercased()
        case "--remaining": remaining = take()
        // --evidence binds each file to the actual moment its screenshot was taken, as
        // declared by the owner — the file's mtime and this landing time never substitute.
        case "--evidence": evidence.append((path: take(), capturedRaw: take()))
        case "-h", "--help":
            print("用法: sck-sync-attest --project <项目> --task <任务ID> --video-sha256 <hex> --audio-sha256 <hex> --remaining <本月sync-3剩余次数> --evidence <控制台截图> <采集时点ISO8601> [--evidence <截图> <时点> ...]")
            print("把 sync.so 控制台目证落盘为一个 free-trial 单次授权工件（private/sync/approvals/）；JIT≤2h、单次即作废、maxGenerations=1、maxJobSeconds=8。")
            print("每份证据须声明真实采集时点（如 2026-10-15T10:30:00+08:00 或 ...Z；须带时区），缺失/非法/未来/超过 2h 均拒绝落件；工件 capturedAt 取最早证据时点。")
            exit(0)
        default:
            fail("未知参数 \(arg)（--help 看用法）")
        }
    }
    guard matches(project, "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") else { fail("--project 不合法") }
    guard matches(taskId, "^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$") else { fail("--task 不合法") }
    for (name, value) in [("--video-sha256", videoSha), ("--audio-sha256", audioSha)] {
        guard matches(value, "^[0-9a-f]{64}$") else { fail("\(name) 需为 64 位小写十六进制") }
    }
    guard videoSha != audioSha else { fail("video 与 audio 的 SHA 不能相同") }
    guard let rest = Int(remaining), rest >= 1 else { fail("--remaining 需为 ≥1 的整数（老板从控制台读到的本月 sync-3 剩余次数）") }

    // Capture-time validation happens before any vault or filesystem side effect: every file
    // must carry a declared, parseable, non-future, non-stale instant. The future check is
    // strict — the declared instant is compared to the same-semantics Date the entry captured,
    // with zero tolerance; one stale or future file in an otherwise fresh set still fails.
    let now0 = attestNow()
    var evidencePairs: [(path: String, capturedAt: Date)] = []
    var seenPaths = Set<String>()
    for item in evidence {
        guard seenPaths.insert(item.path).inserted else { fail("证据路径重复：\(item.path)") }
        guard let captured = parseCapturedAt(item.capturedRaw) else {
            fail("证据采集时点缺失或非法（须为带时区的 ISO8601，如 2026-10-15T10:30:00+08:00）：\(item.path)")
        }
        guard captured <= now0 else { fail("证据采集时点在未来（请核对截图上的时点）：\(item.path)") }
        guard now0.timeIntervalSince(captured) <= JIT_MS else { fail("证据采集时点超过 2h JIT 窗口，须重新截图：\(item.path)") }
        evidencePairs.append((path: item.path, capturedAt: captured))
    }
    guard evidencePairs.count >= 2 else { fail("--evidence 至少两份：billing 页（plan+payment method）与 projects 页（含组织标识），各声明截图上的真实采集时点") }

    // The sealed key's identity comes from sck-vault (keyFp is a fingerprint, never the key).
    guard let status = vaultRequest(["op": "status"]), status["ok"] as? Bool == true else {
        fail("sck-vault 未运行，无法取得密钥指纹")
    }
    let providers = status["providers"] as? [String: Any]
    let sync = providers?["sync"] as? [String: Any]
    guard sync?["configured"] as? Bool == true, let keyFp = sync?["keyFp"] as? String else {
        fail("sck-vault 中没有 sync 密钥")
    }
    // Org-uniqueness evidence comes from the controlled sync_project_prepare readback, not from
    // a live probe here: a ready prepare-<keyFp>.json record means a full GET /v2/projects
    // readback already saw ≥1 project with exactly one organizationId bound to THIS key. An
    // empty org, a multi-org key or a refused create can never have a ready record, so those
    // negatives still refuse — now with the prepare ledger as the single source of truth.
    guard matches(keyFp, "^[A-Za-z0-9._-]{8,64}$") else { fail("密钥指纹异常") }
    let preparePath = Paths.home + "/private/sync/prepare/prepare-\(keyFp).json"
    guard FileManager.default.fileExists(atPath: preparePath),
          let prepareData = FileManager.default.contents(atPath: preparePath),
          let prepare = try? JSONSerialization.jsonObject(with: prepareData) as? [String: Any],
          prepare["schema"] as? String == "sync-prepare/1" else {
        fail("未找到本 key 的 prepare 就绪台账：先运行 sync_project_prepare（\(preparePath)）")
    }
    guard prepare["state"] as? String == "ready" else {
        fail("sync_project_prepare 未就绪（state=\(prepare["state"] as? String ?? "?")）：空项目集/多组织/创建被拒均无法落 free-trial 工件")
    }
    guard prepare["accountRef"] as? String == keyFp else { fail("prepare 台账与当前密钥指纹不符（绑定不符，fail-closed）") }
    guard let accountOrg = prepare["organizationId"] as? String, !accountOrg.isEmpty,
          let preparedProject = prepare["projectId"] as? String, !preparedProject.isEmpty else {
        fail("prepare 台账缺少 organizationId/projectId（回读记录不完整，fail-closed）")
    }
    let readbackAt = prepare["readbackAt"] as? String ?? "?"

    // Evidence: hash only; the bytes themselves never leave this process. Each file's SHA256
    // is bound to the owner-declared capture time checked above.
    var evidenceHashes: [String: String] = [:]
    var evidenceCapturedAt: [String: String] = [:]
    for pair in evidencePairs {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: pair.path, isDirectory: &isDir), !isDir.boolValue else {
            fail("证据文件不存在：\(pair.path)")
        }
        guard let data = FileManager.default.contents(atPath: pair.path), data.count > 0, data.count <= 64 << 20 else {
            fail("证据文件不可读或超出大小上限：\(pair.path)")
        }
        let name = URL(fileURLWithPath: pair.path).lastPathComponent
        guard evidenceHashes[name] == nil else { fail("证据文件名重复：\(name)") }
        evidenceHashes[name] = sha256hex(data)
        evidenceCapturedAt[name] = iso(pair.capturedAt)
    }
    // The artifact's capturedAt is the EARLIEST declared evidence instant: the qualification
    // window belongs to the oldest screenshot, so a fresh companion can never launder a stale
    // one, and re-landing the same screenshots reproduces the same deadline.
    let earliestCapture = evidencePairs.map { $0.capturedAt }.min()!
    let timesUniform = Set(evidencePairs.map { $0.capturedAt.timeIntervalSince1970 }).count == 1

    guard Auth.confirm("落盘 sync-3 free-trial 单次授权工件（新增支出上限 0）") else { fail("未获得设备持有者确认") }

    note("""
    将落盘 free-trial 单次授权工件：
      project: \(project)   taskId: \(taskId)
      accountRef(keyFp): \(keyFp)
      accountOrg(sync_project_prepare 回读): \(accountOrg)
      preparedProject(回读绑定项目): \(preparedProject)   readbackAt: \(readbackAt)
      输入绑定: video=\(videoSha.prefix(16))… audio=\(audioSha.prefix(16))…
      证据（文件名 → 声明采集时点 | sha256 前16）:
    """)
    for pair in evidencePairs {
        let name = URL(fileURLWithPath: pair.path).lastPathComponent
        note("      \(name) -> \(iso(pair.capturedAt)) | \(evidenceHashes[name]!.prefix(16))…")
    }
    note("""
      工件 capturedAt(最早证据时点): \(iso(earliestCapture))
      上限: maxGenerations=1, maxJobSeconds=8, USD estimate 仅记录不作依据
    """)

    guard ask("① 确认 sync.so 控制台 billing 页显示：当前计划为 free，且未绑定任何支付方式（payment method = none）") else {
        fail("已中止：billing 目证未确认")
    }
    guard ask("② 确认控制台组织标识与上方 accountOrg 一致（prepare 回读绑定项目 \(preparedProject)），且本月 sync-3 剩余次数 ≥ \(rest)") else {
        fail("已中止：组织归属或剩余次数未确认")
    }
    let sharedWhen = iso(earliestCapture)
    let timeQuestion = timesUniform
        ? "③ 确认上方所列全部证据均于同一实际采集时点 \(sharedWhen) 截取（以截图画面上的时点为准，非文件修改时间）"
        : "③ 逐份确认上方所列采集时点均为各证据的实际截图时点（以截图画面上的时点为准，非文件修改时间）；任一不符请中止重跑"
    guard ask(timeQuestion) else {
        fail("已中止：证据采集时点未确认")
    }

    let now = attestNow()
    let approvalId = "ft-" + SHA256.hash(data: Data((UUID().uuidString + iso(now)).utf8)).prefix(4).map { String(format: "%02x", $0) }.joined()
    let artifact: [String: Any] = [
        "schema": "sync-spend-approval/1",
        "approvalId": approvalId,
        "issuer": "owner",
        "project": project,
        "taskId": taskId,
        "accountRef": keyFp,
        "kind": "free-trial",
        "models": ["sync-3"],
        "maxGenerations": 1,
        "maxUsdPerJob": 0,
        "maxUsdTotal": 0,
        "maxJobSeconds": 8,
        "inputSha256Allowlist": [videoSha, audioSha],
        "plan": "free",
        "paymentMethod": "none",
        "sync3Remaining": rest,
        // capturedAt = earliest real evidence instant (JIT measured from it), NOT the landing
        // time; issuedAt independently records when this artifact was written.
        "capturedAt": iso(earliestCapture),
        "evidenceHashes": evidenceHashes,
        "evidenceCapturedAt": evidenceCapturedAt,
        "accountOrg": accountOrg,
        // Provenance of the org binding: which prepared project and which readback instant the
        // accountOrg came from (sync_project_prepare ledger). Informational, never a gate.
        "preparedProject": preparedProject,
        "preparedReadbackAt": readbackAt,
        "issuedAt": iso(now),
        "expiresAt": iso(endOfUtcMonth(now)),
    ]
    let approvals = Paths.approvals
    try? FileManager.default.createDirectory(atPath: approvals, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let target = approvals + "/" + approvalId + ".json"
    guard let payload = try? JSONSerialization.data(withJSONObject: artifact, options: [.sortedKeys]) else {
        fail("工件序列化失败")
    }
    let tmp = target + "." + UUID().uuidString + ".tmp"
    guard FileManager.default.createFile(atPath: tmp, contents: payload, attributes: [.posixPermissions: 0o600]) else {
        fail("工件临时文件写入失败")
    }
    do {
        try FileManager.default.moveItem(atPath: tmp, toPath: target)
    } catch {
        try? FileManager.default.removeItem(atPath: tmp)
        fail("工件落盘失败：\(error.localizedDescription)")
    }

    let entry: [String: Any] = [
        "ts": iso(now), "event": "attest", "approvalId": approvalId, "project": project, "taskId": taskId,
        "accountRef": keyFp, "accountOrg": accountOrg, "preparedProject": preparedProject, "sync3Remaining": rest,
        "evidence": evidenceHashes.keys.sorted(), "capturedAt": iso(earliestCapture), "expiresAt": iso(endOfUtcMonth(now)),
        "by": "deviceOwnerAuthentication",
    ]
    if let line = try? JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys]) {
        try? FileManager.default.createDirectory(atPath: (Paths.log as NSString).deletingLastPathComponent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let fd = open(Paths.log, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        if fd >= 0 { defer { close(fd) }; writeAll(fd, line + Data([0x0a])) }
    }

    note("\n已落盘 \(target)")
    note("最早证据时点 \(iso(earliestCapture)) 起 2h 内有效；提交成功立即消费作废；非绑定输入仍拒。")
    print(target)
    exit(0)
}

run()
