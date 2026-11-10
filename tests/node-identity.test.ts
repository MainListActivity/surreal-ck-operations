import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureNodeId, nodeIdPath } from '../src/node-identity.ts';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sck-node-id-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('node identity file', () => {
  test('the file lives at <home>/private/node-id', () => {
    expect(nodeIdPath(home)).toBe(join(home, 'private', 'node-id'));
  });

  test('the first call creates a UUID v4 and writes it with mode 0600', () => {
    const id = ensureNodeId(home);
    expect(id).toMatch(UUID_V4);
    expect(readFileSync(nodeIdPath(home), 'utf8').trim()).toBe(id);
    const mode = statSync(nodeIdPath(home)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('the private directory is created when missing', () => {
    expect(ensureNodeId(home)).toMatch(UUID_V4);
    expect(statSync(join(home, 'private')).isDirectory()).toBe(true);
  });

  test('a second call reads back the same identity', () => {
    const first = ensureNodeId(home);
    expect(ensureNodeId(home)).toBe(first);
    expect(ensureNodeId(home)).toBe(first);
  });

  test('a file in an invalid format throws and is not reset', () => {
    mkdirSync(join(home, 'private'), { recursive: true });
    writeFileSync(nodeIdPath(home), 'not-a-uuid\n');
    expect(() => ensureNodeId(home)).toThrow(`节点 ID 文件无效：${nodeIdPath(home)}，请人工检查，不要自动重置`);
    expect(readFileSync(nodeIdPath(home), 'utf8')).toBe('not-a-uuid\n');
  });

  test('a UUID that is not version 4 is refused', () => {
    mkdirSync(join(home, 'private'), { recursive: true });
    writeFileSync(nodeIdPath(home), '123e4567-e89b-12d3-a456-426614174000\n');
    expect(() => ensureNodeId(home)).toThrow('节点 ID 文件无效');
  });
});
