// Install the independent runtime as a supervised service (no scheduler). Configuration contains paths, never credentials.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { serviceHome } from '../src/runner/env.ts';
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const xml = (s: string) => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
/** 执行端入口在运行目录里的相对路径，按顺序取第一个存在的（发行包布局变化时启动脚本不用重装）。 */
export const RUNNER_ENTRIES = ['server/vendor/src/runner/run.ts', 'src/runner/run.ts'] as const;
/** 新版本连续这么多次启动都没有确认，启动脚本就把 current 指回旧版本。 */
export const CONFIRM_ATTEMPTS = 3;

/**
 * 服务启动脚本。除了导出环境并启动执行端，还负责自更新的兜底回退：src/node-updater.ts 切换 current 前写
 * updater/pending（第 1 行新运行目录、第 2 行旧运行目录），新版本健康后删除它。标记还在且 current 仍指向新版本时，
 * 每次启动计一次数；超过 CONFIRM_ATTEMPTS 次就把 current 指回旧版本，由旧版本启动后补记回退。
 * 这段逻辑不随发行版本更新，坏版本无法破坏自己的回退路径。
 */
export function launcherScript(o: {home: string; id: string; config: string; path: string}): string {
  const entries = RUNNER_ENTRIES.map(entry => `'${entry}'`).join(' ');
  return `#!/bin/sh
set -eu
export SCK_SERVICE_HOME=${quote(o.home)}
export SCK_RUNNER_ID=${quote(o.id)}
export SCK_NATIVE_CONFIG=${quote(o.config)}
export SCK_NATIVE_FOLLOW_CURRENT=1
export PATH=${quote(o.path)}
. ${quote(join(o.home,'bin/bun-runtime.sh'))}
resolve_bun "$SCK_SERVICE_HOME"
pending="$SCK_SERVICE_HOME/updater/pending"
if [ -f "$pending" ]; then
  to=$(sed -n 1p "$pending")
  from=$(sed -n 2p "$pending")
  live=$(cd "$SCK_SERVICE_HOME/current" 2>/dev/null && pwd -P || true)
  want=$(cd "$to" 2>/dev/null && pwd -P || true)
  if [ -n "$live" ] && [ "$live" = "$want" ]; then
    n=$(cat "$pending.attempts" 2>/dev/null || echo 0)
    case "$n" in ''|*[!0-9]*) n=0 ;; esac
    n=$((n + 1))
    if [ "$n" -gt ${CONFIRM_ATTEMPTS} ] && [ -n "$from" ] && [ -d "$from" ]; then
      ln -sfn "$from" "$SCK_SERVICE_HOME/current"
      printf '%s\n' "$((n - 1))" > "$pending.rolled-back"
      echo "启动脚本：新版本连续 $((n - 1)) 次启动未确认，current 已指回 $from" >&2
    else
      printf '%s\n' "$n" > "$pending.attempts"
    fi
  fi
fi
for entry in ${entries}; do
  if [ -f "$SCK_SERVICE_HOME/current/$entry" ]; then
    cd "$SCK_SERVICE_HOME/current"
    exec "$BUN" "$SCK_SERVICE_HOME/current/$entry"
  fi
done
echo "启动脚本：$SCK_SERVICE_HOME/current 下没有执行端入口" >&2
exit 78
`;
}

export function installNativeService(options: {home: string; userHome: string; id: string; config: string; platform: string; load: boolean}) {
  const {home, userHome, id, config, platform, load} = options;
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || !isAbsolute(home) || !isAbsolute(config)) throw new Error('需要有效节点 ID 与绝对路径');
  if (!['darwin','linux'].includes(platform)) throw new Error('只支持 macOS 与 Linux 服务');
  const parsed = JSON.parse(readFileSync(config,'utf8'));
  if (!Object.keys(parsed.commands ?? {}).length) throw new Error('配置缺少 commands');
  if (!RUNNER_ENTRIES.some(entry => existsSync(join(home,'current',entry)))) throw new Error(`已安装的发行文件缺失：${join(home,'current',RUNNER_ENTRIES[0])}`);
  if (!existsSync(join(home,'bin/bun-runtime.sh'))) throw new Error(`已安装的发行文件缺失：${join(home,'bin/bun-runtime.sh')}`);
  const dir = join(home,'native',id); mkdirSync(dir,{recursive:true,mode:0o700});
  mkdirSync(join(home,'logs'),{recursive:true,mode:0o700});
  // The employee sandbox forbids writes to bin; launchd must never execute an employee-writable file.
  // Configured absolute commands (native-runner.json commands / lanes.*.bin) may sit outside the stock
  // PATH (the codex CLI at ~/node/bin was the case in production), so their directories join the service
  // PATH after the stock entries, keeping the existing resolution order first.
  const basePath = [join(userHome,'.local/bin'), join(userHome,'.bun/bin'), '/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin'];
  const binDirs = new Set<string>();
  for (const command of Object.values((parsed.commands ?? {}) as Record<string, string[]>))
    for (const part of command ?? []) if (typeof part === 'string' && isAbsolute(part)) binDirs.add(dirname(part));
  for (const lane of Object.values((parsed.lanes ?? {}) as Record<string, {bin?: Record<string,string>}>))
    for (const path of Object.values(lane?.bin ?? {})) if (typeof path === 'string' && isAbsolute(path)) binDirs.add(dirname(path));
  const servicePath = [...basePath, ...[...binDirs].filter(dir => !basePath.includes(dir))].join(':');
  const launcher = join(home,'bin',`native-${id}.sh`);
  writeFileSync(launcher, launcherScript({home, id, config, path: servicePath}), {mode:0o700});
  if (platform === 'darwin') {
    const label = `org.surrealck.native.${id}`;
    const parent = join(userHome,'Library/LaunchAgents'); mkdirSync(parent,{recursive:true});
    const path = join(parent, `${label}.plist`);
    const log = join(home,'logs',`native-${id}.log`);
    writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>${xml(launcher)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>`, {mode:0o600});
    if (load) execFileSync('/bin/launchctl',['bootstrap',`gui/${process.getuid!()}`,path],{stdio:'inherit'});
    return path;
  }
  const parent = join(userHome,'.config/systemd/user'); mkdirSync(parent,{recursive:true});
  const unit = `sck-native-${id}.service`, path = join(parent,unit);
  const systemdPath = launcher.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%');
  writeFileSync(path, `[Unit]\nDescription=SurrealCK independent agent runtime\n[Service]\nType=simple\nExecStart="${systemdPath}"\nRestart=always\nRestartSec=30\n[Install]\nWantedBy=default.target\n`,{mode:0o600});
  if (load) { execFileSync('systemctl',['--user','daemon-reload'],{stdio:'inherit'}); execFileSync('systemctl',['--user','enable','--now',unit],{stdio:'inherit'}); }
  return path;
}
if (import.meta.main) {
  const [id, config, option] = process.argv.slice(2);
  if (!id || !config || (option && option !== '--no-load')) throw new Error('用法：bun scripts/native-service.ts <节点ID> <配置绝对路径> [--no-load]');
  console.log(installNativeService({home:serviceHome(),userHome:homedir(),id,config,platform:process.platform,load:option !== '--no-load'}));
  console.log('服务已安装。确认 native:<节点ID> 心跳与模型配置后，再设置 private/runtime-routes.json；安装不会修改生产派工路由。');
}
