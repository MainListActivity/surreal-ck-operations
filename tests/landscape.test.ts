import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  baselineMatch, COMPANY_LANDSCAPE, compareObservation, declaredUnits, hostOfService, parseLandscape, servicesForProject,
  type HostObservation, type Landscape,
} from '../src/landscape.ts';

const ROOT = join(import.meta.dir, '..');

const FIXTURE: Landscape = {
  version: 1,
  updatedAt: '2026-01-01',
  rules: [],
  hosts: [
    { id: 'vps', kind: 'vps', baselineUnits: ['systemd-*', 'dbus*', 'cron.service'] },
    { id: 'mac', kind: 'mac', baselineUnits: [] },
  ],
  repos: [
    { id: 'ops', github: 'org/ops', project: 'proj-a', purpose: '运维', status: 'active' },
    { id: 'app', github: 'org/app', purpose: '应用', status: 'unknown' },
  ],
  services: [
    { id: 'svc-a', repo: 'ops', host: 'vps', kind: 'systemd', unit: 'a.service', deploy: 'd', rollback: 'r', status: 'active', verified: true },
    { id: 'timer-b', repo: 'ops', host: 'vps', kind: 'timer', unit: 'b.timer', deploy: 'd', rollback: 'r', status: 'active', verified: true },
    { id: 'svc-dead', repo: 'ops', host: 'vps', kind: 'systemd', unit: 'dead.service', deploy: 'd', rollback: 'r', status: 'retire', verified: true },
    { id: 'plug', repo: 'ops', host: 'mac', kind: 'paseo-plugin', unit: 'sck-company', deploy: 'd', rollback: 'r', status: 'review', verified: true },
    { id: 'edge', repo: 'ops', host: 'vps', kind: 'worker', unit: 'edge-worker', deploy: 'd', rollback: 'r', status: 'active', verified: false },
  ],
};

const obs = (units: string[] | null, over: Partial<HostObservation> = {}): HostObservation =>
  ({ host: 'vps', at: '2026-01-02T00:00:00Z', source: 'owner-cron', units, listen: null, caddyRoutes: null, errors: [], ...over });

describe('登记表解析', () => {
  test('landscape/company-landscape.json 通过校验', () => {
    const raw = JSON.parse(readFileSync(join(ROOT, 'landscape', 'company-landscape.json'), 'utf8'));
    expect(() => parseLandscape(raw)).not.toThrow();
    expect(COMPANY_LANDSCAPE.services.length).toBeGreaterThan(0);
  });

  test('结构不合法时抛 invalid：枚举、缺字段、id 重复、引用不存在、repo.project 重复', () => {
    const base = JSON.parse(readFileSync(join(ROOT, 'landscape', 'company-landscape.json'), 'utf8'));
    const bad = (mutate: (raw: Record<string, unknown>) => void) => {
      const raw = JSON.parse(JSON.stringify(base));
      mutate(raw);
      expect(() => parseLandscape(raw)).toThrowError(expect.objectContaining({ code: 'invalid' }));
    };
    bad(raw => { (raw.services as Array<Record<string, unknown>>)[0]!.kind = 'bogus'; });
    bad(raw => { (raw.services as Array<Record<string, unknown>>)[0]!.repo = 'ghost'; });
    bad(raw => { (raw.services as Array<Record<string, unknown>>)[0]!.host = 'ghost'; });
    bad(raw => { (raw.hosts as Array<Record<string, unknown>>)[1]!.id = 'vps-data'; });
    bad(raw => { (raw.repos as Array<Record<string, unknown>>)[1]!.project = 'sck_company'; });
    bad(raw => { delete (raw.services as Array<Record<string, unknown>>)[0]!.deploy; });
  });
});

describe('防新增门禁：实机配置必须已登记', () => {
  test('owner-end/deploy 的每个 .service / .timer 单元都已登记（timer 隐含的 service 算登记）', () => {
    const declared = declaredUnits(COMPANY_LANDSCAPE, 'vps-data');
    const files = readdirSync(join(ROOT, 'owner-end', 'deploy')).filter(name => /\.(service|timer)$/.test(name));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect({ file, declared: declared.has(file) }).toEqual({ file, declared: true });
    }
  });

  test('owner-end/wrangler.jsonc 的 Worker name 已登记为 worker', () => {
    const wrangler = readFileSync(join(ROOT, 'owner-end', 'wrangler.jsonc'), 'utf8');
    const name = /"name"\s*:\s*"([^"]+)"/.exec(wrangler)?.[1];
    expect(name).toBeTruthy();
    const service = COMPANY_LANDSCAPE.services.find(item => item.kind === 'worker' && item.unit === name);
    expect(service).toBeTruthy();
    expect(service!.host).toBe('cloudflare');
  });
});

describe('compareObservation 实机比对', () => {
  test('一致：观测到的都是已登记或基线单元，应存在的都在', () => {
    const drift = compareObservation(FIXTURE, obs(['a.service', 'b.timer', 'b.service', 'systemd-logind.service', 'dbus.service', 'cron.service']));
    expect(drift).toEqual({ host: 'vps', unknown: false, undeclared: [], missing: [], retireStillPresent: [] });
  });

  test('未登记：实机出现、不在登记表也不匹配主机基线的单元进 undeclared', () => {
    const drift = compareObservation(FIXTURE, obs(['a.service', 'b.timer', 'b.service', 'mystery.service', 'rogue.timer']));
    expect(drift.undeclared).toEqual(['mystery.service', 'rogue.timer']);
    expect(drift.missing).toEqual([]);
    expect(drift.retireStillPresent).toEqual([]);
  });

  test('登记但缺失：active/review 的单元没观测到进 missing（timer 连隐含 service）', () => {
    const drift = compareObservation(FIXTURE, obs(['b.timer']));
    expect(drift.missing).toEqual(['a.service', 'b.service']);
    expect(drift.undeclared).toEqual([]);
  });

  test('应退役仍在：retire/stale 的单元仍观测到进 retireStillPresent', () => {
    const drift = compareObservation(FIXTURE, obs(['a.service', 'b.timer', 'b.service', 'dead.service']));
    expect(drift.retireStillPresent).toEqual(['dead.service']);
  });

  test('unknown：units 为 null 时只标 unknown，三个列表为空', () => {
    const drift = compareObservation(FIXTURE, obs(null, { errors: ['systemctl 采集失败：x'] }));
    expect(drift.unknown).toBe(true);
    expect(drift.undeclared).toEqual([]);
    expect(drift.missing).toEqual([]);
    expect(drift.retireStillPresent).toEqual([]);
  });

  test('不同 host 只比对自己主机：mac 的登记不影响 vps 的判定', () => {
    const drift = compareObservation(FIXTURE, obs(['a.service', 'b.timer', 'b.service'], { host: 'mac', source: 'plugin' }));
    expect(drift.missing).toEqual(['sck-company']);
    expect(drift.undeclared).toEqual(['a.service', 'b.service', 'b.timer']);
  });
});

describe('通配与查询辅助', () => {
  test('baselineMatch 只支持 * 通配，其余字面匹配', () => {
    expect(baselineMatch(['systemd-*'], 'systemd-logind.service')).toBe(true);
    expect(baselineMatch(['dbus*'], 'dbus.service')).toBe(true);
    expect(baselineMatch(['cron.service'], 'cron.service')).toBe(true);
    expect(baselineMatch(['systemd-*'], 'x-systemd-foo')).toBe(false);
    expect(baselineMatch(['a.c'], 'a.c')).toBe(true);
    expect(baselineMatch(['a.c'], 'axc')).toBe(false);
    expect(baselineMatch([], 'anything')).toBe(false);
  });

  test('servicesForProject 经 repo.project 关联；无关联返回空', () => {
    const services = servicesForProject(FIXTURE, 'proj-a');
    expect(services.map(item => item.id).sort()).toEqual(['edge', 'plug', 'svc-a', 'svc-dead', 'timer-b']);
    expect(servicesForProject(FIXTURE, 'proj-none')).toEqual([]);
    const allowed = new Set(['id', 'host', 'kind', 'unit', 'listen', 'route', 'deploy', 'rollback', 'status']);
    for (const item of services) {
      expect(Object.keys(item)).toEqual(expect.arrayContaining(['id', 'host', 'kind', 'unit', 'deploy', 'rollback', 'status']));
      for (const key of Object.keys(item)) expect(allowed.has(key)).toBe(true);
    }
  });

  test('hostOfService 返回登记主机；未登记为 undefined', () => {
    expect(hostOfService(FIXTURE, 'svc-a')).toBe('vps');
    expect(hostOfService(FIXTURE, 'ghost')).toBeUndefined();
    expect(hostOfService(COMPANY_LANDSCAPE, 'sck-owner-backend')).toBe('vps-data');
  });
});
