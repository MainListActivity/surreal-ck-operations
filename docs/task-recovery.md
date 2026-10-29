# 任务恢复阶段与有效期

本次修复针对 FV06 5d44c123 的过期窗口、遗漏前置、错误循环升级，以及 abe7015e 的旧故障压住新经理待办。

## 行为契约

- `defer_task_until.continuation=manager`：所有依赖完成后回到经理，保留原 execute/review 相位；即使依赖已经完成也不直接派员工。带 executionWindow 的任务缺省采用 manager，旧任务保持原默认行为。
- `append_dependency_prerequisites`（gm/manage，窄口）：作用于**已经在依赖等待中**的执行相位任务。两种形状：**正式等待**（`state=blocked`、`blocked_to=NONE`、`wait_state=waiting`、`wait_kind=dependency`、`resume_state=ready` 且有匹配的 task_wait 行）；**存量等待**（`defer_task_until` 留下的执行等待：同样 `blocked`、`blocked_to=NONE`、`resume_state=ready|doing`，但没有 task_wait 行）——存量形状必须通过可审计证明才被接受：任务存在真实 `deferred` 审计且当前依赖至少一项未完成；受控事务在同一原子内**补建规范等待行**（`kind=dependency`、`reference_task=首个未完成依赖`、`entered_version=任务版本`），使普通 release 路径从此可见。两种形状都要求无活动租约、非 owner 关口、非 review 相位、同目标真实任务、至少一项新依赖；`expectedVersion` 必填 CAS，业务键幂等，依赖图 epoch＋闭包环检测，完整审计 `dependency_prerequisites_appended`（before/after、`wait_key`、原引用/新引用、`source_phase`、`legacy_wait` 标记、continuation=manager）。它保留原等待引用与全部既有依赖，只追加依赖并设 `dependency_continuation=manager`：不改 `state/blocked_to/resume_state`、不自动 resume、不清故障/预算/额度、不扩大普通派工；等待与全部前置完成后，wait release 把任务交回 GM 关口而不是 ready。作废（void）前置只满足依赖等式，不会授权过期执行窗口——经理真正 resume 时仍按 `executionWindow.notAfter` 拒绝。gm 阻塞（`blocked_to=gm`）、伪造形状（无 deferred 审计）、依赖已全部满足的任务都不在兼容范围内。
- 每项采样、独立批准等前置必须建为真实依赖；不能只写在恢复说明里。系统校验结构化依赖，不解析自然语言猜前置。
- `resume_task.executionWindow` 包含 approvalTask、configurationDigest、evidenceExpiresAt、minRemainingSeconds、notAfter。批准必须是本任务同目标、已完成的直接依赖，摘要和截止时间须匹配 prepare 登记的候选。notAfter 不得超过证据到期减去最小执行余量。
- 首次部署前的候选没有可信到期元数据，不能据文字补填；须真实重采样后 prepare 新候选并独立批准。证明工具继续核验不可变文件、身份和独立批准。
- 恢复、领取和实际证明/交付都校验窗口；过期领取在无活租约时转经理，绝不续期旧证据、放宽90分钟要求、增加次数或预算。统计领取 p95 不作为硬门禁。
- 新经理阶段以 resume/defer/dependency_unlocked 的审计边界识别。旧阶段故障不能吞掉新待办；通知分别登记实际落账时间 notified_at 和目标阶段 notified_stage_at，迟到旧通知不能覆盖新阶段；当前阶段相同故障仍去重，故障预算与非重试拒绝不变。
- `report_blocker.recoveryReason` 为 stale_window / missing_prerequisite / infrastructure。文件入口可写独立一行 `recoveryReason: missing_prerequisite`，非法值拒收；正文不推断类别。
- 所有 block 仍计数。新增真实未完成依赖或绑定新有效批准写 recovery_progress，开始新阶段；仅改文字/换员工/普通 resume 不清零。
- 已分类系统阻塞达到上限：原子建立唯一 GM 执行、product 独立复核的恢复任务，原任务等待它并以 manager 接续；完成恢复交付不等于业务验收。再次达到上限停止自动重派，留 recovery_stopped 审计，不无限建链或自动转老板。真正老板事项仍走 owner；没有结构化类别的旧入口保留原保护行为。

## 验证与上线

`RUN_SCK_LOOP_BREAKER_TESTS=1 bun test tests/task-recovery.test.ts tests/task-recovery.fork.test.ts tests/loop-breaker.fork.test.ts` 使用公司 fork，覆盖真实提交验收解锁、窗口过期与篡改、旧故障和新阶段、唯一恢复任务及再次停止。`bun scripts/test-worktrees.ts tests/dependency-prerequisites.fork.test.ts` 覆盖既有依赖等待的受控追加：成功路径与经理续接、并发 CAS、重放、非 GM、owner 关口、复核阶段、活动租约、跨目标、环、终态、重复前置与 void 前置下的过期窗口。

039 为增量元数据，不回填业务数据。双面重新 vendor；既有发布兼容性守卫同时要求接续与窗口检查能力，禁止回滚到会忽略新字段的旧发布。发布后针对已知 FV06 卡点单独核对版本、活租约与老板原授权，再登记经理恢复链；不批量改写旧任务、不伪造采样或验收。
