// 0.13.84 及之前的发行包把执行端源码放在 current/server/vendor/src（Paseo 插件布局），0.13.85 起是 current/src。
// 节点私有配置 native-runner.json 里的通道命令可能还写着旧路径：旧路径不存在、新路径存在时换成新路径，
// 切换布局的那一刻通道不断；配置改成新路径后这里什么都不做。
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';

export function remapLegacyRuntimePaths<T extends Record<string, string[] | undefined>>(
  commands: T, home: string, exists: (path: string) => boolean = existsSync,
): { commands: T; remapped: string[] } {
  const legacy = join(home, 'current', 'server', 'vendor', 'src') + sep;
  const remapped: string[] = [];
  const out = {} as Record<string, string[] | undefined>;
  for (const [provider, command] of Object.entries(commands)) {
    out[provider] = command?.map(part => {
      if (!part.startsWith(legacy) || exists(part)) return part;
      const next = join(home, 'current', 'src', part.slice(legacy.length));
      if (!exists(next)) return part;
      remapped.push(provider);
      return next;
    });
  }
  return { commands: out as T, remapped: [...new Set(remapped)] };
}
