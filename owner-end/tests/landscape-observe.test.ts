import { describe, expect, test } from 'bun:test';
import type { Surreal } from 'surrealdb';
import {
  collectVpsObservation, extractCaddyAdminRoutes, parseListenAddresses, parseSystemctlUnits, runVpsLandscapeCheck,
  OBSERVE_INTERVAL_MS, type ExecFn,
} from '../src/landscape-observe.ts';
import { COMPANY_LANDSCAPE } from '../../src/landscape.ts';
import { driftNoticeKey } from '../../src/landscape-report.ts';

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
tikv-20160.service loaded active running tikv
pd-2379.service loaded active running pd
prometheus-9090.service loaded active running prometheus
grafana-3000.service loaded active running grafana
node_exporter-9100.service loaded active running node_exporter
blackbox_exporter-9115.service loaded active running blackbox
shadowsocks-rust.service loaded active running shadowsocks
podman.service loaded active running podman
podman-restart.service loaded active exited podman restart
podman-auto-update.timer loaded active waiting podman update timer
podman-auto-update.service loaded active exited podman update
systemd-logind.service loaded active running login
dbus.service loaded active running bus
`;

/** 与生产 /config/apps/http/servers 同形的最小配置：一个站点，/rpc 反代，/__company_owner/* 在 subroute 里。 */
const CADDY_ADMIN = {
  srv0: {
    listen: [':443'],
    routes: [
      {
        match: [{ host: ['data.maplayer.top'] }],
        handle: [
          {
            handler: 'subroute',
            routes: [
              {
                match: [{ path: ['/rpc'] }],
                handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:8000' }] }],
              },
              {
                match: [{ path: ['/sck-mcp', '/sck-mcp/*'] }],
                handle: [{ handler: 'static_response', status_code: 404 }],
              },
            ],
          },
        ],
      },
      {
        match: [{ host: ['data.maplayer.top'] }, { path: ['/__company_owner/*'] }],
        handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:39125' }] }],
      },
    ],
  },
};

const execOk: ExecFn = async (command) => {
  if (command === 'systemctl') return { code: 0, stdout: SYSTEMCTL_OK, stderr: '' };
  if (command === 'ss') return { code: 0, stdout: 'LISTEN 0 511 127.0.0.1:39125 0.0.0.0:*\nLISTEN 0 511 127.0.0.1:18900 0.0.0.0:*\n', stderr: '' };
  throw new Error(`unexpected exec: ${command}`);
};

const fetchOk = (async () => new Response(JSON.stringify(CADDY_ADMIN), { status: 200 })) as unknown as typeof fetch;

/** 依次应答的假库：SELECT $record 只在观测记录时返回 prior。 */
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
  test('systemctl 取第一列单元名（not-found 跳过），ss 取本地地址列', () => {
    expect(parseSystemctlUnits(SYSTEMCTL_OK)).toContain('sck-owner-backend.service');
    expect(parseSystemctlUnits('ghost.service not-found inactive dead ghost\n')).toEqual([]);
    expect(parseSystemctlUnits('  \n')).toEqual([]);
    expect(parseListenAddresses('LISTEN 0 511 127.0.0.1:39125 0.0.0.0:*\n')).toEqual(['127.0.0.1:39125']);
  });

  test('extractCaddyAdminRoutes：站点的 host/path 与反代目标成行，subroute 嵌套继承外层匹配', () => {
    const routes = extractCaddyAdminRoutes(CADDY_ADMIN);
    expect(routes).toContain('data.maplayer.top /rpc -> 127.0.0.1:8000');
    expect(routes).toContain('data.maplayer.top /sck-mcp,/sck-mcp/* -> static_response');
    expect(routes).toContain('data.maplayer.top /__company_owner/* -> 127.0.0.1:39125');
  });

  test('extractCaddyAdminRoutes：畸形输入返回空数组，不抛错；路由数封顶 100 行', () => {
    for (const bad of [null, 42, 'x', [], { srv: 'not-a-server' }, { srv: { listen: 443 } }]) {
      expect(extractCaddyAdminRoutes(bad)).toEqual([]);
    }
    const huge = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`srv${i}`, {
      listen: [':443'],
      routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${i}` }] }] }],
    }]));
    expect(extractCaddyAdminRoutes(huge)).toHaveLength(100);
  });
});

describe('collectVpsObservation', () => {
  test('三项采集成功：units/listen/caddyRoutes 都有值，errors 为空', async () => {
    const obs = await collectVpsObservation({ exec: execOk, fetch: fetchOk, now: NOW });
    expect(obs).toMatchObject({ host: HOST, at: NOW.toISOString(), source: 'owner-cron', errors: [] });
    expect(obs.units).toContain('sck-owner-backend.service');
    expect(obs.listen).toEqual(['127.0.0.1:39125', '127.0.0.1:18900']);
    expect(obs.caddyRoutes).toContain('data.maplayer.top /rpc -> 127.0.0.1:8000');
  });

  test('部分失败：失败的项记 null 并写一条不超过 200 字的脱敏原因，其余项不受影响', async () => {
    const fail: ExecFn = async (command) => {
      if (command === 'systemctl') throw new Error('spawn failed: token=abc-secret');
      if (command === 'ss') return { code: 3, stdout: '', stderr: 'raw stderr must not leak' };
      throw new Error('x');
    };
    const obs = await collectVpsObservation({ exec: fail, fetch: fetchOk, now: NOW });
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

  test('管理接口非 2xx 与网络失败：caddyRoutes 记 null 并记一条脱敏原因', async () => {
    const http500 = (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch;
    const offline = (async () => { throw new Error('connect ECONNREFUSED token=abc'); }) as unknown as typeof fetch;
    for (const failing of [http500, offline]) {
      const obs = await collectVpsObservation({ exec: execOk, fetch: failing, now: NOW });
      expect(obs.units).not.toBeNull();
      expect(obs.caddyRoutes).toBeNull();
      expect(obs.errors).toHaveLength(1);
      expect(obs.errors[0]!.length).toBeLessThanOrEqual(200);
      expect(obs.errors[0]).toContain('Caddy');
    }
    const obs = await collectVpsObservation({ exec: execOk, fetch: http500, now: NOW });
    expect(obs.errors[0]).toContain('HTTP 500');
  });
});

describe('runVpsLandscapeCheck 门控与落库', () => {
  test('距上次观测不足 60 分钟跳过，不采集也不写库', async () => {
    const prior = { host: HOST, at: new Date(NOW.getTime() - 30 * 60_000).toISOString() };
    const { db, queries } = observeDb(prior);
    let execed = false;
    const result = await runVpsLandscapeCheck(db, {
      exec: async () => { execed = true; return { code: 0, stdout: '', stderr: '' }; },
      fetch: fetchOk, now: NOW,
    });
    expect(result).toEqual({ skipped: 'recent', host: HOST, at: prior.at });
    expect(execed).toBe(false);
    expect(queries).toHaveLength(1);
  });

  test('超过 60 分钟：采集、比对一致落 company_meta，并关闭可能存在的漂移提示', async () => {
    const { db, queries } = observeDb();
    const result = await runVpsLandscapeCheck(db, { exec: execOk, fetch: fetchOk, now: NOW });
    expect(result).toMatchObject({ host: HOST });
    const upsert = queries.find(q => q.sql.includes('UPSERT') && String(q.vars.record).includes('landscape_observed'));
    expect(upsert).toBeTruthy();
    const content = upsert!.vars.content as { host: string; caddyRoutes: string[]; drift: { undeclared: string[]; missing: string[] } };
    expect(content.host).toBe(HOST);
    expect(content.caddyRoutes?.[0]).toContain('data.maplayer.top');
    expect(content.drift).toBeTruthy();
    const resolve = queries.find(q => q.sql.startsWith('UPDATE $record SET resolved_at'));
    expect(resolve).toBeTruthy();
    expect(queries.some(q => q.sql.includes('UPSERT $record CONTENT { key: $key'))).toBe(false);
  });

  test('观测到未登记单元：raise 漂移提示，key 为 landscape-drift:<host>', async () => {
    const rogue: ExecFn = async (command) => {
      if (command === 'systemctl') return { code: 0, stdout: `${SYSTEMCTL_OK}rogue.service loaded active running rogue\n`, stderr: '' };
      if (command === 'ss') return { code: 0, stdout: '', stderr: '' };
      throw new Error('x');
    };
    const { db, queries } = observeDb();
    const result = await runVpsLandscapeCheck(db, { exec: rogue, fetch: fetchOk, now: NOW }) as { drift: { undeclared: string[] } };
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
