# FV06 产品证据来源与恢复边界

产品使用现有 remote-magpie 连接中的 work 路由。该配置属于已确定前提；修复公司工具不能将产品改为本机 Claude、创建 Mac 的 work 组或更换产品供应商。

VPS 上的 `http://127.0.0.1:3425/v1` 与 Mac 上同样的 URL 是两个不同来源。模型目录中的 `remote-magpie/group/work` 是 Mac 看到的远端引用；对应远端调用引用 `group/work`，配置存储 ID 才是 `work`。不能因 Mac 没有 work 组推断产品缺组。

生产 `surreal_ck` 的 `ops_magpie_route_sample` / `ops_magpie_route_restore` 返回 `product_gateway_source_mismatch`，并指向 `ops_product_magpie_observe`。旧本机 v4 契约保留历史兼容，但不适用于本产品的远端证据，不能要求个人订阅密封为产品供应商。

`ops_product_magpie_observe {}` 复用老板已有 remote-magpie HTTPS 连接。员工不能覆盖地址、模型、账号或凭证。仅 GET models / quotas / usage，受现有任务、角色、策略和故障预算控制，不调用推理、不改配置。

回执 `product-magpie-observation/1` 明示 source、远端 endpoint、模型引用、来源 SHA256、抓取时刻与覆盖范围。只读取最近200条，最多返回10条匹配 work 的记录；不足不能推断不存在。使用 Magpie 实际字段 req/served/in/out/t/status/ms/stop；无 done 字段不机械判为失败。完成态需成功状态、正耗时和结束标志，仍不代表端到端UI成功。账号仅出哈希，不能把同供应商的其他账号余额冒充本次请求余额；关联信息缺失保持unknown。价目读取 prompt/completion 字符串；缺失保持null，已核零价与未受审授权区分。

此回执只是观测，不是新供应商授权证书。不得把它改字段伪装为 v4 文档，或用来自动 prepare/prove/deliver/enable；不授予任何预算。产品实际配置需与 `ops_request GET /api/ops/internal-ai/runtime`、产品 run/requestId 对应核验。剩余30次预算用尽是独立事实，不能通过更换任务、组、身份或周期重领；只读观测不消耗模型次数。

## 本次根因的时间线

- 2026-10-09：原目标要求生产首次体验和四指标基线。拆解后增加真实用量、现金/次数预算、账户和受审证据门禁；这部分有合理约束，但不是要求永久绑定特定供应商。
- 10-16至10-27：新证据有效期、周期和依赖接力反复错过窗口，继续产生重采样/重新批准；同时存在真实登录、容量及生命周期缺陷，不能把所有工作笼统归为空转。
- 10-28 10:44Z：老板管理任务91d486正式采用已经配置的产品Magpie路径。描述写了产品的loopback地址，但没有记录执行主机；两条实现链在输入冻结28eb31b1结束前已经创建，未知来源被提前固化。
- 10-28：0ec530ce代码把来源默认落在Mac，组ID硬写为group/work，并使用合成字段done、pricing.input/output。独立评审和部署QA验证了拒绝路径，却把无法产生真实正向证据列为后续配置前置。
- 10-28 23:09Z：cdc2dd4c对Mac采样得出缺组/缺密封账号，33eaa21e将其变为恢复前置，继续产生恢复工具链。
- 10-29 02:15Z：10abba95已经证明组引用/存储ID、done与真实价目字段错误。02:38Z上报仍以旧v4前提排除远端，提出个人Claude账号或停线，说明技术不兼容被误当成老板账号选择。
- 本次只读复核：现有remote-magpie的远端目录、配额和用量均200，远端存在group/work；Mac目录则只出现remote-magpie/group/work。产品缺组的前提被反证。

责任归因：任务描述的来源主机歧义、适配器对真实API的错误假设、验收只验证闭锁而未覆盖现役正向来源，以及经理继续沿用已知过时契约共同导致；不能归因于老板未提供账号或未决定改模型。

详细原始审计和维护验证保存在本机维护目录，不在仓库提交原始账号、凭证或客户数据。目标、G3、历史失败和未完成状态均保留；纠正来源不等于四指标已完成。
