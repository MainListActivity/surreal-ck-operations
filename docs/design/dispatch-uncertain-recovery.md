# 派工不确定状态候选修复（未上线）

基线：本地 origin/main / v0.11.3，33e16fd。远程 fetch 被网络策略拒绝，不能声称最新。

## 模型

业务结果与派工收尾是两个维度。attempt.state 只有 pending / confirmed；合法业务结果仅设置 result_confirmed 和审计引用，**不解除 task、employee、message 的隔离，也不退出待恢复扫描**。这些屏障保持到派工 finalization 原子完成。

## 开始与调用

beginDispatchAttempt 在事务内检查未过期的 employee/delivery/fence、员工可用性、消息未发送/未扣留/版本未变化（版本由数据库对正文、译文、语言、状态、扣留及原始日期字段计算稳定hash，不通过String(Date)或datetime强转往返），并原子占用 task、employee、outbound_message 三个指针。attempt 保存 request、message ID/版本、实际发送正文 SHA-256、租约身份及绑定参数。正文快照保存在原 outbound_message.dispatch_body，不进入 attempt；消息事件禁止在收尾前修改或删除快照。外呼只发生在事务成功返回之后。

AgentRuntime.send 仅返回 void，spawn 仅返回 agentId，没有通用 request 幂等参数或按 request 查询确切 turn 的接口。spawn 标签携带 request ID，send 的 request ID 仅用于本地审计。**不承诺 exactly-once**。响应丢失且无可信业务结果时，不从超时、列表缺失或过期推断未执行，不补发。

## 原子收尾与旧回调

finishDispatchAttempt 是唯一派工收尾入口。事务检查 pending 状态、运行端回执或可信业务结果、三个隔离指针、同 fence、需要激活时已有activated回执或可信结果、员工未撤销/退休、agent 未变化、消息快照 hash，以及原租约或结果审计。非业务终态在同事务将租约期限扩展到max(原期限,now+600)，随后才解除屏障，防止重启超期后立即被重复领取。一次性写入：

- 员工 agent/工作目录/模型绑定（不设置 retired=false）；
- 唤醒计数与时间；
- 消息 sent_body/sent_to/sent_at 以及放行通知收尾；
- attempt confirmed 与三个隔离指针清除。

dispatcher 不再在该路径调用无代际保护的 bind/touchWake/markSent。重复或迟到回调在事务入口拒绝，不写任何状态，不能覆盖新代际或复活退休员工。需要 activate 的运行端使用独立持久化边界：收到spawn回执后，在屏障内以CAS登记绑定并写 activation_state=calling，再绑定sidecar并调用activate；调用成功后确认activated，最后才能finalization。激活回执丢失或重启时不盲目重调activate，保持隔离。真实业务结果可证明已执行，但同样只允许原子收尾。

## 合法业务结果

核心 submit/accept/return/block 先验证原租约与角色，再在**同一事务、任务状态更新之前**创建真实 audit，写 result_confirmed/action/原版本/audit 引用。数据库任务事件核验该 audit 的 task、actor、action、version 与允许的状态转换，不能仅凭非空 audit ID 放行。任务和员工屏障保留，直到 finalization。heartbeat/checkpoint 不构成业务结果。

该顺序保证任务更新失败时审计及结果标记一起回滚。原数据库访问规则不给普通员工直接写 audit/attempt；系统 root 本身可修改数据库，不将防御数据库管理员伪造当成保证。

## 重启与局部隔离

pending 扫描包含 result_confirmed=true 的记录。已保存外呼响应、必要的activation已确认且agent已知，或结果已确认且原agent已知，恢复仅执行 finalization，不发送。没有agent的spawn结果继续保持隔离并报告缺回执，不猜测会话。NativeRuntime的pending首轮提示尚不能跨重启可靠恢复，activation不确定也保守保留，不声称自动续跑。

尚无确定响应/结果时，同指针及同租约的恢复只保活和恢复已知绑定，期限取 max(原期限, now+300)。启动及周期恢复逐条记录错误，单条错误不阻塞无关工作。恢复前保存受影响员工集合，即使本轮 finalization 清了 pending，也仍执行 sidecar.adopt 接管。正常结果收尾后新代际才可领取。

调度器局部隔离相关任务和员工，其他任务继续监督和派工。数据库事件保护 holder/delivery/fence/state/project/worktree/删除及隔离指针，claim/release/revoke/retirement 亦有事务检查；owner 作废与 core 重绑不能绕过，级联由事件统一保护。存在未决项时暂缓 artifact/worktree/comm GC，仅停回收，不停调度。

## 未关闭的上线阻断

- 本机公司fork已通过新增事务、事件同事务可见/回滚、crypto::sha256稳定版本、双连接竞争与恢复验证。测试使用临时库root身份；生产runner权限、跨主机故障与生产迁移尚未验收，不能据此直接部署。
- 没有安全人工对账解锁命令；不能直接改/删 pending 行重试。
- 无 agent 回执的 spawn，即使业务结果已确认仍无法安全绑定，继续隔离。运行端缺少请求回查，不能自动消除此状态。
- schema 65 发布版本/映射仍未完成，不能打包部署。混用旧版本也不受支持。
- 现有 notice/nudge/recovery 外呼、recordDispatch 不在本次保证范围；GC 全局暂缓可能增加磁盘压力。
- pending 列表读取失败时停止该调度周期，避免在基础状态不可读时重派。

## 验证材料

- dispatcher-sidecar回归覆盖外呼响应丢失、记账失败、重启/过期、不相关任务继续派工；新增真实NativeRuntime经实际Dispatcher的spawn→绑定→activate→子进程收取提示全链（数据库仍为mock），并覆盖激活响应丢失后不重调。
- dispatch-attempt.fork.test.ts 每次随机 namespace，真实 core.createTask/claim/submit，覆盖：并发占位；续租不缩短；已响应但未收尾的新连接 finalization；旧回调不复活退休员工；伪造不相干 audit 被拒；快提交保留屏障；无 agent 结果仍在恢复扫描；收尾后复核新代际不能被旧回调覆盖；真实prepareSend→begin的纳秒日期及内容变化版本检查；需要activation的回执/新连接边界；过期回执恢复时先续租再解锁。
- 已核验Mac现有公司fork二进制，未下载、未绕过下载限制。在指定现成二进制上运行127.0.0.1隔离临时RocksDB矩阵，结束后测试入口清理进程和数据。首次失败定位为测试夹具错误（Bun .rejects未触发Surreal懒QueryPromise、第二连接未useDatabase），修正后真实矩阵及相邻回归通过。

## 已运行的验证（2026-11-10）

### 历史基线，不能当作最新全量通过

此前8个聚焦文件126通过、4跳过；test:bridge聚合1270通过、86跳过、5失败。两个失败为schema65与发布映射不一致；三个为Paseo夹具缺journal读取方法，修正后单独19通过。未重新跑完整聚合，因此不标全绿。

最初真实fork矩阵命令：
`SCK_TEST_TIMEOUT_SECONDS=180 bun scripts/test-worktrees.ts tests/dispatch-attempt.fork.test.ts tests/dispatcher-sidecar.fork.test.ts tests/dispatch-episode.fork.test.ts tests/runner-lifecycle.fork.test.ts`

原始日志 `/tmp/dispatch-recovery-fork-matrix.log`：16通过、0失败、221断言。其中dispatch-attempt为6项新增，dispatcher-sidecar 5项、runner-lifecycle 3项、dispatch-episode 2项为既有回归。第二连接/新Workforce并不是数据库或执行端进程重启；Promise.allSettled并未强制事务交错。真实NativeRuntime+Dispatcher测试使用实际本地子进程，但数据库为mock，不能声称数据库与运行端一体端到端验证。

### 本轮新增的实测范围

`tests/dispatch-attempt.fork.test.ts` 现13项：原6项外新增真实core accept/return/block各一项（事件失败时结果标志/审计回滚，再成功重试）、收尾先于submit的确定性顺序、数据库SIGKILL持久化重启、真实core父子级联作废失败整体回滚、只读核验无正文且指纹随读集改变。

数据库进程测试启动独立临时RocksDB，仅杀测试自己创建的进程，重启同目录；验证activation calling仍保留屏障，人工注入模拟可信回执完成收尾后再重启，唤醒计数仍为1且sent_body一致。这不是实际运行端回执证明，也不是生产断电持久性证明。

`tests/native-runtime.test.ts` 新增真实执行端子进程SIGKILL后第二进程重启：确实被遗留writer.lock以EEXIST拒绝，持久状态不变且未激活/重发。没有自动删除锁。该测试证明保守拒绝，并不证明崩溃后可自动恢复执行服务。17项通过、0失败、57断言，日志 `/tmp/dispatch-recovery-native-crash.log`。

两种确定性业务顺序由明确await构造：业务结果先完成，再收尾；收尾先完成，再业务结果。仍未强制SQL事务内部暂停/交错，双连接竞争测试只提供真实并发覆盖。

独立新增文件运行命令：`SCK_TEST_TIMEOUT_SECONDS=180 bun scripts/test-worktrees.ts tests/dispatch-attempt.fork.test.ts`。日志 `/tmp/dispatch-recovery-expanded.log`：13通过、0失败、93断言。

所有fork矩阵使用测试root；055因缺COMPANY_JWKS_URL/COMPANY_ISSUER跳过，未验证生产runner JWT权限。受控核验只有只读实现，取消/批准绑定CAS写入尚未实现，不代表已上线。

## 二进制来源的可确认范围

现成二进制 `/Users/y/.surrealdb/surreal`：version为`3.3.0-nightly for macos on aarch64`，SHA-256为`62f62eca3b42a72f547ebc3e42cc3d768d5f88bf7077ccc583efbad0ae7c941b`。仓库AGENTS明确指定它为公司fork本地构建，源码目录HEAD核验为`1171dd014a768cb8be45689319016a3ff8800936`。

无法由二进制独立确认其对应源码提交。源码目录target/release/surreal的hash为`cf2c1429d8571b583d51aaba6d578bdb337ec66d3031615c44c043eabf01ce8e`，与安装文件不同。构建/strip差异只是可能性，尚无可验证构建证明。没有下载或替换二进制。

受控核验与取消方案见dispatch-recovery-runbook.md。仍禁止发布和部署，线上真实验证尚未完成。

## 本轮最终复跑

- 同上4文件矩阵命令（13新增文件用例+10相邻回归）：23通过、0失败、263断言，日志 `/tmp/dispatch-recovery-fork-matrix-v6.log`。
- `bun test tests/dispatcher-sidecar.test.ts tests/native-runtime.test.ts tests/outbound-delivery.test.ts tests/role-message-flow.test.ts tests/paseo-contract.test.ts tests/cloud-schema-version.test.ts tests/dispatch-blocked.test.ts tests/dispatch-list.test.ts`：146通过、0失败、815断言，日志 `/tmp/dispatch-recovery-focused-v6.log`。
- `./node_modules/.bin/tsc --noEmit`、`git diff --check`通过；类型检查日志 `/tmp/dispatch-recovery-types-v6.log`。这些辅助检查不代替运行测试或线上真实验证。

## 第七轮：执行端内核锁与真实进程断点

历史第六轮的EEXIST阻断已在隔离工作树修复，尚未部署。`src/runner/native-lock.ts`使用系统flock（Bun FFI），永久`writer.lock.kernel` inode持有排他非阻塞锁，直到收尾结束关闭fd。文件不删除/重命名；SIGKILL自动释放内核所有权。PID仅为诊断信息，不用于v2锁抢占，因此PID复用不能制造双写者。元数据放在独立writer.lock并原子替换。首次O_EXCL保留旧锁文件名，避免旧版本启动窗口。

旧格式锁仍需确认PID不存在才迁移；PID存活、权限无法查询、错误host、空/损坏元数据均保守拒绝。旧PID恰被复用会保守阻断，不能自动当成死锁。首次创建或存储掉电造成损坏的锁需要人工核验，不声称任意写盘断点都自动恢复。新旧版本并行运行/回退尚不支持，不删除锁来绕过。

真实进程用例：6个同时启动仅一个成功；SIGKILL持锁者后6个候选仍仅一个成功；活锁拒绝；实测退出的旧PID可迁移；模拟PID复用不影响v2内核所有权。`bun test tests/native-runtime.test.ts`：19通过、67断言，日志`/tmp/native-lock-process-tests.log`。

新增真实公司fork+NativeRuntime进程组合，不使用mock数据库：分别在activation之前、CLI仍活、真实core.submit之后SIGKILL执行端。重启接管不自动activate/send；仍活的旧CLI为unknown并保留屏障；真实结果已完成则仅收尾，sent_body匹配、wake_count一次、真实submit审计一次。测试模型CLI是本地合成程序，不调用真实模型供应商；数据库root仍不是生产JWT。运行端结果重放调用真实幂等core，无再次启动CLI。

Mac系统libSystem的flock已实测；Linux libc.so.6及实际部署镜像尚未运行验证。FFI依赖、文件系统锁语义、生产runner权限和线上canary仍为发布前阻断，不能据此部署。

第七轮最终实跑：
- `SCK_TEST_TIMEOUT_SECONDS=180 bun scripts/test-worktrees.ts tests/dispatch-attempt.fork.test.ts tests/dispatcher-sidecar.fork.test.ts tests/dispatch-episode.fork.test.ts tests/runner-lifecycle.fork.test.ts`：26通过、281断言，日志`/tmp/dispatch-native-lock-matrix-final.log`。
- `bun test tests/native-runtime.test.ts tests/dispatcher-sidecar.test.ts tests/runner-lifecycle.test.ts tests/paseo-contract.test.ts`：121通过、495断言，日志`/tmp/native-lock-regression-final.log`。
- TypeScript与diff格式检查通过，日志`/tmp/native-lock-ts-final.log`。没有线上验证、没有提交/部署。

## 交付增量：受控结果收尾与发布配套

新增dispatch-recovery-finalize.ts：只接受预存审批，仅收尾已提交真实结果的精确agent；完整核验hash CAS、审批过期/身份检查、原子回执、消费审批、响应丢失后同操作重放。共享dispatch-finalization.ts避免人工与自动收尾逻辑分叉。不创建审批，不取消，不发送，不停会话。生产确认入口尚未接线。

新增真实JWT测试采用同一055访问定义与HS512测试签名源：runner可以执行真实core结果与审批CAS收尾，不能自造/改审批、伪造回执；viewer写请求会静默过滤，测试通过root读回确认未改。真实生产JWKS/身份与线上权限仍未验证。

发布候选本地版本0.11.4，schema65，新增账本/审批/回执三表最低要求；历史0.11.3仍为schema64。package、plugin、company-release与映射一致，发布测试16/16通过。候选不是正式发布，禁止与旧执行端混用，存在pending时不能直接回滚旧版本。

只读/写入模块与签名源替身测试不意味着生产授权已打通；运行端未知状态的通用取消能力仍缺失。

交付前最终运行：
- `SCK_TEST_TIMEOUT_SECONDS=180 bun scripts/test-worktrees.ts tests/dispatch-attempt.fork.test.ts tests/company-access.fork.test.ts tests/dispatcher-sidecar.fork.test.ts tests/dispatch-episode.fork.test.ts tests/runner-lifecycle.fork.test.ts`：40/40，363断言；日志`/tmp/dispatch-recovery-delivery-matrix.log`。
- `bun test tests/dispatcher-sidecar.test.ts tests/native-runtime.test.ts tests/outbound-delivery.test.ts tests/role-message-flow.test.ts tests/paseo-contract.test.ts tests/cloud-schema-version.test.ts tests/dispatch-blocked.test.ts tests/dispatch-list.test.ts tests/release-schema.test.ts tests/release-notes-contract.test.ts`：163/163，875断言；日志`/tmp/dispatch-recovery-delivery-focused.log`。
- 类型检查、diff格式检查通过。全test:bridge未在最终改动后重跑，不标全量通过。
