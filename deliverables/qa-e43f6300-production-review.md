# VER02 生产独立验收：退回

任务 e43f6300-acaa-401b-9084-c3108d3353ff；QA qa-codex-0f0ae6。
待验版本 dbeed9b65a7b0ce5a814ac7bcf0f1cbd8dab445c（PR #61）。实测时间 2026-09-30 01:54–01:56 UTC。

## 阻断问题一：合法创建持续返回 HTTP 500

入口 https://l.maplayer.top → 登记账号 sck-lca03-a-admin@maplayer.top 登录 → 使用当前真实 OIDC token（db=ws_26d695c309e5，ac=admin）调用：

POST https://l.maplayer.top/api/workspaces/sck-lca03-a/employees

```json
{"requestKey":"qa-ver02-e43f6300-default","displayName":"QA VER02 lifecycle"}
```

实际：首次请求、相同请求重试均 HTTP 500，响应 {"error":{"code":"internal","message":"Internal server error"}}。
另以 requestKey=qa-ver02-e43f6300-concurrent 同时发送三次正常创建，三次均 500。

随后使用管理员 SDK 直连生产数据库，按实现的确定性身份计算并 SELECT：

- 默认请求 user:ve_738d1caaa672578ace71cf58：user 结果空，关联 employee_credential 的 id/employee 投影为空。
- 并发请求 user:ve_f36dc45f2ee20a4a4c38a4fe：user 结果空，关联凭证投影为空。

没有得到可继续 pause/resume/retire 的员工；本轮观察到没有半成品 active 员工，但正常供给及幂等成功语义没有成立。

期望：合法创建成功返回 active 员工，重试和并发请求返回同一身份且只有一条凭证；runtime 注册 session 成功。请修复生产适配路径并验证真实 JWT admin 会话，不以 mock 测试或 endpoint 已挂载作为完成依据。500 的服务端根因本轮未确认，未访问主机日志或 SSH。

## 阻断问题二：现有默认岗位被格式校验拒绝

相同入口与管理员会话，分别 POST：

```json
{"requestKey":"qa-ver02-e43f6300-pm","displayName":"QA VER02 project manager","roleKey":"project-manager"}
```

```json
{"requestKey":"qa-ver02-e43f6300-analyst","roleKey":"data-analyst"}
```

实际：两次均 HTTP 400，employee-role-key-invalid，message=roleKey 格式不合法。
独立生产 SELECT office_role 返回现有 key=data-analyst/project-manager。读代码发现 employees.ts 对 roleKey 使用 /^[a-z][a-z0-9_]{0,62}$/i，不能接受这两个带连字符的合法 key；这是与生产响应一致的代码定位。

期望：已有合法岗位 key 可用于创建并关联正确 RecordId；非法岗位仍返回明确错误，不新增重复岗位来绕过校验。

## 逐项验收结果与限制

| 条目 | 入口 → 操作 → 实际结果 |
| --- | --- |
| 发布与健康 | https://github.com/MainListActivity/surreal_ck/actions/runs/36656989096 → gh run view/list → 最新 Deploy production 为待验 SHA，origin 与 Cloudflare 均 success；https://l.maplayer.top/health → HTTP200，status=ok，surrealdb=up，uptimeSec=219。health 不含版本 SHA，版本依据最新成功发布流水线。 |
| 创建、重试、并发 | 上述生产 POST → 首次/重试/三次并发均 500；失败，需返工。 |
| token scope | A 管理员 token 调 B 测试 workspace 的创建 endpoint → HTTP403 employee-scope-mismatch；此分支通过。participant 拒绝本轮未验证。 |
| RecordId | 读取生产 user/credential 投影时使用 StringRecordId 绑定；应用路由写入转换的成功端到端行为因创建失败未验证。 |
| 部分失败恢复 | 正常失败后无对应 user/凭证，未出现 active 半成品；没有在生产注入凭证写入失败，补偿与恢复语义未验证。 |
| 动态会话注册与关闭 | 创建失败，pause/resume/retire 成功路径、运行窗口阻断及实际连接关闭均未验证。未操作既有业务员工来代替专用夹具。 |
| 退休凭证与 token 窗口 | 创建失败，旋转、过期窗口及退休后 SIGNIN 拒绝未验证。实测 HTTP 响应仅含去敏错误，没有 secret/token/root 凭证；服务日志未验证。 |
| 全部生命周期转换 | 重复/并发创建失败已覆盖；其他合法/非法状态迁移未验证。 |

## 交接与边界

结论 review return。请修复创建 500 与岗位 key 校验后重新部署，再送 QA 验证完整生命周期及动态 runtime 会话。不要改变已有生产员工或客户数据来绕过问题。

完整读取了领取返回的 task/context/project/history、票据、同簇 PRD、生产 runbook；加载 mastra、surrealql、ego-browser 技能。公司任务服务存入阶段 checkpoint 与本验收内容。
产品仓库本轮只读，无代码修改、commit、push、部署、SSH、root 登录、服务/数据目录操作；生产测试请求限登记测试 workspace，数据库复核仅查询，没有新增成功的员工或凭证，没有创建需登记的新 secret。浏览器任务空间结束；没有创建 agent 或定时器。Ego Lite 提示有更新，本轮未升级。
