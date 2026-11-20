import { describe, expect, test } from 'bun:test';
import type { Surreal } from 'surrealdb';
import {
  collectVpsObservation, extractCaddyRoutes, parseListenAddresses, parseSystemctlUnits, runVpsLandscapeCheck,
  OBSERVE_INTERVAL_MS, type ExecFn,
} from '../src/landscape-observe.ts';
import { COMPANY_LANDSCAPE } from '../../src/landscape.ts';
import { driftNoticeKey } from '../../src/landscape-report.ts';
import { fakeDb } from './_support.ts';

const NOW = new Date('2026-11-20T12:00:00Z');
const HOST = 'vps-data';

const SYSTEMCTL_OK = `sck-owner-backend.service loaded active running owner backend
sck-owner-minute.service loaded active exited minute jobs
sck-owner-minute.timer loaded active waiting minute timer
sck-owner-daily.service loaded active exited daily jobs
sck-owner-daily.timer loaded active waiting daily timer
surreal-ck-hono.service loaded active running ck origin
surrealdb.service loaded active running database
magpie-web.service loaded active running gateway
caddy.service loaded active running proxy
systemd-logind.service loaded active running login
dbus.service loaded active running bus
`;

const CADDY = `# comment
data.maplayer.top {
\treverse_proxy /rpc 127.0.0.1:8000
\thandle /__company_owner/* {
\t\treverse_proxy 127.0.0.1:39125
\t}
}
`;

const execOk: ExecFn = async (command, args) => {
  if (command === 'systemctl') return { code: 0, stdout: SYSTEMCTL_OK, stderr: '' };
  if (command === 'ss') return { code: 0, stdout: 'LISTEN 0 511 127.0.0.1:39125 0.0.0.0:*\nLISTEN 0 511 127.0.0.1:18900 0.0.0.0:*\n', stderr: '' };
  throw new Error(`unexpected exec: ${command} ${args.join(' ')}`);
};

const readFileOk = async (path: string) => {
  if (path === '/etc/caddy/Caddyfile') return CADDY;
  throw new Error(`unexpected read: ${path}`);
};

/** 依次应答的假库：respond 按调用顺序匹配语句。 */
function observeDb(prior: unknown = undefined) {
  const queries: Array<{ sql: string; vars: Record<string, unknown> }> = [];
  const db = {
    async query(sql: string, vars: Record<string, unknown> = {}) {
      queries.push({ sql, vars });
      if (sql === 'SELECT * FROM $record;') {
        if (String(vars.record).includes('landscape_observed')) return [prior ? [prior] : []];
        return [[]];
      }
      return [[]];
    },
    async close() {},
  };
  return { db: db as unknown as Surreal, queries };
}

describe('采集解析', () => {
  test('systemctl 取第一列单元名，ss 取本地地址列', () => {
    expect(parseSystemctlUnits(SYSTEMCTL_OK)).toContain('sck-owner-backend.service');
    expect(parseSystemctlUnits('  \n')).toEqual([]);
    expect(parseListenAddresses('LISTEN 0 511 127.0.0.1:39125 0.0.0.0:*\n')).toEqual(['127.0.0.1:39125']);
  });

  test('Caddyfile 摘站点地址行与 handle/reverse_proxy 行，最多 100 行', () => {
    expect(extractCaddyRoutes(CADDY)).toEqual([
      'data.maplayer.top {',
      'reverse_proxy /rpc 127.0.0.1:8000',
      'handle /__company_owner/* {',
      'reverse_proxy 127.0.0.1:39125',
    ]);
    const huge = Array.from({ length: 300 }, (_, i) => `site${i}.example.com {`).join('\n');
    expect(extractCaddyRoutes(huge)).toHaveLength(100);
  });
});

describe('collectVpsObservation', () => {
  test('三项采集成功：units/listen/caddyRoutes 都有值，errors 为空', async () => {
    const obs = await collectVpsObservation({ exec: execOk, readFile: readFileOk, now: NOW });
    expect(obs).toMatchObject({ host: HOST, at: NOW.toISOString(), source: 'owner-cron', errors: [] });
    expect(obs.units).toContain('sck-owner-backend.service');
    expect(obs.listen).toEqual(['127.0.0.1:39125', '127.0.0.1:18900']);
    expect(obs.caddyRoutes?.[0]).toBe('data.maplayer.top {');
  });

  test('部分失败：失败的项记 null 并写一条不超过 200 字的脱敏原因，其余项不受影响', async () => {
    const fail: ExecFn = async (command) => {
      if (command === 'systemctl') throw new Error('spawn failed: token=abc-secret');
      if (command === 'ss') return { code: 3, stdout: '', stderr: 'raw stderr must not leak' };
      throw new Error('x');
    };
    const obs = await collectVpsObservation({ exec: fail, readFile: readFileOk, now: NOW });
    expect(obs.units).toBeNull();
    expect(obs.listen).toBeNull();
    expect(obs.caddyRoutes).not.toBeNull();
    expect(obs.errors).toHaveLength(2);
    for (const error of obs.errors) {
      expect(error.length).toBeLessThanOrEqual(200);
      expect(error).not.toContain('raw stderr must not leak');
    }
    expect(obs.errors[0]).toContain('systemctl');
    expect(obs.errors[1]).toContain('ss');
  });
});

describe('runVpsLandscapeCheck 门控与落库', () => {
  test('距上次观测不足 60 分钟跳过，不采集也不写库', async () => {
    const prior = { host: HOST, at: new Date(NOW.getTime() - 30 * 60_000).toISOString() };
    const { db, queries } = observeDb(prior);
    let execed = false;
    const result = await runVpsLandscapeCheck(db, {
      exec: async () => { execed = true; return { code: 0, stdout: '', stderr: '' }; },
      readFile: readFileOk, now: NOW,
    });
    expect(result).toEqual({ skipped: 'recent', host: HOST, at: prior.at });
    expect(execed).toBe(false);
    expect(queries).toHaveLength(1);
  });

  test('超过 60 分钟：采集、比对一致落 company_meta，并关闭可能存在的漂移提示', async () => {
    const { db, queries } = observeDb();
    const result = await runVpsLandscapeCheck(db, { exec: execOk, readFile: readFileOk, now: NOW });
    expect(result).toMatchObject({ host: HOST });
    const upsert = queries.find(q => q.sql.includes('UPSERT') && String(q.vars.record).includes('landscape_observed'));
    expect(upsert).toBeTruthy();
    const content = upsert!.vars.content as { host: string; drift: { undeclared: string[]; missing: string[] } };
    expect(content.host).toBe(HOST);
    expect(content.drift).toBeTruthy();
    // 登记全在且观测里只有基线单元时一致：只写观测并 resolve 提示，不 raise。
    const resolve = queries.find(q => q.sql.startsWith('UPDATE $record SET resolved_at'));
    expect(resolve).toBeTruthy();
    expect(String(resolve!.vars.record)).toContain('owner_notice');
    expect(queries.some(q => q.sql.includes('UPSERT $record CONTENT { key: $key'))).toBe(false);
  });

  test('观测到未登记单元：raise 漂移提示，key 为 landscape-drift:<host>', async () => {
    const rogue: ExecFn = async (command) => {
      if (command === 'systemctl') return { code: 0, stdout: `${SYSTEMCTL_OK}rogue.service loaded active running rogue\n`, stderr: '' };
      if (command === 'ss') return { code: 0, stdout: '', stderr: '' };
      throw new Error('x');
    };
    const { db, queries } = observeDb();
    const result = await runVpsLandscapeCheck(db, { exec: rogue, readFile: readFileOk, now: NOW }) as { drift: { undeclared: string[] } };
    expect(result.drift.undeclared).toEqual(['rogue.service']);
    const raise = queries.find(q => q.sql.includes('UPSERT $record CONTENT { key: $key'));
    expect(raise).toBeTruthy();
    expect(raise!.vars.key).toBe(driftNoticeKey(HOST));
    expect(String(raise!.vars.text)).toContain(`公司服务全景与实机不一致（${HOST}）`);
    expect(String(raise!.vars.text)).toContain('rogue.service');
  });

  test('登记表本身声明的 vps-data 单元全集对得上 deploy 配置', () => {
    expect(COMPANY_LANDSCAPE.services.some(s => s.host === HOST && s.unit === 'sck-owner-backend.service')).toBe(true);
    expect(OBSERVE_INTERVAL_MS).toBe(3_600_000);
  });
});
