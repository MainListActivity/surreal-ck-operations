/** Persistent conversations cannot be run by a dispatcher that ignores their goal binding. */
export const GOAL_WORKSPACE_CONTRACT = 'sck-goal-workspace/v1';
export const workspaceScopeFor = (goalId?: string): string => goalId ?? 'maintenance';
