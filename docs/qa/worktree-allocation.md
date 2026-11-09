# WT01 受控验证手册

## 本地演练（QA 不需要公司凭证）

在 PR 的独立 checkout/worktree 安装根和 plugin 依赖、执行 vendor.sh，运行：

```sh
rtk proxy pnpm install --frozen-lockfile
rtk proxy pnpm --dir plugin install --frozen-lockfile --ignore-scripts
rtk proxy sh plugin/scripts/vendor.sh
rtk proxy pnpm run typecheck
rtk proxy pnpm --dir plugin exec tsc --noEmit
rtk proxy pnpm run test:worktrees
```

入口 `scripts/test-worktrees.ts` 只启动 `~/.surrealdb/surreal` 公司 fork 的临时 rocksdb 实例；随机回环端口、合成测试身份、临时 Git 仓库，结束停止该实例并清除临时目录。显式 `SCK_PRODUCT_ENV=/dev/null`，不加载产品 `.env`、私人凭证或生产任务服务。不起真实 dispatcher/Paseo agent。`SCK_WORKTREE_EVIDENCE=<当前任务 evidenceDir 的绝对 JSON 路径>` 可输出本地实际任务/路径/branch/audit ID/时间和登记 before/after；临时路径在结束后不存在，JSON 明确 production=false，不替代生产验收。

覆盖：两次串行 QA 与 GM 共路径；两次串行工程共物理路径但独立分支，第二分支基线不带第一任务改动；两个独立进程同时首次 claim 分得 shared/exclusive，未提交改动互不串改；资产祖孙目录重叠排队、分离目录共享；读引用保护 checkout；重复 claim 不换 fence；真实 fork 重启后登记恢复、撤销交接保留 dirty 旧现场、旧 proof 拒绝；未授权/失败领取无有效引用；穿越、凭证目录与符号链接授权拒绝；真实 Dispatcher→Sidecar→claim.json→派工正文→Paseo cwd 同源；GM 非租约只读引用。原身份、租约、独立验收、任务流和通道重启隔离一并回归。

## 生产演练（上线后的部署/QA 腿）

此实现 PR 不合入部署，也不伪称生产已验证。经理在上线批准后安排演练任务与已有编制，QA 使用正常派工通道，不调管理接口、不自行创建员工，不读取凭证。所有 task 创建都由 manager 的已有 `create_task` 权限完成，任务标题标识 WT01 演练；任务工作范围由 workIntent 明示，写测试只在临时演练仓库的 test 目录，不能用业务数据。若项目需要新的演练仓库登记由 GM 配置 project，QA 上报依赖，不能绕权。

1. 由 gm 执行 `list_worktrees {}`（全局库存），保存登记数、有效引用数和 audit 时间。默认返回完整数组；超出预算报 `response_too_large` 时，改用 `{"pageSize":25}` 并按 `page.nextCursor` 逐页读完，累加每页 `worktrees` 的数量作为登记数，`page.total` 用于核对。非 gm 角色（包括 QA）调用时必须带 `taskId`，否则返回 `forbidden`；记录 active MCP release commit、插件运行 commit/vendor/schema 011 哈希、running、`/ready`、`get_context`。
2. 排两项 QA 或 GM read 任务，第一项正常提交后第二项才解锁。两位持有人在自己的 claim.json 记录 `worktree.worktreePath/mode/branch`，第二项应同路径。由 gm 或 QA 带 `taskId` 执行 `list_worktrees {"taskId":"<任务ID>","includeReleased":true}`（需要分页时加 `pageSize`）查询第一项 released、第二项 active。released 引用默认只计数，不带 `includeReleased` 列不出它；记录准确员工及任务 ID。
3. 排两项串行 engineering code 任务：第一项在其登记任务分支提交小测试文件并正常提交；第二项依赖第一项完成且 shared 没有其它活动引用。期望同路径、不同 task 分支，第二分支基线不包含第一任务提交。PR/提交必须各自独立。
4. 排两个无依赖 engineering code 任务，由调度器正常并行派发。第一项保持在办现场时才释放第二项；期望路径不同（第二 exclusive），第一路径/branch 未迁移。各在授权临时目录写不同标记，读回自己的标记，不能出现对方未提交改动。
5. 管理方排两个 assets 任务，目录分别 `assets/characters` 与其子目录；第二项应留 ready/无 currentEmployee（worktree_busy），第一提交后恢复。另排 `assets/music` 应可与 characters 共物理树。任务不自行 commit 或切分支。
6. 使用正常受控 plugin reload 检查真实派发恢复：记录前后 assignment、audit claim/fence 增长、旧会话隔离；不杀业务 worker，不起重复 dispatcher。要做旧 proof 拒绝测试，走已有独立通道用例/由 GM 安排，QA 不取得 proof 凭证。
7. 记录 after 数量。每项任务的 `list_worktrees` 结果（时间、引用、reasons）带 `taskId` 与 `includeReleased:true` 读取；全局数量由 gm 分页读取，口径同第 1 步。main、常驻插件与 active/回滚 release 应 protected。任何 dirty/交接/漂移树仍保留，本链无删除。

证据分开列本地与生产，不能以 fixture task ID 充当生产 task。图片、导出 JSON 和手册附件写 claim.evidenceDir，用 `deliverable_publish` 得到老板可点 URL。生产未发生则填写「未验证，待批准上线后的部署/QA 腿」，不要以 PR CI 通过替代上线。
