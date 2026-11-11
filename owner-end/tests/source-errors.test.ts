import { expect, test } from 'bun:test';
import { NotAllowedError } from 'surrealdb';
import { isAuthFailure, isSessionExpired } from '../src/ui/source.ts';

// 形状取自生产库的真实回复：{"code":-32000,"kind":"NotAllowed","details":{"kind":"Auth","details":{"kind":"SessionExpired"}}}
const notAllowed = (kind: string) =>
  new (NotAllowedError as unknown as new (r: unknown) => Error)({
    code: -32000, kind: 'NotAllowed', message: 'x', details: { kind: 'Auth', details: { kind } },
  });

test('会话过期可识别且不算登录失效；令牌过期与无效凭证才回登录页；权限类文字不误判', () => {
  expect(isSessionExpired(notAllowed('SessionExpired'))).toBe(true);
  expect(isAuthFailure(notAllowed('SessionExpired'))).toBe(false);
  expect(isAuthFailure(notAllowed('TokenExpired'))).toBe(true);
  expect(isAuthFailure(notAllowed('InvalidAuth'))).toBe(true);
  expect(isAuthFailure(new Error('permission denied: token expired'))).toBe(false);
  expect(isSessionExpired(new Error('The session has expired'))).toBe(false);
});
