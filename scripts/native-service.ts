// Install the independent runtime as a supervised service (no scheduler). Configuration contains paths, never credentials.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { serviceHome } from '../src/runner/env.ts';
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const xml = (s: string) => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function installNativeService(options: {home: string; userHome: string; id: string; config: string; platform: string; load: boolean}) {
  const {home, userHome, id, config, platform, load} = options;
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || !isAbsolute(home) || !isAbsolute(config)) throw new Error('需要有效节点 ID 与绝对路径');
  if (!['darwin','linux'].includes(platform)) throw new Error('只支持 macOS 与 Linux 服务');
  const parsed = JSON.parse(readFileSync(config,'utf8'));
  if (!Object.keys(parsed.commands ?? {}).length) throw new Error('配置缺少 commands');
  for (const path of [join(home,'current/server/vendor/src/runner/run.ts'), join(home,'bin/bun-runtime.sh')])
    if (!existsSync(path)) throw new Error(`已安装的发行文件缺失：${path}`);
  const dir = join(home,'native',id); mkdirSync(dir,{recursive:true,mode:0o700});
  mkdirSync(join(home,'logs'),{recursive:true,mode:0o700});
  const launcher = join(dir,'run.sh');
  writeFileSync(launcher, `#!/bin/sh\nset -eu\nexport SCK_SERVICE_HOME=${quote(home)}\nexport SCK_RUNNER_ID=${quote(id)}\nexport SCK_NATIVE_CONFIG=${quote(config)}\nexport SCK_NATIVE_FOLLOW_CURRENT=1\nexport PATH=${quote(join(userHome,'.local/bin') + ':' + join(userHome,'.bun/bin') + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')}\n. ${quote(join(home,'bin/bun-runtime.sh'))}\nresolve_bun "$SCK_SERVICE_HOME"\ncd "$SCK_SERVICE_HOME/current"\nexec "$BUN" "$SCK_SERVICE_HOME/current/server/vendor/src/runner/run.ts"\n`, {mode:0o700});
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
