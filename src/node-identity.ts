import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 节点 ID 文件的标准 UUID v4 格式（第 13 位为 4，第 17 位为 8-b）。 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 节点 ID 文件位置：<home>/private/node-id。 */
export function nodeIdPath(home: string): string {
  return join(home, 'private', 'node-id');
}

function readValidNodeId(path: string): string {
  const value = readFileSync(path, 'utf8').trim();
  if (!UUID_V4.test(value)) throw new Error(`节点 ID 文件无效：${path}，请人工检查，不要自动重置`);
  return value;
}

/**
 * 读取本机节点 ID；文件不存在时生成一个 UUID v4 并以独占方式写入（权限 0600，private 目录 0700）。
 * 文件存在但格式不对时直接抛错，不自动重置：重置会让节点的租约归属与节点记录失去对应。
 */
export function ensureNodeId(home: string): string {
  const path = nodeIdPath(home);
  try {
    return readValidNodeId(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const id = randomUUID();
  try {
    writeFileSync(path, `${id}\n`, { flag: 'wx', mode: 0o600 });
    return id;
  } catch (error) {
    // 另一个进程抢先写入：以它写入的值为准，同样校验格式。
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readValidNodeId(path);
    throw error;
  }
}
