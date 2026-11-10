/** 老板只读命令：不写操作审计，设计模式也不能把读取当作变更推送。 */
const READ_ONLY = new Set([
  'status',
  'progress',
  'brief',
  'inbox',
  'board.snapshot',
  'db.read',
  'translate.preview',
  'idp.status',
  'idp.user.list_agents',
  'cmd.catalog',
  'requirement.execution',
]);
const READ_SUFFIX = /\.(list|get|detail|preview|plan|consolidations|records)$/;
export const isReadOnlyCommand = (command: string): boolean =>
  READ_ONLY.has(command) || READ_SUFFIX.test(command);
