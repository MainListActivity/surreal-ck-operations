# WT02 工作树生命周期：回收、孤儿 sweep 与四仓对账

## 语义摘要

| 事件 | 引用 | 物理树 |
|---|---|---|
| 租约过期 / 撤回交接 | 释放旧员工/fence；非终态任务保留 recovery 引用 | 不删，接手续用 |
| 任务 done（验收通过） | 任务保留引用结束 | exclusive 干净且无有效引用则立即回收；shared 保留 |
| 脏树 / 未跟踪改动 | 不变 | 保留，审计 reason=`dirty-or-untracked` |
| 未合并任务分支 | 树可删 | 本地分支仅 `git branch -d`；失败则 `branch_retain` 审计 |
| 孤儿宽限 N（默认 7 天） | 无 active/recovery 引用 | 仅公司管理任务树；时钟=last_released_at → last_used_at → created_at |

删除唯一依据：持久 `worktree` / `worktree_ref` / `worktree_session_ref` 与实时对账。不用文件 mtime，不用 `git worktree remove --force` / `branch -D`，不借 `git prune` 扩大删除面。

## 本地受控演练（QA 无需公司凭证）

```sh
rtk proxy pnpm install --frozen-lockfile
rtk proxy pnpm --dir plugin install --frozen-lockfile --ignore-scripts
rtk proxy sh plugin/scripts/vendor.sh
rtk proxy pnpm run typecheck
rtk proxy pnpm --dir plugin exec tsc --noEmit
rtk proxy pnpm run test:worktrees
```

`scripts/test-worktrees.ts` 启动公司 fork SurrealDB 临时实例，覆盖 WT01 分配回归 + WT02 回收/宽限/禁用开关/审计。可设 `SCK_WORKTREE_EVIDENCE=<evidenceDir/json>` 导出本地 before/after。`production=false`。

## 开关与配置

| 键 | 作用 |
|---|---|
| `SCK_WORKTREE_RECLAIM=0` | 紧急关闭回收（两面同时设）；登记与审计保留 |
| `SCK_WORKTREE_ORPHAN_GRACE_DAYS` | 孤儿宽限天数，默认 7 |
| `company_meta:config.worktree_reclaim_enabled` | 运营可配；环境变量优先 |
| `company_meta:config.worktree_orphan_grace_days` | 同上 |
| `SCK_WORKTREE_STRATEGY=legacy` | WT01 回退：新代码独占；与回收开关独立 |

关闭回收或回滚代码后，schema 012 审计表与既有登记不删除。

## 生产查询与 dry-run

```sh
# 全局库存（GM）
sck call list_worktrees '{}'

# dry-run：只写 audit，不删
sck call reclaim_worktrees '{"dryRun":true}'

# 执行回收（仍跳过 protected/shared/dirty/宽限内）
sck call reclaim_worktrees '{}'

# 持久审计
sck call list_worktree_audits '{"limit":100}'
```

调度器沿用既有 10 分钟 sweep；accept 成功后对终态任务事件触发一次回收，失败由 sweep 重试。

## 四仓存量对账

覆盖 `surreal-ck-operations`、`surreal_ck`、`ma_hono`、`maplayer-content` 的 `git worktree list`：

- 主 checkout、shared、插件长期树、`SurrealCKCompany/releases/*`、外部工具（如 `~/.codex/worktrees`）、归属不明 detached：`protected` / `unknown`，无引用也不自动删
- 公司任务形态：`*-task-<id8>`、`*-wt-<id8>`、`*-review-<id8>`、`task/<id8>` 与带后缀分支；存量无可靠时间时以首次登记为宽限起点
- 先 dry-run 清单（逐项理由），再同一判定清理已确认孤儿

## 生产演练（上线后 QA 腿）

1. 经理取 `list_worktrees {}` 与四仓 git list 作 before；记录 MCP/插件提交与 schema 012 哈希
2. 串行/并行工程任务：done 后 exclusive 不在 `git worktree list`，shared 仍在；两写手未提交改动互不覆盖
3. fixture：dirty exclusive 保留；租约过期交接 recovery 保留；把 fixture `last_released_at` 拨到 N 前，经真实 sweep 删除；N 内与保护树仍在；`list_worktree_audits` 可见 success/skip/fail
4. 至少 10 个同仓串行任务后 shared 数不增加；并行峰值与写手数相关；结束后收敛到共享/受保护基线加明确保留例外
5. `SCK_WORKTREE_RECLAIM=0` 验证可关闭；回滚后登记/审计仍在

证据写 `evidenceDir`，老板可打开的手册与摘要用 `deliverable_publish`。
