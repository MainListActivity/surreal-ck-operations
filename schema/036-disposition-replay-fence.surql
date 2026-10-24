-- SYS03 第三轮（QA v23 退回）的两个新字段。只新增字段，不改写任何既有字段、索引或行：
-- 旧版 release 读到多出来的字段会忽略，新版对旧行按 NONE 处理（holder_before 走 claim 兜底、
-- post_claimed = NONE 视为「这条 actionKey 的 provider 出口还没被占用过」），所以新旧两版可以同时
-- 对着同一批行工作（RB01）。
--
--   disposition_action.holder_before —— QA D8：**请求处置时**任务持有人的快照。占位事务与任务版本 CAS 在
--     同一个事务里读到它，重放/接手时用它当持有人通知的收件人；否则状态机（resume 会换掉 current_employee）
--     跑完之后再去读任务，读到的是另一个人，通知就投给了无关员工。
--   external_action.post_claimed   —— QA D3：这条 actionKey 的真实 provider 出口有没有被占用过。重放只读 provider
--     状态、绝不重发取消请求；占位在 POST 之前由一条 `UPDATE ... WHERE post_claimed != true` 原子置位，所以
--     「在占位之前崩溃」的行仍然可以由下一次请求补发，而「已经发出去、回执丢了」的行绝不会再发第二次。
DEFINE FIELD IF NOT EXISTS holder_before ON disposition_action TYPE option<string>;
-- DEFAULT false：非 option 的字段没有默认值时，CREATE 里省略它会被 SCHEMAFULL 拒（对账写带外行时正是省略的写法）。
-- 既有行读到的仍是 NONE，调用方按「没标记 = 视为已经发过一次」处理（保守，绝不重复 POST）。
DEFINE FIELD IF NOT EXISTS post_claimed ON external_action TYPE bool DEFAULT false;