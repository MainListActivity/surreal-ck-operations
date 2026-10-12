# internal-ai 公司签发端 v2 发布配套

本变更只实现公司端，不构成上线批准。产品候选为 [PR175](https://github.com/MainListActivity/surreal_ck/pull/175)，固定 SHA `1adf73aeaf8b14a7e9b30c1ef0d7a340f63dc16a`。前置冻结任务 `19b2f4d9-b63d-42c2-98b9-902ccd9095fb` 已独立验收；公司实现从 `43af0eefeb5149f6e77e1b027ebda87d48712ef2` 起步。产品 head 有变须重新提取、比较，并同时重核公司链和原申请 a75520d3。

## 源码镜像与复验

产品路径 `shared/src/internal-ai-proof.ts`，全文件 SHA256 `3773b6a592cf1b8125ca4654ac51f14ba1e2214ab84ea49d64b2da09322af93e`。公司路径 `src/ops/proof-contract.ts`。冻结区域为 FREE 常量及注释 27–28、boundedRef/httpsSource/model helper 38–45、evidenceBase/controlFreeText/schema/type 142–186。分段哈希依次为 `a412327b391850d82dd0540bda331f6ca0538b1493ca12781751b640779c0cee`、`c99660d297be93753109d9d9e29e9192736e6f97d892e4082f811563e5548fea`、`e8a51987be3ee629cd5590cc8c8401ddfb78687089a89d56e1471f5129bae56c`；原字节连接哈希 `f00621923eb24f2d7178fc03075d7876de4fc25891f8ea14bb62f87eddf79f20`。

`scripts/extract-proof-mirror.py` 为已冻结提取脚本的原样副本，唯一锚缺失/重复即失败；不格式化、不改名、不规范化 JSON。先成功获取固定产品与公司提交的完整原始源码到当前任务 evidenceDir，再分别传源码路径和输出目录运行脚本，运行 `diff -u <product-output>/mirror.ts <company-output>/mirror.ts`，保存空 stdout 与 exit=0，记录双方固定 SHA/路径和原始 SHA256。发布生成的 plugin vendor 也独立提取核验；首行 ts-nocheck 不属于镜像区。不可用工作树未提交内容代替最终公司固定提交。fixtures 只能用于本地 schema 交叉测试，不作为真实账户证据。

本地验证按锁文件安装根及插件依赖、执行 `sh plugin/scripts/vendor.sh` 后检查两面 typecheck；`pnpm test:bridge` 现包含镜像与 sampler 回归；`RUN_COMPANY_PROOF_FORK_TESTS=1 bun test tests/internal-ai-proof.fork.test.ts` 仅启动 `~/.surrealdb/surreal` 公司 fork。仓库无 lint script，用 `git diff --check` 检查空白，不称其为 lint。样本 [synthetic JSON](./examples/internal-ai-token-plan-v2.synthetic.json) 仅演示形状，固定时间会过期，不能用于生产 prepare。

## 部署顺序与拒绝窗口

本链先独立工程复核，再由运营决定上线。上线申请带公司 PR/完整 SHA、固定产品候选 SHA、镜像空 diff、测试、未验证项、失配窗口、部署及回滚方案。不合并产品 PR，不套用产品 Cloudflare/Origin 发布，不修改运行 release/vendor。

获准的公司部署腿须重新读取最新 main 的 [固定 release 双面 runbook](./company-service-operations.md)，按批准 PR 合入 main 的固定提交生成 release，以受控 vendor.sh 重生成插件，锁文件装依赖与两面 typecheck 通过后安装 MCP 与重指现有 Paseo 插件；active、插件 SOURCE/DIRECTORY、vendor 镜像必须同版本。不得 checkout/reset/pull 共享树、SSH、新建 agent/定时器或绕发布门禁。回滚基线由部署腿实读上一固定 release 和插件路径，不能把起步 SHA 当成届时实际回滚版本。

公司先 v2 → 原 a75520d3 产品上线申请重提并运营 accept → 原产品部署腿合入 PR175，独立 QA 验证 origin/web、迁移38、接收v2/拒绝v1。公司 v2 生效至双端匹配且生产 QA 完成期间保持活动 disabled，停止消费者证明投递和 token-plan 启用/计量周期启动、重启、自动重试。仅允许公司 QA 按自身租约做本地 prepare / 必要 register-disabled，不投递尚 v1 消费者、不 enable、不调模型。v2文档在旧产品 schema 拒绝；JWT 仍v1，不声称JWT全面拒绝。不得兼收v1、默认补FREE或放宽预算来规避窗口。

公司发布失败回退上一固定 release，两面同步验证；产品阶段失败优先禁用受影响活动、停止投递，按既有兼容门禁回退匹配版本，新增可空列不删除。窗口无自动结束时间，部署腿记录开始，产品 QA 记录关闭。

## 公司部署 QA 接手

实读 active、插件版本及 vendor 对齐；ops_info adapter 应为 sensenova-token-plan/2。由 ops_* 受控真实账户采样，脱敏文档/回执以 deliverable_publish 发布。核验 FREE 的 poolUsage 来源和 API key/console 账户交叉绑定、官方正面出处、配额硬顶、UTF-8 原文 hash、≤24h窗口。用自身租约 prepare / 必要 register-disabled 验 v2接受、v1/非FREE拒绝；真实身份资料缺口需列明，synthetic不能补位。记录固定 release、插件版本、真实回滚基线和镜像空 diff，发布链接交原 a75520d3。

公司 QA 可按“签发端可产v2且失败闭锁”完成，不等待产品 PR175 上线。真实 consumer 投递、新预算和 UI 验收交后续产品链；不宣称跨端v2完整链路已通，不恢复9a90fe76/022a8ebc指标。
