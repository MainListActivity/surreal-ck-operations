/**
 * 命令多选：从命令目录（command-catalog.ts）里按分组下拉选择，已选的显示为可删除的标签。
 * 也可以选整个命名空间（如 `task.*`）。写死仅老板的命令员工本来就调用不了，不列出。
 * 已保存但不在目录里的值（旧命令名、手写的模式）照样显示，可以删除。
 */
import { HARD_OWNER_ONLY, matchesCommand } from '../../../src/command-guard.ts';
import { COMMAND_CATALOG, type CommandGroup } from '../command-catalog.ts';

const ownerOnly = (command: string) => HARD_OWNER_ONLY.some(pattern => matchesCommand(pattern, command));

/** 目录里员工可能调用的命令，按分组排列。 */
const GROUPS: Array<{ group: CommandGroup; items: Array<{ command: string; title: string }> }> = (() => {
  const groups = new Map<CommandGroup, Array<{ command: string; title: string }>>();
  for (const spec of COMMAND_CATALOG) {
    if (ownerOnly(spec.command)) continue;
    let list = groups.get(spec.group);
    if (!list) groups.set(spec.group, list = []);
    list.push({ command: spec.command, title: spec.title });
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }));
})();

/** 命名空间模式：目录里出现过的 `<前缀>.*`，至少覆盖两条命令才列出。 */
const NAMESPACES: string[] = (() => {
  const counts = new Map<string, number>();
  for (const { items } of GROUPS) for (const { command } of items) {
    const dot = command.indexOf('.');
    if (dot > 0) counts.set(command.slice(0, dot), (counts.get(command.slice(0, dot)) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n >= 2).map(([prefix]) => `${prefix}.*`).sort();
})();

const TITLE = new Map(COMMAND_CATALOG.map(spec => [spec.command, spec.title] as const));

export function CommandPicker({ value, onChange, disabled, label }: {
  value: readonly string[];
  onChange(next: string[]): void;
  disabled?: boolean;
  label: string;
}) {
  const chosen = new Set(value);
  const add = (command: string) => { if (command && !chosen.has(command)) onChange([...value, command]); };
  return (
    <div class="command-picker">
      {value.length ? (
        <ul class="picked">
          {value.map(command => (
            <li key={command} class="tag" title={TITLE.get(command) ?? (command.endsWith('.*') ? '整个命名空间' : '不在命令目录里')}>
              <code>{command}</code>
              <button type="button" class="ghost icon" aria-label={`移除 ${command}`} disabled={disabled} onClick={() => onChange(value.filter(c => c !== command))}>×</button>
            </li>
          ))}
        </ul>
      ) : null}
      <select aria-label={label} value="" disabled={disabled} onChange={e => { add(e.currentTarget.value); e.currentTarget.value = ''; }}>
        <option value="">添加命令…</option>
        <optgroup label="整个命名空间">
          {NAMESPACES.filter(ns => !chosen.has(ns)).map(ns => <option key={ns} value={ns}>{ns}</option>)}
        </optgroup>
        {GROUPS.map(({ group, items }) => (
          <optgroup key={group} label={group}>
            {items.filter(item => !chosen.has(item.command)).map(item => <option key={item.command} value={item.command}>{item.command} · {item.title}</option>)}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

/** 单选命令（受保护命令的新增）：同一份目录与命名空间，exclude 里的（已受保护的）不再列出。 */
export function CommandSelect({ value, onChange, disabled, label, exclude = [] }: {
  value: string;
  onChange(next: string): void;
  disabled?: boolean;
  label: string;
  exclude?: readonly string[];
}) {
  const skip = new Set(exclude);
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={e => onChange(e.currentTarget.value)}>
      <option value="">选择命令…</option>
      <optgroup label="整个命名空间">
        {NAMESPACES.filter(ns => !skip.has(ns)).map(ns => <option key={ns} value={ns}>{ns}</option>)}
      </optgroup>
      {GROUPS.map(({ group, items }) => (
        <optgroup key={group} label={group}>
          {items.filter(item => !skip.has(item.command)).map(item => <option key={item.command} value={item.command}>{item.command} · {item.title}</option>)}
        </optgroup>
      ))}
    </select>
  );
}
