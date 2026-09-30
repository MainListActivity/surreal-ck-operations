# VER02 返工生产复验：已验证功能通过，运行时验证依赖上报经理

任务 e43f6300-acaa-401b-9084-c3108d3353ff；QA qa-codex-0f0ae6。
待验提交 025f834e17907c035abbc9b4edbffb6411c21609（PR #63）；实测时间 2026-09-30 02:31–02:35 UTC。

完整阅读本次领取的全部 history（含此前退回、工程根因定位、返工提交与部署记录）。本报告补充上一轮报告，保留上一轮历史结论。

## 独立生产实测结果

入口为 https://l.maplayer.top，生命周期接口为 /api/workspaces/sck-lca03-a/employees 和 /:employeeKey/pause、resume、retire；SDK 直连 wss://data.maplayer.top/rpc，namespace main，database ws_26d695c309e5。只使用登记的 A 管理员与 A 普通成员测试账号。

| 验收项 | 操作 → 实际结果 |
| --- | --- |
| 发布、健康 | gh run list/view 独立核对最新 Deploy production https://github.com/MainListActivity/surreal_ck/actions/runs/36659754499，SHA 与待验提交相同，origin/Cloudflare 双 job success。/health HTTP200，status=ok、surrealdb=up，开始 uptimeSec=313，结束513。health 不含 SHA，版本依据最新成功发布流水线。 |
| 上轮无岗位 500 | 原 requestKey=qa-ver02-e43f6300-default → 200 created=true，user:ve_738d1caaa672578ace71cf58，active；同键重试 → 200 created=false、同一身份。 |
| 上轮岗位键400、并发 | qa-ver02-e43f6300-concurrent + roleKey=project-manager 三次并发 → 三次200，一次created=true、两次false，同一 user:ve_f36dc45f2ee20a4a4c38a4fe。SDK确认一条员工和一条凭证。roleKey=data-analyst → 200，user:ve_931091ca3f55b85af3d1b79e，正确岗位回显。 |
| token scope | 真实 OIDC Authorization Code+PKCE 登录普通成员，再通过 /api/session/switch-workspace 获取 participant/ws_26d695c309e5。该 token 调创建、pause、resume、retire 全部403 employee-scope-mismatch。A管理员 token 调 B 测试 workspace 创建 → 同样403。 |
| RecordId、日期 | 数据库查询以 StringRecordId 绑定员工；创建岗位后实际 virtual_profile.role 为 SDK RecordId，last_active_at 为 SDK DateTime，关联 employee_credential.employee 也为 RecordId。成功端到端写入通过。 |
| 部分失败恢复 | 用管理员会话只创建本任务确定性身份 user:ve_f937c89b0cd2db0ee3827226，virtual_profile={}，不创建凭证，以此构造“user成功、凭证未写”中间状态。SELECT确认一条user、零凭证；pause/resume各409 provisioning非法迁移；同键provision → 200 created=false、active，一条凭证；再次provision仍同身份false。安全恢复通过。该测试构造持久化失败状态，没有在真实请求中注入root写失败。 |
| 生命周期 | active pause两次→200 paused；新 employee SIGNIN被拒；resume两次→200 active；新SIGNIN成功；retire→200 retired；retire重放200，同键provision仍retired；retired resume/pause均409。恢复夹具从paused retire也200。 |
| 凭证旋转与窗口 | 在测试进程内读取本轮夹具凭证用于真实 employee SIGNIN，不打印或写文件。retire前后只输出比较布尔值：credentialRotated=true；rotated_at=2026-09-30T02:31:42.500279799Z。首次退休回显credentialsExpireBy=03:31:42.508Z，重放=03:31:42.500Z，约1h窗口；旧secret再次SIGNIN被拒。短token完整1h自然过期未等待验证。 |
| 校验拒绝 | 非法员工id →400 employee-id-invalid；未知合法格式岗位 →400 employee-role-not-found。 |
| 响应保密 | 所有实测生命周期HTTP响应仅员工视图/created/credentialsExpireBy或明确错误，未含secret/token/root凭证。生产服务日志无授权观测入口，本轮未验证其内容。 |

## 尚不能形成整体 accept 的必验项

票据要求“创建或恢复active员工后，运行时无需重启即可注册其session；暂停或退休后不再接受新执行窗口并关闭现有连接”。

已实际调用创建、恢复、暂停、退休成功路径，已验证状态与新SIGNIN准入。读待验代码发现这些路径await runtime.register/close；此事实属于代码复核。生产内部runtime现有连接确已关闭、执行窗口准入实际拒绝，仍缺直接行为证据。不能以HTTP200、代码调用或新SIGNIN被拒冒充这些证据。

已查待验commit的employee-runtime.ts、employee-service.ts、employee-lifecycle.ts及routes：session()/activeSessions()属于进程内接口，测试可调用，生产路由未提供其观测；本交付没有可供QA触发并验证执行窗口的生产接口。本轮不使用SSH、不读取主机敏感日志、不重启生产、不添加调试endpoint来扩大QA权限。

向gm上报验证依赖：请安排可授权的、去敏的生产运行时行为观测/验证通路，或协调本交付与后续执行窗口交付的验收边界。优先复用已有内部指标/工程验证通路；不要求新增面向浏览器的业务CRUD代理，也不涉及老板决策。恢复时从本项继续：create/resume→会话可用，pause/retire→已注册连接关闭且新执行窗口拒绝，保留响应/指标摘要及时间关联证据。若有生产服务日志的安全观测通路，同时补日志不泄密验证。

## 边界与夹具

四个本轮QA员工均已通过生命周期API退休：ve_738d1caaa672578ace71cf58、ve_f36dc45f2ee20a4a4c38a4fe、ve_931091ca3f55b85af3d1b79e、ve_f937c89b0cd2db0ee3827226。未操作claims_risk_reminder或客户数据。没有自建需要登记的新明文secret，员工凭证由应用生命周期服务生成并保存在DB内。

产品仓库只读，无代码改动/提交/发布/SSH/root登录/服务或数据目录操作。公司新增本去敏报告；任务服务保存checkpoint与上报。Ego任务空间已关闭，本轮未执行其提示的升级；没有创建agent或定时器。
