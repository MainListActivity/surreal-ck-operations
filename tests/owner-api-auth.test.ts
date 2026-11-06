import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnerApiFetch } from '../plugin/server/owner-api.ts';

const home = mkdtempSync(join(tmpdir(), 'owner-api-auth-'));
// The token only ever exists as a file path; the test never prints it.
const tokenPath = join(home, 'private/owner-token');
const ownerFetch = createOwnerApiFetch({
  home,
  company: async () => { throw new Error('authenticated company must not be reached without a valid token'); },
});
const url = 'http://127.0.0.1:18777/api/owner/goal.list';
const post = (headers: Record<string, string> = {}) => ownerFetch(new Request(url, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}',
}));

test('the owner token file is created 0600 and read only by path', () => {
  const mode = statSync(tokenPath).mode & 0o777;
  expect(mode).toBe(0o600);
  expect(readFileSync(tokenPath, 'utf8').length).toBeGreaterThan(0);
});

test('a request without the owner token is refused 401', async () => {
  const response = await post();
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ error: 'owner token required' });
});

test('a request with the wrong owner token is refused 401', async () => {
  const response = await post({ authorization: 'Bearer sck_wrong' });
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ error: 'invalid owner token' });
});

test('a request with a same-length wrong owner token is refused 401', async () => {
  const tokenLen = readFileSync(tokenPath, 'utf8').trim().length;
  const sameLenWrong = '0'.repeat(tokenLen);
  const response = await post({ authorization: `Bearer ${sameLenWrong}` });
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ error: 'invalid owner token' });
});

test('the console page route still exchanges a page token for the owner token', async () => {
  // /o/<token>/ stays a page route; the exchange endpoint returns the same token the CLI reads by path.
  const { createConsoleFetch } = await import('../plugin/server/console.ts');
  const pageFetch = createConsoleFetch({ home, lanBase: () => 'http://127.0.0.1:18777',
    company: async () => { throw new Error('no company in auth test'); } });
  const pageToken = readFileSync(join(home, 'private', 'console-token'), 'utf8').trim();
  const response = await pageFetch(new Request(`http://127.0.0.1:18777/o/${pageToken}/api/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageToken }),
  }));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ ownerToken: readFileSync(tokenPath, 'utf8').trim() });
});

test('a wrong page token cannot exchange for the owner token', async () => {
  const { createConsoleFetch } = await import('../plugin/server/console.ts');
  const pageFetch = createConsoleFetch({ home, lanBase: () => 'http://127.0.0.1:18777',
    company: async () => { throw new Error('no company in auth test'); } });
  const pageToken = readFileSync(join(home, 'private', 'console-token'), 'utf8').trim();
  const response = await pageFetch(new Request(`http://127.0.0.1:18777/o/${pageToken}/api/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageToken: 'wrong' }),
  }));
  expect(response.status).toBe(401);
});

test('the prefixed console owner route demands the owner Bearer token', async () => {
  // The signature face has no /api/owner/* route, so the page writes through /o/<token>/owner/<cmd>.
  const { createConsoleFetch } = await import('../plugin/server/console.ts');
  const pageFetch = createConsoleFetch({ home, lanBase: () => 'http://127.0.0.1:18777',
    company: async () => { throw new Error('a company must not be reached before the token is checked'); } });
  const pageToken = readFileSync(join(home, 'private', 'console-token'), 'utf8').trim();
  const url = `http://127.0.0.1:18777/o/${pageToken}/owner/goal.list`;
  const refused = await pageFetch(new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"command":"goal.list"}',
  }));
  expect(refused.status).toBe(401);
  await expect(refused.json()).resolves.toMatchObject({ error: 'owner token required' });
  const wrong = await pageFetch(new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sck_wrong' }, body: '{"command":"goal.list"}',
  }));
  expect(wrong.status).toBe(401);
  // With the real token the request reaches the owner handler; the throwing company proves that step was entered.
  const ownerToken = readFileSync(tokenPath, 'utf8').trim();
  const accepted = await pageFetch(new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` }, body: '{"command":"goal.list"}',
  }));
  expect(accepted.status).toBe(500);
  await expect(accepted.json()).resolves.toMatchObject({ error: 'a company must not be reached before the token is checked' });
});

test('the console page writes through owner/ and its script parses', async () => {
  const { createConsoleFetch } = await import('../plugin/server/console.ts');
  const pageFetch = createConsoleFetch({ home, lanBase: () => 'http://127.0.0.1:18777',
    company: async () => { throw new Error('no company for the page HTML'); } });
  const pageToken = readFileSync(join(home, 'private', 'console-token'), 'utf8').trim();
  const response = await pageFetch(new Request(`http://127.0.0.1:18777/o/${pageToken}/`));
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("fetch('owner/'+cmd");
  expect(html).not.toContain('/api/owner/');
  // The inline page script is delivered as-is; a syntax error would leave the owner console dead.
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  expect(script).toBeTruthy();
  expect(() => new Function(script!)).not.toThrow();
});
