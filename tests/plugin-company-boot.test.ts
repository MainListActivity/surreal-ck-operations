import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 插件的公司栈惰性启动。生产路径（NODE_ENV 不是 test）缺 COMPANY_DB_URL 时，在读取节点、连接任何库之前拒绝，并说明原因。
// 在子进程里启动：bun test 同一进程里，其它文件可能用 mock.module 替换 plugin/server/company.ts，company() 的结果也按模块缓存。
// company.ts 顶层导入的是 plugin/server/vendor 下的副本：本地先运行 sh plugin/scripts/vendor.sh；CI 在 test:service 之前执行同一步骤。
const COMPANY = join(import.meta.dir, '../plugin/server/company.ts');

interface Outcome { started: boolean; message?: string; importFailed?: string }

/** 用生产环境变量在新进程里调用 company()，返回它是否启动，以及拒绝时的原因。子进程的主目录也指向临时目录。 */
async function startCompanyStack(home: string): Promise<Outcome> {
  const probe = `(async () => {
  const { company } = await import(${JSON.stringify(COMPANY)});
  const outcome = await company().then(
    () => ({ started: true }),
    (error) => ({ started: false, message: String((error && error.message) || error) }),
  );
  console.log('RESULT ' + JSON.stringify(outcome));
  process.exit(0);
})().catch((error) => {
  console.log('RESULT ' + JSON.stringify({ started: false, importFailed: String((error && error.message) || error) }));
  process.exit(1);
});`;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    NODE_ENV: 'production',
    SCK_SERVICE_HOME: home,
    SCK_PRODUCT_ENV: '/dev/null',
    SCK_COMPANY_DB_ENV: '/dev/null',
    SURREAL_URL: 'ws://127.0.0.1:9/rpc',
    SURREAL_ROOT_USER: 'root',
    SURREAL_ROOT_PASS: 'fixture',
  };
  const proc = Bun.spawn([process.execPath, '-e', probe], {
    env, cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const line = stdout.split('\n').find(text => text.startsWith('RESULT '));
  if (!line) throw new Error(`子进程没有给出结果（退出码 ${proc.exitCode}）：${stderr.slice(-2000)}`);
  return JSON.parse(line.slice('RESULT '.length)) as Outcome;
}

test('插件公司栈缺 COMPANY_DB_URL：拒绝启动并说明原因，不回落到本机库', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sck-plugin-boot-'));
  try {
    mkdirSync(join(home, 'private'), { recursive: true });
    writeFileSync(join(home, 'private/service.env'), '');
    const outcome = await startCompanyStack(home);
    expect(outcome.importFailed).toBeUndefined();
    expect(outcome.started).toBe(false);
    expect(outcome.message).toContain('未配置 COMPANY_DB_URL，拒绝启动');
    expect(outcome.message).toContain(join(home, 'private/company-db.env'));
    // 配置检查在节点 ID 之前：拒绝时没有写下本执行端的节点 ID，也就没有开始连库。
    expect(existsSync(join(home, 'private/node-id'))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
