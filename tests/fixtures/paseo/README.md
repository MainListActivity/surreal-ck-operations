# Paseo CLI 真实契约样本（SYS-DISP B4）

本目录的 JSON 是本机 Paseo CLI 只读输出的脱敏结构样本，供 `tests/paseo-contract.test.ts` 校准 fake CLI 的形状。
它们不是原始输出：字符串值已替换为占位符，标识符已替换为合成值。

## 采样记录

- CLI：`/Applications/Paseo.app/Contents/Resources/bin/paseo`（shell 包装，末尾 `exec` 到 Electron helper）
- CLI 版本：`0.12.0`（`paseo --version`，退出码 0）
- 采样时间（UTC，本机时钟）：2026-10-20T06:49:05Z 至 2026-10-20T06:51:56Z
- 采样方式：只读命令；超时用 `perl -e 'alarm 30; exec @ARGV'` 包裹。未执行任何写或控制类子命令。

| 命令 | 采样时间（UTC） | 退出码 | 说明 |
| --- | --- | --- | --- |
| `paseo --version` | 06:49:05 | 0 | 版本 0.12.0 |
| `paseo --help`、`ls --help`、`inspect --help`、`agent --help`、`agent inspect --help`、`workspace --help`、`workspace ls --help` | 同一会话，未逐条记录 | 0 | 仅读取用法 |
| `paseo ls -g --json` | 06:51:12 | 0 | 119 行，状态分布 idle 43 / running 3 / closed 73 |
| `paseo workspace ls --json` | 06:51:13 | 0 | 179 行，isolation 分布 local 99 / worktree 80 |
| `paseo ls -a -g --json` | 06:51:13 | 1 | 真实非零退出：stderr 为 `LIST_AGENTS_FAILED` 的 JSON |
| `paseo inspect <idle 会话 id> --json` | 06:51:32 | 0 | Status=idle |
| `paseo inspect <running 会话 id> --json` | 06:51:33 | 0 | Status=running |
| `paseo agent inspect <idle 会话 id> --json` | 06:51:33 | 0 | 与 `inspect` 同形 |
| `paseo inspect 00000000-0000-4000-8000-000000000000 --json` | 06:51:33 | 1 | 真实 not-found：stderr 为 `AGENT_NOT_FOUND` 的 JSON |
| `paseo inspect <closed 会话 id> --json` | 06:51:56 | 0 | Status=closed，Archived=false |

`--json` 输出的 `ls` 与 `inspect` 退出码 0 时 stderr 为空。错误时 stdout 为空，stderr 为 `{"error":{"code":...,"message":...}}`。

## 脱敏规则

1. 所有字符串字段替换为占位符，例如 `<name>`、`<provider>`、`<Model>`、`<iso-8601-utc>`。
2. 仅保留枚举与结构：`status`/`Status` 取值集合 `{idle, running, closed}`；`isolation` 取值集合 `{local, worktree}`。
3. 布尔、null、对象与数组结构原样保留。`AvailableModes` 只留 1 项，`Capabilities` 四个布尔原样保留。
4. 会话 id、workspaceId 替换为合成 UUID `00000000-0000-4000-8000-0000000000NN`；`shortId` 替换为 id 前 7 位（真实数据已核对：119 行中 119 行的 `shortId` 都是 id 的前 7 位）。
5. `cwd` 替换为 `/fixture/cwd`。时间戳替换为 `<iso-8601-utc>`。
6. 错误 `message` 替换为占位符，`code` 保留（`AGENT_NOT_FOUND`、`LIST_AGENTS_FAILED` 是 CLI 的错误码，不是敏感信息）。
7. 不入库：会话正文、提示词、日志、token、凭证、邮箱、账号、用户名路径、项目名、模型名、工作区名。
8. 原始输出只存在于 `/tmp` 下的临时目录，已在采样后删除，未写入仓库、日志或证据目录。

## 文件清单

- `ls-global.sample.json`：`paseo ls -g --json` 的结构样本，3 行（idle、running、closed 各 1）。
- `inspect-idle.sample.json`、`inspect-running.sample.json`、`inspect-closed.sample.json`：`paseo inspect <id> --json` 的结构样本。
- `workspace-ls.sample.json`：`paseo workspace ls --json` 的结构样本，2 行（local、worktree 各 1）。
- `stderr-agent-not-found.sample.json`：真实 not-found 的 stderr 结构。
- `stderr-list-agents-failed.sample.json`：真实 `ls -a -g` 非零退出的 stderr 结构。

## 与代码假设的对照

| 项目 | 真实观察 | 代码假设（修正前） | 结论 |
| --- | --- | --- | --- |
| `ls -g --json` 行 | 对象数组，键：`id` `shortId` `name` `provider` `thinking` `status` `cwd` `created`，`status` 小写 | `list()` 读取 `id`、`status` | 一致 |
| `inspect --json` 键 | 18 个键，大写开头：`Id` `Name` `Provider` `Model` `Thinking` `Status` `Archived`(bool) `ArchivedAt` `Mode` `Cwd` `CreatedAt` `UpdatedAt` `LastUsage` `Capabilities` `AvailableModes` `PendingPermissions`(数组) `Worktree` `ParentAgentId` | `status()` 读取 `Status`、`Archived`、`PendingPermissions` | 一致 |
| `Status` 取值 | 采样中出现 idle、running、closed | 旧测试只覆盖 idle、running | `closed` 为真实取值；见下文"存疑" |
| `Archived` | 布尔 | 布尔 | 一致 |
| `PendingPermissions` | 数组，采样中均为空 | 数组长度 | 一致；非空形状未采样 |
| `LastUsage` | 采样中均为 null | `LastUsage.InputTokens`（`agent inspect`） | 未验证，见存疑 |
| `Capabilities` | 对象，四个布尔 | 旧测试为 `{}` | 旧 fixture 与真实不符，已改为真实键 |
| `AvailableModes` | 数组，元素为 `{id, label}` | 旧测试为 `[]` | 旧 fixture 与真实不符，已改为真实结构 |
| `shortId` | id 前 7 位 | 旧测试为 `id.slice(-5)` | 旧 fixture 与真实不符，已改为前 7 位（dispatcher 不读取该字段） |
| `workspace ls --json` 键 | `workspaceId` `name` `cwd` `project` `isolation` `background` | `ensureWorkspace` 读取 `workspaceId` `name` `cwd` | 一致 |
| 非零退出的错误形状 | stderr 为 JSON `{"error":{"code",...}}` | 旧测试 fake 为纯文本 `agent not found`、退出码 1 | 旧 fake 与真实不符，已改为真实 JSON 形状，not-found 以 `code: AGENT_NOT_FOUND` 判定 |

## 存疑与未覆盖

- `LastUsage` 在所有采样中为 null，`LastUsage.InputTokens` 的键名未经真实数据验证。
- `workspace create` 的返回形状未采样（写命令，禁止执行）；代码 `created.workspaceId ?? created.id` 未验证。
- `closed` 在真实列表中占多数（73/119）。`dispatcher.ts` 对未知或非 idle/running 的状态仍按 `session <status>` 处理为 `down` 并退役，这是既有行为，本次未改。
- `PendingPermissions` 非空时的元素形状未采样。
