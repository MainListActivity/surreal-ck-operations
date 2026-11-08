import { describe, expect, test } from 'bun:test';
import { SignJWT } from 'jose';

import { CompanyError } from '../../src/core-errors.ts';
import { authenticate, callerOf, type Caller } from '../src/auth/caller.ts';
import { verifyAccessToken, type VerifiedToken } from '../src/auth/jwt.ts';
import { ISSUER, keyFixture, signToken, testConfig, type KeyFixture } from './_support.ts';

const cfg = testConfig();
const now = () => Math.floor(Date.now() / 1000);

/** 直接签发声明（不经 signToken 的默认值），用于构造缺字段的令牌。 */
async function rawToken(
  key: KeyFixture,
  payload: Record<string, unknown>,
  options: { exp?: number; issuer?: string; audience?: string } = {},
): Promise<string> {
  let jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? 'company')
    .setIssuedAt();
  if (options.exp !== undefined) jwt = jwt.setExpirationTime(options.exp);
  return jwt.sign(key.privateKey);
}

/** 捕获 Promise 的 CompanyError；若不是 CompanyError 则让断言失败。 */
async function errorOf(promise: Promise<unknown>): Promise<CompanyError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CompanyError) return error;
    throw error;
  }
  throw new Error('expected a CompanyError but the promise resolved');
}

function verifiedOf(overrides: Partial<VerifiedToken> = {}): VerifiedToken {
  return { token: 'tok', sub: 'owner-user', ac: 'owner', roles: ['Owner'], exp: now() + 900, ...overrides };
}

function requestWith(authorization?: string): Request {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  return new Request('https://company.test.invalid/api/me', { headers });
}

describe('访问令牌验签（verifyAccessToken）', () => {
  test('老板令牌通过验签，返回 sub、ac、roles、exp，没有任务与调用方', async () => {
    const key = await keyFixture();
    const token = await signToken(key);
    const verified = await verifyAccessToken(token, cfg, key.keys);
    expect(verified.sub).toBe('owner-user');
    expect(verified.ac).toBe('owner');
    expect(verified.roles).toEqual(['Owner']);
    expect(typeof verified.exp).toBe('number');
    expect(verified.task).toBeUndefined();
    expect(verified.actClient).toBeUndefined();
    expect(verified.token).toBe(token);
  });

  test('员工令牌带出任务与调用方客户端（act.sub）', async () => {
    const key = await keyFixture();
    const token = await signToken(key, { ac: 'agent', task: 't-1', act: { sub: 'company-runner' } });
    const verified = await verifyAccessToken(token, cfg, key.keys);
    expect(verified.ac).toBe('agent');
    expect(verified.task).toBe('t-1');
    expect(verified.actClient).toBe('company-runner');
  });

  test('签发者不符 → unauthorized', async () => {
    const key = await keyFixture();
    const token = await signToken(key, {}, { issuer: 'https://evil.test.invalid/t/company' });
    expect((await errorOf(verifyAccessToken(token, cfg, key.keys))).code).toBe('unauthorized');
  });

  test('受众不符 → unauthorized', async () => {
    const key = await keyFixture();
    const token = await signToken(key, {}, { audience: 'other-audience' });
    expect((await errorOf(verifyAccessToken(token, cfg, key.keys))).code).toBe('unauthorized');
  });

  test('已过期（绝对时间在过去）→ unauthorized', async () => {
    const key = await keyFixture();
    const token = await signToken(key, {}, { expiresIn: now() - 600 });
    expect((await errorOf(verifyAccessToken(token, cfg, key.keys))).code).toBe('unauthorized');
  });

  test('由另一把密钥签名 → unauthorized', async () => {
    const trusted = await keyFixture('kid-a');
    const attacker = await keyFixture('kid-a');
    const token = await signToken(attacker);
    expect((await errorOf(verifyAccessToken(token, cfg, trusted.keys))).code).toBe('unauthorized');
  });

  test('HS256 签名的令牌被拒绝（只接受非对称算法）', async () => {
    const key = await keyFixture();
    const secret = new TextEncoder().encode('hs256-shared-secret-for-test-only-0123456789');
    const token = await new SignJWT({ sub: 'owner-user', ac: 'owner', rl: ['Owner'], ns: 'company', db: 'main' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience('company')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(secret);
    expect((await errorOf(verifyAccessToken(token, cfg, key.keys))).code).toBe('unauthorized');
  });

  test('ns 与配置不符 → forbidden', async () => {
    const key = await keyFixture();
    const token = await signToken(key, { ns: 'other-company' });
    expect((await errorOf(verifyAccessToken(token, cfg, key.keys))).code).toBe('forbidden');
  });

  test('db 与配置不符 → forbidden', async () => {
    const key = await keyFixture();
    const token = await signToken(key, { db: 'other-db' });
    expect((await errorOf(verifyAccessToken(token, cfg, key.keys))).code).toBe('forbidden');
  });

  test('缺少 ac 声明 → unauthorized', async () => {
    const key = await keyFixture();
    const token = await rawToken(key, { sub: 'owner-user', rl: ['Owner'], ns: 'company', db: 'main' }, { exp: now() + 900 });
    expect((await errorOf(verifyAccessToken(token, cfg, key.keys))).code).toBe('unauthorized');
  });

  test('缺少 sub 声明 → unauthorized', async () => {
    const key = await keyFixture();
    const token = await rawToken(key, { ac: 'owner', rl: ['Owner'], ns: 'company', db: 'main' }, { exp: now() + 900 });
    expect((await errorOf(verifyAccessToken(token, cfg, key.keys))).code).toBe('unauthorized');
  });

  test('缺少 exp 声明 → unauthorized', async () => {
    const key = await keyFixture();
    const token = await rawToken(key, { sub: 'owner-user', ac: 'owner', rl: ['Owner'], ns: 'company', db: 'main' });
    expect((await errorOf(verifyAccessToken(token, cfg, key.keys))).code).toBe('unauthorized');
  });

  test('错误信息不包含令牌内容', async () => {
    const key = await keyFixture();
    const bad = await signToken(key, {}, { audience: 'other-audience' });
    const expired = await signToken(key, {}, { expiresIn: now() - 600 });
    const mismatch = await signToken(key, { ns: 'other-company' });
    for (const token of [bad, expired, mismatch, 'not-a-jwt']) {
      const error = await errorOf(verifyAccessToken(token, cfg, key.keys));
      expect(error.message).not.toContain(token);
    }
  });
});

describe('身份归类（callerOf）', () => {
  test('ac=owner 且 rl 含 Owner → owner', () => {
    const caller = callerOf(verifiedOf());
    expect(caller.kind).toBe('owner');
    expect(caller.sub).toBe('owner-user');
  });

  test('ac=owner 但 rl 不含 Owner → forbidden', () => {
    expect(() => callerOf(verifiedOf({ roles: ['Viewer'] }))).toThrow(CompanyError);
    expect(() => callerOf(verifiedOf({ roles: [] }))).toThrow(CompanyError);
  });

  test('ac=agent 且任务合法 → agent，携带 task', () => {
    const caller = callerOf(verifiedOf({ ac: 'agent', roles: [], task: 't-1' }));
    expect(caller.kind).toBe('agent');
    if (caller.kind !== 'agent') throw new Error('kind');
    expect(caller.task).toBe('t-1');
  });

  test.each([
    ['缺少任务', undefined],
    ['任务含斜杠', 'a/b'],
    ['任务含空格', 'a b'],
    ['任务 129 个字符', 'x'.repeat(129)],
  ])('ac=agent 且%s → forbidden', (_name, task) => {
    try {
      callerOf(verifiedOf({ ac: 'agent', roles: [], task }));
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as CompanyError).code).toBe('forbidden');
    }
  });

  test('任务 128 个字符是合法上限', () => {
    const caller = callerOf(verifiedOf({ ac: 'agent', roles: [], task: 'x'.repeat(128) }));
    expect(caller.kind).toBe('agent');
  });

  test.each(['gateway', 'runner', 'automation', 'migrator', 'viewer'])(
    'ac=%s → system，携带 ac',
    (ac) => {
      const caller = callerOf(verifiedOf({ ac, roles: [] }));
      expect(caller.kind).toBe('system');
      if (caller.kind !== 'system') throw new Error('kind');
      expect(caller.ac).toBe(ac);
    },
  );

  test('未知的 ac（root）→ forbidden', () => {
    try {
      callerOf(verifiedOf({ ac: 'root', roles: ['Owner'] }));
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as CompanyError).code).toBe('forbidden');
    }
  });
});

describe('请求身份识别（authenticate）', () => {
  test('没有 Authorization 头 → unauthorized，提示请先登录', async () => {
    const key = await keyFixture();
    const error = await errorOf(authenticate(requestWith(), cfg, key.keys));
    expect(error.code).toBe('unauthorized');
    expect(error.message).toBe('请先登录');
  });

  test.each([
    ['Basic xyz'],
    ['Bearer'],
    ['Bearer a b'],
  ])('认证头 %p 格式不正确 → unauthorized', async (header) => {
    const key = await keyFixture();
    const error = await errorOf(authenticate(requestWith(header), cfg, key.keys));
    expect(error.code).toBe('unauthorized');
  });

  test('小写 bearer 前缀被接受', async () => {
    const key = await keyFixture();
    const token = await signToken(key);
    const caller = await authenticate(requestWith(`bearer ${token}`), cfg, key.keys);
    expect(caller.kind).toBe('owner');
  });

  test('有效老板令牌 → owner 身份', async () => {
    const key = await keyFixture();
    const token = await signToken(key);
    const caller: Caller = await authenticate(requestWith(`Bearer ${token}`), cfg, key.keys);
    expect(caller.kind).toBe('owner');
    expect(caller.sub).toBe('owner-user');
  });

  test('有效但签名不符的令牌 → unauthorized', async () => {
    const trusted = await keyFixture('kid-a');
    const attacker = await keyFixture('kid-a');
    const token = await signToken(attacker);
    const error = await errorOf(authenticate(requestWith(`Bearer ${token}`), cfg, trusted.keys));
    expect(error.code).toBe('unauthorized');
  });
});

describe('身份矩阵（令牌声明组合 → 身份或错误）', () => {
  type Expect = { kind: Caller['kind'] } | { error: CompanyError['code'] };

  const cases: Array<{ name: string; claims: Record<string, unknown>; expect: Expect }> = [
    { name: '老板 Owner', claims: { ac: 'owner', rl: ['Owner'] }, expect: { kind: 'owner' } },
    { name: '老板 rl 为字符串 Owner', claims: { ac: 'owner', rl: 'Owner' }, expect: { kind: 'owner' } },
    { name: '老板缺 Owner 角色', claims: { ac: 'owner', rl: ['Viewer'] }, expect: { error: 'forbidden' } },
    { name: '老板缺 rl', claims: { ac: 'owner', rl: undefined }, expect: { error: 'forbidden' } },
    { name: '员工带任务', claims: { ac: 'agent', rl: [], task: 't-9' }, expect: { kind: 'agent' } },
    { name: '员工缺任务', claims: { ac: 'agent', rl: [] }, expect: { error: 'forbidden' } },
    { name: '员工任务含斜杠', claims: { ac: 'agent', rl: [], task: 'a/b' }, expect: { error: 'forbidden' } },
    { name: '网关系统身份', claims: { ac: 'gateway', rl: [] }, expect: { kind: 'system' } },
    { name: '执行器系统身份', claims: { ac: 'runner', rl: [] }, expect: { kind: 'system' } },
    { name: '自动化系统身份', claims: { ac: 'automation', rl: [] }, expect: { kind: 'system' } },
    { name: '迁移系统身份', claims: { ac: 'migrator', rl: [] }, expect: { kind: 'system' } },
    { name: '只读系统身份', claims: { ac: 'viewer', rl: [] }, expect: { kind: 'system' } },
    { name: '未知访问方式', claims: { ac: 'root', rl: ['Owner'] }, expect: { error: 'forbidden' } },
    { name: '缺 ac', claims: { ac: undefined }, expect: { error: 'unauthorized' } },
    { name: 'sub 为数字', claims: { sub: 123 }, expect: { error: 'unauthorized' } },
    { name: 'ns 不符', claims: { ns: 'other' }, expect: { error: 'forbidden' } },
    { name: 'db 不符', claims: { db: 'other' }, expect: { error: 'forbidden' } },
  ];

  test.each(cases)('$name', async ({ claims, expect: expected }) => {
    const key = await keyFixture();
    const token = await signToken(key, claims);
    const outcome = await authenticate(requestWith(`Bearer ${token}`), cfg, key.keys).then(
      (caller) => ({ caller }),
      (error: unknown) => ({ error }),
    );
    if ('kind' in expected) {
      if ('error' in outcome) throw outcome.error;
      expect(outcome.caller.kind).toBe(expected.kind);
    } else {
      expect(outcome).toHaveProperty('error');
      expect((outcome as { error: CompanyError }).error.code).toBe(expected.error);
    }
  });
});
