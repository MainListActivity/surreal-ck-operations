/**
 * response_too_large 的缩小建议：company_cmd 转发的老板端命令没有统一分页，逐命令给出真实支持的缩小方式。
 * 本机工具不在此列：它们的 pageSize/cursor 提示由 guardRelayResponse 的默认值承担。
 *
 * Kept out of the sidecar on purpose: the submit wiring check reads every `case "…":` in sidecar.ts as a dispatched
 * tool (src/submit-checks.ts), so a helper switch there would be taken for a tool. This module has no imports.
 */
export function companyCmdNarrowHint(args: unknown): string {
  const command = typeof (args as { command?: unknown })?.command === "string" ? (args as { command: string }).command : "";
  switch (command) {
    case "board.snapshot":
      return "board.task with taskId (a bounded per-task dispatch status); board.snapshot is the whole owner board and has no paging";
    case "progress":
      return "board.task with taskId for one task's queue position and block status; progress has no paging";
    case "task.list":
      return "task.detail with taskId for one task, or board.task with taskId for its dispatch status";
    case "task.detail":
    case "task.plan":
      return "board.task with taskId for a bounded status, or read_task_text for long fields";
    case "message.list":
    case "message.records":
      return "message.list with taskId";
    case "audit.list":
      return "audit.list with task, agent or command filters, or a smaller limit";
    default:
      return "the command's own filters (company_cmd_catalog lists them); board.task with taskId gives a bounded dispatch status";
  }
}
