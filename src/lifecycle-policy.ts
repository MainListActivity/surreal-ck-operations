/** Lifecycle control belongs to the runner/owner, while employee tools provide working capabilities. */
export const LIFECYCLE_COMMANDS = [
  'task.create', 'task.update', 'task.reassign', 'task.revoke', 'task.void', 'task.delete', 'task.pause', 'task.resume',
  'decide', 'approve', 'reject', 'reply', 'message.edit', 'message.edit_rendered', 'message.hold', 'message.release', 'message.send',
] as const;
