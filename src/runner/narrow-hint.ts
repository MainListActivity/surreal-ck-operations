/**
 * response_too_large 的缩小建议：company_cmd 转发的老板端命令没有统一分页，逐命令给出真实支持的缩小方式。
 * 只写员工能调用的命令（owner 专属与被守卫拒绝的命令到不了这里）。没有参数可缩小的，明说没有，不指向不存在的参数。
 * 本机工具不在此列：它们的 pageSize/cursor 提示由 guardRelayResponse 的默认值承担。
 *
 * Kept out of the sidecar on purpose: the submit wiring check reads every `case "…":` in sidecar.ts as a dispatched
 * tool (src/submit-checks.ts), so a helper switch there would be taken for a tool. This module has no imports.
 */
export function companyCmdNarrowHint(args: unknown): string {
  const command = typeof (args as { command?: unknown })?.command === "string" ? (args as { command: string }).command : "";
  switch (command) {
    case "board.snapshot":
    case "progress":
      return "board.task with taskId, the bounded dispatch status of one task (board.snapshot and progress have no paging)";
    case "task.list":
      return "task.detail with taskId for one task (task.list has no paging)";
    case "task.detail":
      return "read_task_text for a long text field, message.list with taskId for the task's messages, or board.task with taskId for its dispatch status (task.detail has no paging)";
    case "task.plan":
      return "task.detail with taskId for one task of the chain (task.plan has no paging)";
    case "task.cost":
      return "task.cost with taskId for one task; without taskId, a smaller days (1 to 60, 7 by default)";
    case "message.list":
      return "message.list with taskId for one task, or includeSent false to leave out the sent messages";
    case "note.list":
      return "note.list with lane for one lane's notes";
    case "note.consolidations":
      return "note.consolidations with a smaller limit";
    case "db.read":
      return "a narrower SELECT in sql, with a WHERE clause or a LIMIT";
    default:
      return "no paging or filter parameter for this command (company_cmd_catalog lists its parameters); ask for one item by its id if the command takes one";
  }
}
