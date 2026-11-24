// 旧定时更新器的过渡入口（node-updater.js）：节点更新已由原生执行端自己完成（src/runner/self-update.ts）。
//
// 尚未升级的节点上，旧更新器切换到本版本后会把这个文件装成新的 updater/node-updater.js；
// 之后它每轮只打印一行说明，不再通过 Paseo 切换插件。执行端启动后会卸载这个定时任务。
// 打包：bun build scripts/node-updater.ts --target node --outfile <file>（plugin-package.ts 调用）。

export interface CliIo {
  log(line: string): void;
}

export const RETIRED_NOTICE = '节点更新已由原生执行端接管（自更新），旧定时更新器不再切换版本；执行端启动后会卸载本定时任务';

/** 入口：返回退出码。argv 不含 node 与脚本路径。 */
export async function main(argv: string[], io: CliIo = { log: line => console.log(line) }): Promise<number> {
  const command = argv[0] ?? 'run';
  if (command === 'run' || command === 'status') {
    io.log(RETIRED_NOTICE);
    return 0;
  }
  io.log('用法：node <节点更新器> [run|status]');
  return 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
