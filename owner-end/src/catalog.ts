/**
 * 命令目录的视角（cmd.catalog）。老板看到全部命令；员工只看到本员工当前能调用的命令：
 * 与守卫共用同一套判定（写死仅老板、保护清单、允许与禁止清单、停用），再去掉只给老板看的观测命令。
 * 租约不在这里核对：目录只说明“能用什么”，真正调用时仍逐条过守卫与租约。
 */
import type { Surreal } from 'surrealdb';
import { agentRefusal, guardRowsOf, matchesCommand, protectedOwnerOnlyOf } from '../../src/command-guard.ts';
import { COMMAND_CATALOG, type CommandSpec } from './command-catalog.ts';
import { IDP_READS, OWNER_ONLY_FOR_AGENTS, TARGET_LOCKS } from './owner-locks.ts';

/** 目录里的一条：说明加上按目标锁定的提示。lock 只说明员工调用时命中即拒绝，老板不受限。 */
export interface CatalogEntry extends CommandSpec {
  lock?: string;
}

export type CatalogViewer = { owner: true } | { owner: false; employee: string };

export interface CommandCatalog {
  scope: 'owner' | 'agent';
  commands: CatalogEntry[];
}

/** 按目标锁的说明（来自 TARGET_LOCKS）；只读的身份命令不锁。 */
function withLock(spec: CommandSpec): CatalogEntry {
  if (IDP_READS.has(spec.command)) return spec;
  const lock = TARGET_LOCKS.find((item) => matchesCommand(item.command, spec.command));
  return lock ? { ...spec, lock: lock.target } : spec;
}

export async function commandCatalogOf(db: Surreal, viewer: CatalogViewer): Promise<CommandCatalog> {
  if (viewer.owner) return { scope: 'owner', commands: COMMAND_CATALOG.map(withLock) };
  const rows = await guardRowsOf(db, viewer.employee);
  const commands = COMMAND_CATALOG
    .filter((spec) => !OWNER_ONLY_FOR_AGENTS.includes(spec.command)
      && agentRefusal(spec.command, rows.policy, protectedOwnerOnlyOf(rows.protectedRows, spec.command)) === undefined)
    .map(withLock);
  return { scope: 'agent', commands };
}
