# 第二原生节点上线清单（离线可勾选）

**范围**：在**尚未证明**某台 VPS 已是公司 `native:<id>` 节点之前，用于上线前核对与负例回归。  
**本清单不授权**：生产安装第二节点、改 `runtime-routes` 切流、迁移在途会话、启用第二写者。  
**对照**：`docs/native-agent-runtime.md`；M4-A 事实表 B 节；自动化负例见 `tests/native-writer-lock.test.ts`（同目录写锁）与 `tests/dual-node-lease.fork.test.ts`（跨目录共库）。

公司 fork 基线：`mainlistactivity/surrealdb` / `1171dd014a768cb8be45689319016a3ff8800936`（本机 `~/.surrealdb/surreal`）。

---

## 1. Linux `isolation: external`

- [ ] 目标机为 Linux；`native-runner.json`（或等价配置）显式 `"isolation": "external"`。
- [ ] `commands.*.[0]` 为**已隔离**启动器的绝对路径（容器/沙箱入口），其后参数亦为绝对路径 CLI。
- [ ] **不**安装或复用 macOS `sandbox/launch.sh` / `employee.sb`。
- [ ] 隔离边界单独验收：员工进程读不到服务 `private/`、凭证区、vault/paseo socket；写不到 `plugin-releases`/`current`/`updater`/`bin`。
- [ ] 隔离配方（镜像/entrypoint/用户命名空间）写入运维笔记；仓库不假装已锁定生产配方。

## 2. 节点本地 clone / 仓库显式路径

- [ ] 选定策略并写死其一（不可混用默契）：
  - **A. 节点本地 clone**：每节点独立检出 ops/业务仓；任务 `worktree.repo` / `worktreePath` 使用**该节点**绝对路径；或
  - **B. 显式路径映射表**：维护 Mac 路径 → 远程路径对照，派工/认领前完成替换。
- [ ] 确认当前版本**无**自动 Mac→远程路径映射（见 `docs/native-agent-runtime.md`）。
- [ ] 禁止两节点共享同一 worktree 目录或同一 `writer.lock` 目录。
- [ ] `SCK_RUNNER_ID` 全局唯一、稳定；数据库归属 `native:<ID>`；通道根 `<service home>/native/<ID>/`。

## 3. 日志与证据脱敏

- [ ] 节点升级/故障错误经 `redactText`（或等价）再入库；JWT、Bearer、`sk-`/`gh*` 类令牌不得进证据。
- [ ] 证据与工单不写客户反馈正文、workspace 库名、原始 `workspaceKey`、凭证文件内容。
- [ ] 长绝对路径（≥40 字符）按公司投影约定写成 `[blob]` 或截断别名；原始路径只留在节点本地私有日志。
- [ ] 证据目录只放合成任务与脱敏摘要；模型权重/venv/chrome-headless 等运行产物不进证据。

## 4. 第二节点心跳

- [ ] 服务安装后 `node_release` 出现该节点行：`host`/`platform`/`version`/`sha`/`seen_at` 由心跳刷新。
- [ ] `runner_heartbeat`（或等价看板心跳）可见 `native:<ID>`，与 Mac 节点并存、互不覆盖。
- [ ] 心跳失败只 warn，不自动把路由改回其他节点。
- [ ] 在 `node_release` 有稳定心跳之前，事实表 B-U1 保持 **unknown**，不宣称 VPS 已是公司节点。

## 5. 租约与写锁（上线前必绿）

| ID | 场景 | 期望 | 自动化 |
| --- | --- | --- | --- |
| N1 | 同一 `native/<id>` 目录第二进程抢 `writer.lock` | 启动失败；原写者继续 | `tests/native-writer-lock.test.ts` |
| N2 | 节点 A 持有效租约时，节点 B 认领同一任务 / 用旧 proof 写入 | `already_claimed` / `stale lease`；不得复用 A 的 session id | `tests/dual-node-lease.fork.test.ts` |
| N3 | `runtime-routes` 指定 `native:A` 且 A「离线」 | B 与 Paseo **不**自动接单（无在线路由回退） | `tests/provider-routing.test.ts` + dual-node fork |
| N4 | 租约过期后旧 fence/delivery 再 heartbeat/checkpoint | `lease_expired` 或 stale；不可写 | dual-node fork |
| N5 | 过期/释放后节点 B 认领 | 成功；`lease_node=B`；fence 前进 | dual-node fork |
| N6 | 两节点各用独立目录，同目录锁与跨节点租约互不替代 | 锁证据与租约证据分开归档 | 本清单 §6 |

## 6. 证据归档（不得互相替代）

分别保留两份证据（路径写入任务 evidenceDir）：

1. **同目录写锁**：命令、公司 fork 版本、N1 通过日志。  
2. **跨目录共库**：两个 runner ID、两个临时目录、同一 fork 测试库 URL、N2–N5 通过日志与 `lease_node` 抽样。

## 7. 真实 VPS 仍缺的节点证据（勾选前保持 unknown）

- [ ] VPS 上存在 `SCK_RUNNER_ID=…` 的常驻 `run.ts` / systemd 用户服务，且 `writer.lock` host 匹配。
- [ ] 云端 `node_release` 对该 ID 有近期 `seen_at`（非仅 origin agent / 预览隧道）。
- [ ] `isolation:external` 实机冒烟（合成任务一轮）与路径策略实装证明。
- [ ] 生产 `runtime-routes.json` 变更的变更单与回滚步骤（本清单不执行切流）。

## 8. 自验

- [ ] 清单字段可勾选；B-U1 在真实心跳前保持 unknown。  
- [ ] N1 与 N2–N5 证据分离。  
- [ ] 未登录/安装生产 VPS，未改生产路由，未启生产第二节点。  
- [ ] PR 版本高于 main，且与在途 M2/M3 文件冲突已协调。
