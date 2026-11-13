import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** install.sh 用临时 HOME/PASEO_HOME/SCK_SERVICE_HOME 跑一遍，断言写进 config.json 的 provider 条目。 */
function setup(opts: { muse?: boolean; config?: unknown } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'sck-install-home-'));
  const service = join(home, 'service');
  const paseoHome = join(home, '.paseo');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  mkdirSync(paseoHome, { recursive: true });
  for (const name of ['claude', 'droid', 'agy', 'grok', 'devin', ...(opts.muse ? ['muse'] : [])]) {
    const bin = join(home, '.local', 'bin', name);
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);
  }
  writeFileSync(join(paseoHome, 'config.json'), JSON.stringify(opts.config ?? {
    agents: { providers: {
      'factory-droid': { extends: 'acp', command: ['droid', 'exec', '--output-format', 'acp-daemon'] },
      muse: { enabled: false },
    } },
  }));
  return { home, service, paseoHome };
}

async function install(env: { home: string; service: string; paseoHome: string }) {
  const proc = Bun.spawn(['sh', 'scripts/sandbox/install.sh'], {
    env: { ...process.env, HOME: env.home, SCK_SERVICE_HOME: env.service, PASEO_HOME: env.paseoHome,
      SCK_PASEO_BIN: '/usr/bin/true' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code, config: JSON.parse(readFileSync(join(env.paseoHome, 'config.json'), 'utf8')) };
}

describe('install.sh 员工沙箱安装', () => {
  test('写入 grok / factory-paseo provider，未装 muse 时跳过', async () => {
    const env = setup();
    try {
      const { code, config, err } = await install(env);
      expect(code).toBe(0);
      const providers = config.agents.providers;
      const bindir = join(env.service, 'sandbox', 'bin');
      expect(providers.grok.command).toEqual([join(bindir, 'grok'), 'agent', '--always-approve', 'stdio']);
      expect(providers.grok.extends).toBe('acp');
      const paseo = providers['factory-paseo'];
      expect(paseo.extends).toBe('acp');
      expect(paseo.command).toEqual([join(bindir, 'droid'), 'exec', '--output-format', 'acp-daemon']);
      expect(paseo.env.DROID_DISABLE_AUTO_UPDATE).toBe('true');
      expect(paseo.params.supportsMcpServers).toBe(false);
      expect(providers['devin-paseo']).toMatchObject({ extends: 'acp', command: [join(bindir, 'devin'), 'acp'], enabled: true });
      expect(providers.muse.enabled).toBe(false);
      expect(err).toContain('skip muse');
    } finally { rmSync(env.home, { recursive: true, force: true }); }
  });

  test('装了 muse：包装脚本进 command 且 enabled', async () => {
    const env = setup({ muse: true });
    try {
      const { code, config } = await install(env);
      expect(code).toBe(0);
      const muse = config.agents.providers.muse;
      expect(muse.enabled).toBe(true);
      expect(muse.command[0]).toBe(join(env.service, 'sandbox', 'bin', 'muse'));
    } finally { rmSync(env.home, { recursive: true, force: true }); }
  });

  test('已存在的 grok command 尾参漂移时被纠正为无人值守 argv', async () => {
    const env = setup({ config: { agents: { providers: { grok: { command: ['/old/path/grok', 'agent', 'stdio'] } } } } });
    try {
      const { code, config } = await install(env);
      expect(code).toBe(0);
      expect(config.agents.providers.grok.command)
        .toEqual([join(env.service, 'sandbox', 'bin', 'grok'), 'agent', '--always-approve', 'stdio']);
    } finally { rmSync(env.home, { recursive: true, force: true }); }
  });
});
